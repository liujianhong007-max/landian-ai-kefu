const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const HELPER_EXE = path.join(ROOT, 'helper-csharp', 'bin', 'PddFukeHelper.exe');
const TEST_HELPER_EXE = path.join(ROOT, 'helper-csharp', 'tmp', 'PddFukeHelper-test.exe');
const BUILD_SCRIPT = path.join(ROOT, 'helper-csharp', 'build.ps1');
const HELPER_SOURCE = path.join(ROOT, 'helper-csharp', 'src', 'Program.cs');

function waitFor(emitter, eventName, timeoutMs = 5000) {
  return Promise.race([
    new Promise((resolve) => emitter.once(eventName, resolve)),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
      timer.unref?.();
    })
  ]);
}

function runPowerShell(scriptPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(TEST_HELPER_EXE), { recursive: true });
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: ROOT,
      env: { ...process.env, PDD_FUKE_HELPER_BUILD_OUT: TEST_HELPER_EXE },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`build failed ${code}\n${stdout}\n${stderr}`));
    });
  });
}

test('C# helper command line quoting does not double Windows path separators', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.doesNotMatch(source, /Replace\("\\\\",\s*"\\\\\\\\/);
});

test('C# helper preserves fuke-style trailing command line space for empty exe_param', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.match(source, /BuildCommandLine\(string exePath,\s*string exeParam\)/);
  assert.match(source, /builder\.Append\(' '\)/);
  assert.match(source, /if \(!String\.IsNullOrWhiteSpace\(exeParam\)\) builder\.Append\(exeParam\)/);
});

test('C# helper has opt-in self elevation for elevated platform launches', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.match(source, /PDD_FUKE_HELPER_ELEVATE/);
  assert.match(source, /Verb\s*=\s*"runas"/);
});

test('C# helper preserves exit-after-launch across self elevation', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.match(source, /PDD_FUKE_HELPER_EXIT_AFTER_LAUNCH/);
  assert.match(source, /ExitAfterLaunchArg/);
  assert.match(source, /AppendExitAfterLaunchArg/);
});

test('C# helper honors user_power with active user token process creation', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.match(source, /Truthy\(param,\s*"user_power"\)/);
  assert.match(source, /CreateProcessWithActiveUserToken/);
  assert.match(source, /OpenProcessToken/);
  assert.match(source, /DuplicateTokenEx/);
  assert.match(source, /CreateProcessWithTokenW/);
});

test('C# helper creates a real user environment for user_power launches', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.match(source, /CreateEnvironmentBlock/);
  assert.match(source, /DestroyEnvironmentBlock/);
  assert.match(source, /ReadEnvironmentBlock/);
  assert.match(source, /OverlayLaunchEnvironment/);
});

test('C# helper writes launch diagnostics for black-box parity checks', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.match(source, /fuke-launch-csharp\.txt/);
  assert.match(source, /LaunchPlatform=>/);
  assert.match(source, /CreateProcessWithActiveUserToken=>/);
  assert.match(source, /InjectDll=>/);
});

test('C# helper supports selectable LoadLibrary injection modes', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.match(source, /PDD_FUKE_INJECT_MODE/);
  assert.match(source, /remote-thread-a/);
  assert.match(source, /remote-thread-w/);
  assert.match(source, /thread-context-w/);
  assert.match(source, /Encoding\.Unicode\.GetBytes\(dllPath \+ "\\0"\)/);
  assert.match(source, /Encoding\.Default\.GetBytes\(dllPath \+ "\\0"\)/);
  assert.match(source, /GetProcAddress\(kernel32,\s*loadLibraryName\)/);
  assert.match(source, /GetExitCodeThread/);
  assert.match(source, /GetThreadContext/);
  assert.match(source, /SetThreadContext/);
  assert.match(source, /BuildThreadContextLoader/);
});

test('C# thread-context loader preserves stack through a nonvolatile register', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.match(source, /0x48,\s*0x89,\s*0xE5\s*\}\);\s*\/\/ mov rbp, rsp/);
  assert.match(source, /0x48,\s*0x89,\s*0xEC\s*\}\);\s*\/\/ mov rsp, rbp/);
  assert.doesNotMatch(source, /\/\/ mov r11, rsp/);
  assert.doesNotMatch(source, /\/\/ mov rsp, r11/);
});

test('C# helper aligns launch privileges and desktop context with fuke helper', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.match(source, /EnableLaunchPrivileges/);
  assert.match(source, /SeAssignPrimaryTokenPrivilege/);
  assert.match(source, /SeImpersonatePrivilege/);
  assert.match(source, /SeIncreaseQuotaPrivilege/);
  assert.match(source, /SeDebugPrivilege/);
  assert.match(source, /AdjustTokenPrivileges/);
  assert.match(source, /startupInfo\.lpDesktop\s*=\s*"winsta0\\\\default"/);
  assert.match(source, /STARTF_USESHOWWINDOW/);
  assert.match(source, /SW_SHOWNORMAL/);
});

test('C# helper validates and cleans remote injection allocation', () => {
  const source = fs.readFileSync(HELPER_SOURCE, 'utf8');
  assert.match(source, /VirtualFreeEx/);
  assert.match(source, /MEM_RELEASE/);
  assert.match(source, /loadLibraryName \+ " returned invalid module handle/);
});

test('C# helper builds and handles hello plus execute_shell over /Extend websocket', async (t) => {
  if (!fs.existsSync(CSC)) {
    t.skip('C# compiler is not available');
    return;
  }

  await runPowerShell(BUILD_SCRIPT);
  assert.equal(fs.existsSync(TEST_HELPER_EXE), true);

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/Extend' });
  await waitFor(server, 'listening');
  const wsUrl = `ws://127.0.0.1:${server.address().port}/Extend`;
  const child = spawn(TEST_HELPER_EXE, [wsUrl], { windowsHide: true });

  try {
    const socket = await waitFor(server, 'connection', 5000);
    const hello = JSON.parse((await waitFor(socket, 'message', 5000)).toString());
    assert.equal(hello.type, 'event');
    assert.equal(hello.body.name, 'hello');
    assert.equal(hello.body.param.platform, 'fuke-helper');

    socket.send(JSON.stringify({
      type: 'invoke',
      id: 'shell-1',
      body: {
        name: 'execute_shell',
        param: { command: 'cmd /c echo csharp-helper-ok' }
      }
    }));

    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for response')), 5000);
      timer.unref?.();
      socket.on('message', (buffer) => {
        const frame = JSON.parse(buffer.toString());
        if (frame.type === 'response') {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });

    assert.equal(response.id, 'shell-1');
    assert.equal(response.body.success, true);
    assert.match(response.body.data.output, /csharp-helper-ok/);

    socket.send(JSON.stringify({
      type: 'invoke',
      id: 'launch-1',
      body: {
        name: 'launch_platform',
        param: {}
      }
    }));

    const launchResponse = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for launch response')), 5000);
      timer.unref?.();
      socket.on('message', (buffer) => {
        const frame = JSON.parse(buffer.toString());
        if (frame.type === 'response' && frame.id === 'launch-1') {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });

    assert.equal(launchResponse.body.success, false);
    assert.match(launchResponse.body.message, /exe_path is required/);
  } finally {
    child.kill();
    server.close();
  }
});
