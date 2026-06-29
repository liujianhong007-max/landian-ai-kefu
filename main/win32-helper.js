'use strict';

const { execFile } = require('node:child_process');
const os = require('node:os');

const WORKBENCH_CLASS = '{E77EAED1-21E4-4F21-AE4C-50A6AE1E47A4}';
const LOGIN_CLASS = '{87A92FEF-A61E-4401-B06E-34BE711F231E}';

let nativeLoaded = false;
let nativeError = null;
let koffi = null;

try {
  require('win32-api');
  require('win32-def');
  koffi = require('koffi');
  nativeLoaded = true;
} catch (error) {
  nativeError = error;
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      timeout: 10000
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function loadUser32() {
  if (!nativeLoaded || !koffi) return null;

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  return {
    user32,
    kernel32,
    enumWindows: user32.func('bool EnumWindows(void* lpEnumFunc, intptr lParam)'),
    getClassName: user32.func('int GetClassNameW(void* hWnd, void* lpClassName, int nMaxCount)'),
    isWindowVisible: user32.func('bool IsWindowVisible(void* hWnd)'),
    getWindowRect: user32.func('bool GetWindowRect(void* hWnd, void* lpRect)'),
    getWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(void* hWnd, void* lpdwProcessId)'),
    getWindowTextLength: user32.func('int GetWindowTextLengthW(void* hWnd)'),
    getWindowText: user32.func('int GetWindowTextW(void* hWnd, void* lpString, int nMaxCount)')
  };
}

function readWideBuffer(buffer) {
  const zero = buffer.indexOf(Buffer.from([0, 0]));
  const end = zero >= 0 ? zero + (zero % 2) : buffer.length;
  return buffer.subarray(0, end).toString('utf16le').replace(/\0+$/, '');
}

function findWindowsByClassNative(className) {
  const api = loadUser32();
  if (!api) return [];

  const windows = [];
  const callback = koffi.register((hwnd) => {
    const classBuffer = Buffer.alloc(512);
    api.getClassName(hwnd, classBuffer, 256);
    const currentClass = readWideBuffer(classBuffer);
    if (currentClass === className) {
      const pidBuffer = Buffer.alloc(4);
      api.getWindowThreadProcessId(hwnd, pidBuffer);
      const titleLength = api.getWindowTextLength(hwnd);
      const titleBuffer = Buffer.alloc((titleLength + 1) * 2);
      api.getWindowText(hwnd, titleBuffer, titleLength + 1);
      const rectBuffer = Buffer.alloc(16);
      const hasRect = api.getWindowRect(hwnd, rectBuffer);
      const left = hasRect ? rectBuffer.readInt32LE(0) : 0;
      const top = hasRect ? rectBuffer.readInt32LE(4) : 0;
      const right = hasRect ? rectBuffer.readInt32LE(8) : 0;
      const bottom = hasRect ? rectBuffer.readInt32LE(12) : 0;
      windows.push({
        hwnd: String(hwnd),
        className: currentClass,
        pid: pidBuffer.readUInt32LE(0),
        title: readWideBuffer(titleBuffer),
        visible: api.isWindowVisible(hwnd),
        bounds: hasRect ? {
          x: left,
          y: top,
          width: right - left,
          height: bottom - top
        } : null
      });
    }
    return true;
  }, 'bool', ['void*', 'intptr']);

  api.enumWindows(callback, 0);
  koffi.unregister(callback);
  return windows;
}

async function findWindowsByClassFallback(className) {
  const escaped = className.replace(/'/g, "''");
  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@
$items = New-Object System.Collections.ArrayList
[WinEnum]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $class = New-Object System.Text.StringBuilder 256
  [void][WinEnum]::GetClassName($hWnd, $class, $class.Capacity)
  if ($class.ToString() -eq '${escaped}') {
    $pid = 0
    [void][WinEnum]::GetWindowThreadProcessId($hWnd, [ref]$pid)
    $title = New-Object System.Text.StringBuilder 512
    [void][WinEnum]::GetWindowText($hWnd, $title, $title.Capacity)
    $rect = New-Object WinEnum+RECT
    $hasRect = [WinEnum]::GetWindowRect($hWnd, [ref]$rect)
    [void]$items.Add([PSCustomObject]@{
      hwnd = $hWnd.ToInt64().ToString()
      className = $class.ToString()
      pid = $pid
      title = $title.ToString()
      visible = [WinEnum]::IsWindowVisible($hWnd)
      bounds = if ($hasRect) {
        [PSCustomObject]@{
          x = $rect.Left
          y = $rect.Top
          width = $rect.Right - $rect.Left
          height = $rect.Bottom - $rect.Top
        }
      } else { $null }
    })
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
$items | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(script);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function findWindowsByClass(className) {
  if (os.platform() !== 'win32') return [];

  try {
    return findWindowsByClassNative(className);
  } catch {
    return findWindowsByClassFallback(className);
  }
}

function findWindowsByPidNative(pid) {
  const api = loadUser32();
  if (!api) return [];

  const windows = [];
  const callback = koffi.register((hwnd) => {
    const pidBuffer = Buffer.alloc(4);
    api.getWindowThreadProcessId(hwnd, pidBuffer);
    const currentPid = pidBuffer.readUInt32LE(0);
    if (Number(currentPid) !== Number(pid)) return true;

    const classBuffer = Buffer.alloc(512);
    api.getClassName(hwnd, classBuffer, 256);
    const titleLength = api.getWindowTextLength(hwnd);
    const titleBuffer = Buffer.alloc((titleLength + 1) * 2);
    api.getWindowText(hwnd, titleBuffer, titleLength + 1);
    const rectBuffer = Buffer.alloc(16);
    const hasRect = api.getWindowRect(hwnd, rectBuffer);
    const left = hasRect ? rectBuffer.readInt32LE(0) : 0;
    const top = hasRect ? rectBuffer.readInt32LE(4) : 0;
    const right = hasRect ? rectBuffer.readInt32LE(8) : 0;
    const bottom = hasRect ? rectBuffer.readInt32LE(12) : 0;
    windows.push({
      hwnd: String(hwnd),
      className: readWideBuffer(classBuffer),
      pid: currentPid,
      title: readWideBuffer(titleBuffer),
      visible: api.isWindowVisible(hwnd),
      bounds: hasRect ? {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top
      } : null
    });
    return true;
  }, 'bool', ['void*', 'intptr']);

  api.enumWindows(callback, 0);
  koffi.unregister(callback);
  return windows;
}

async function findWindowsByPidFallback(pid) {
  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@
$items = New-Object System.Collections.ArrayList
[WinEnum]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $processId = 0
  [void][WinEnum]::GetWindowThreadProcessId($hWnd, [ref]$processId)
  if ($processId -eq ${Number(pid)}) {
    $class = New-Object System.Text.StringBuilder 256
    [void][WinEnum]::GetClassName($hWnd, $class, $class.Capacity)
    $title = New-Object System.Text.StringBuilder 512
    [void][WinEnum]::GetWindowText($hWnd, $title, $title.Capacity)
    $rect = New-Object WinEnum+RECT
    $hasRect = [WinEnum]::GetWindowRect($hWnd, [ref]$rect)
    [void]$items.Add([PSCustomObject]@{
      hwnd = $hWnd.ToInt64().ToString()
      className = $class.ToString()
      pid = $processId
      title = $title.ToString()
      visible = [WinEnum]::IsWindowVisible($hWnd)
      bounds = if ($hasRect) {
        [PSCustomObject]@{
          x = $rect.Left
          y = $rect.Top
          width = $rect.Right - $rect.Left
          height = $rect.Bottom - $rect.Top
        }
      } else { $null }
    })
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
$items | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(script);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function findWindowsByPid(pid) {
  if (os.platform() !== 'win32' || !Number.isFinite(Number(pid))) return [];

  try {
    return findWindowsByPidNative(pid);
  } catch {
    return findWindowsByPidFallback(pid);
  }
}

async function findPddWorkbenchWindows() {
  return findWindowsByClass(WORKBENCH_CLASS);
}

async function findPddLoginWindows() {
  return findWindowsByClass(LOGIN_CLASS);
}

async function findProcessByName(name) {
  if (os.platform() !== 'win32') return [];

  const escaped = name.replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='${escaped}'" | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  let output;
  try {
    output = await runPowerShell(script);
  } catch {
    const processName = escaped.replace(/\.exe$/i, '');
    const fallbackScript = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Select-Object @{Name='ProcessId';Expression={$_.Id}},@{Name='Name';Expression={$_.ProcessName + '.exe'}},@{Name='ExecutablePath';Expression={$_.Path}},@{Name='CommandLine';Expression={''}} | ConvertTo-Json -Compress`;
    output = await runPowerShell(fallbackScript);
  }
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

module.exports = {
  WORKBENCH_CLASS,
  LOGIN_CLASS,
  nativeLoaded,
  nativeError,
  findWindowsByClass,
  findWindowsByPid,
  findPddWorkbenchWindows,
  findPddLoginWindows,
  findProcessByName
};
