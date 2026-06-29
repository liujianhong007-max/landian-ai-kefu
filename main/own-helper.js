'use strict';

const { exec } = require('node:child_process');
const path = require('node:path');
const { WebSocket } = require('ws');
const koffi = require('koffi');
const dllInjector = require('./dll-injector');

const CREATE_SUSPENDED = 0x00000004;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const STARTUPINFO_SIZE_X64 = 104;
const PROCESS_INFORMATION_SIZE_X64 = 24;
const WAIT_INFINITE = 0xFFFFFFFF;

function buildLaunchEnvironment(param = {}, baseEnv = process.env) {
  return {
    ...baseEnv,
    JS_URL: String(param.js_url || ''),
    JS_DATA: String(param.js_data || ''),
    WS_URL: String(param.ws_url || ''),
    USE_DEVTOOL: String(param.use_devtool ? 1 : 0)
  };
}

function quoteWindowsArg(value) {
  const text = String(value || '');
  if (!text) return '""';
  if (!/[\s"]/g.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildCommandLine(exePath, args = '') {
  return [quoteWindowsArg(exePath), String(args || '').trim()].filter(Boolean).join(' ');
}

function buildEnvironmentBlock(env) {
  const entries = Object.entries(env)
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return Buffer.from(`${entries.join('\0')}\0\0`, 'utf16le');
}

function loadNativeApi() {
  const kernel32 = koffi.load('kernel32.dll');
  return {
    CreateProcessW: kernel32.func('bool CreateProcessW(str16 lpApplicationName, void* lpCommandLine, void* lpProcessAttributes, void* lpThreadAttributes, bool bInheritHandles, uint32 dwCreationFlags, void* lpEnvironment, str16 lpCurrentDirectory, void* lpStartupInfo, void* lpProcessInformation)'),
    ResumeThread: kernel32.func('uint32 ResumeThread(void* hThread)'),
    TerminateProcess: kernel32.func('bool TerminateProcess(void* hProcess, uint32 uExitCode)'),
    CloseHandle: kernel32.func('bool CloseHandle(void* hObject)'),
    GetLastError: kernel32.func('uint32 GetLastError()')
  };
}

function readPointer(buffer, offset) {
  if (process.arch === 'x64' || process.arch === 'arm64') {
    return Number(buffer.readBigUInt64LE(offset));
  }
  return buffer.readUInt32LE(offset);
}

function createNativeSuspendedProcess(options, api = loadNativeApi()) {
  const exePath = options.exePath;
  const commandLine = Buffer.from(`${buildCommandLine(exePath, options.args)}\0`, 'utf16le');
  const envBlock = buildEnvironmentBlock(options.env || process.env);
  const startupInfo = Buffer.alloc(STARTUPINFO_SIZE_X64);
  const processInfo = Buffer.alloc(PROCESS_INFORMATION_SIZE_X64);
  const cwd = options.cwd || path.dirname(exePath);

  startupInfo.writeUInt32LE(STARTUPINFO_SIZE_X64, 0);

  const ok = api.CreateProcessW(
    exePath,
    commandLine,
    null,
    null,
    false,
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
    envBlock,
    cwd,
    startupInfo,
    processInfo
  );
  if (!ok) {
    const lastError = typeof api.GetLastError === 'function' ? api.GetLastError() : 0;
    throw new Error(`CreateProcessW failed${lastError ? `: ${lastError}` : ''}`);
  }

  return {
    processHandle: readPointer(processInfo, 0),
    threadHandle: readPointer(processInfo, 8),
    pid: processInfo.readUInt32LE(16),
    threadId: processInfo.readUInt32LE(20)
  };
}

function createSuspendedLauncher(options = {}) {
  const createSuspendedProcess = options.createSuspendedProcess || ((launchOptions) => createNativeSuspendedProcess(launchOptions, options.api));
  const injectDll = options.injectDll || dllInjector.injectDll;
  const resumeThread = options.resumeThread || ((threadHandle) => {
    const api = options.api || loadNativeApi();
    return api.ResumeThread(threadHandle);
  });
  const terminateProcess = options.terminateProcess || ((processHandle) => {
    const api = options.api || loadNativeApi();
    return api.TerminateProcess(processHandle, 1);
  });
  const closeHandle = options.closeHandle || ((handle) => {
    const api = options.api || loadNativeApi();
    return api.CloseHandle(handle);
  });

  async function launchPlatform(param = {}) {
    if (!param.exe_path) throw new Error('exe_path is required');
    if (!param.inject_dllpath) throw new Error('inject_dllpath is required');

    const created = createSuspendedProcess({
      exePath: param.exe_path,
      args: param.exe_param || '',
      env: buildLaunchEnvironment(param),
      cwd: param.cwd || path.dirname(param.exe_path)
    });
    let resumed = false;

    try {
      injectDll(created.pid, param.inject_dllpath);
      resumeThread(created.threadHandle);
      resumed = true;
      return { pid: created.pid };
    } catch (error) {
      if (!resumed) terminateProcess(created.processHandle);
      throw error;
    } finally {
      if (created.threadHandle) closeHandle(created.threadHandle);
      if (created.processHandle) closeHandle(created.processHandle);
    }
  }

  return { launchPlatform };
}

function executeShell(command) {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ output: stdout, stderr });
    });
  });
}

function createHelperRuntime(options) {
  const socket = options.socket;
  const launcher = options.launcher || createSuspendedLauncher();
  const runShell = options.executeShell || executeShell;

  function send(frame) {
    socket.send(JSON.stringify(frame));
  }

  async function handleInvoke(frame) {
    const id = frame.id;
    const name = frame.body?.name;
    const param = frame.body?.param || {};

    try {
      let data;
      if (name === 'execute_shell') {
        data = await runShell(param.command || '');
      } else if (name === 'launch_platform') {
        data = await launcher.launchPlatform(param);
      } else {
        throw new Error(`Unsupported helper invoke: ${name}`);
      }

      send({ type: 'response', id, body: { data, message: '', success: true } });
    } catch (error) {
      send({ type: 'response', id, body: { data: null, message: error.message, success: false } });
    }
  }

  function handleMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch (error) {
      send({ type: 'error', body: { message: error.message } });
      return;
    }

    if (frame.type === 'invoke') {
      handleInvoke(frame);
    }
  }

  function start() {
    socket.on('open', () => {
      send({
        type: 'event',
        body: {
          name: 'hello',
          param: {
            platform: 'fuke-helper',
            version: 'pdd-fuke-helper'
          }
        }
      });
    });
    socket.on('message', handleMessage);
    return socket;
  }

  return { start, handleMessage };
}

function runCli(argv = process.argv) {
  const wsUrl = argv[2];
  if (!wsUrl) {
    console.error('Usage: node main/own-helper.js ws://127.0.0.1:5555/Extend');
    process.exitCode = 2;
    return null;
  }

  const socket = new WebSocket(wsUrl);
  socket.on('error', (error) => {
    console.error('[own-helper:ws-error]', error);
  });
  return createHelperRuntime({ socket }).start();
}

if (require.main === module) {
  runCli();
}

module.exports = {
  CREATE_SUSPENDED,
  CREATE_UNICODE_ENVIRONMENT,
  buildCommandLine,
  buildEnvironmentBlock,
  buildLaunchEnvironment,
  createHelperRuntime,
  createNativeSuspendedProcess,
  createSuspendedLauncher,
  executeShell,
  runCli
};
