const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createHelperRuntime,
  createSuspendedLauncher,
  buildLaunchEnvironment
} = require('../main/own-helper');

test('buildLaunchEnvironment exposes helper launch data as uppercase environment variables', () => {
  const env = buildLaunchEnvironment({
    js_url: 'http://127.0.0.1:3000/pdd-bridge.js',
    js_data: '4567',
    ws_url: 'ws://127.0.0.1:4567/publicplatform',
    use_devtool: 1
  }, { PATH: 'C:\\Windows' });

  assert.equal(env.PATH, 'C:\\Windows');
  assert.equal(env.JS_URL, 'http://127.0.0.1:3000/pdd-bridge.js');
  assert.equal(env.JS_DATA, '4567');
  assert.equal(env.WS_URL, 'ws://127.0.0.1:4567/publicplatform');
  assert.equal(env.USE_DEVTOOL, '1');
});

test('suspended launcher injects DLL before resuming the platform process', async () => {
  const calls = [];
  const launcher = createSuspendedLauncher({
    createSuspendedProcess: (options) => {
      calls.push(['createSuspendedProcess', options.exePath, options.args, options.env.JS_DATA]);
      return { pid: 4321, processHandle: 'process-handle', threadHandle: 'thread-handle' };
    },
    injectDll: (pid, dllPath) => {
      calls.push(['injectDll', pid, dllPath]);
      return { pid, dllPath };
    },
    resumeThread: (threadHandle) => {
      calls.push(['resumeThread', threadHandle]);
      return 1;
    },
    closeHandle: (handle) => {
      calls.push(['closeHandle', handle]);
    }
  });

  const result = await launcher.launchPlatform({
    exe_path: 'C:\\PddWorkbench.exe',
    exe_param: '--disable-web-security',
    inject_dllpath: 'D:\\PddExtend.dll',
    js_data: '4567'
  });

  assert.deepEqual(result, { pid: 4321 });
  assert.deepEqual(calls, [
    ['createSuspendedProcess', 'C:\\PddWorkbench.exe', '--disable-web-security', '4567'],
    ['injectDll', 4321, 'D:\\PddExtend.dll'],
    ['resumeThread', 'thread-handle'],
    ['closeHandle', 'thread-handle'],
    ['closeHandle', 'process-handle']
  ]);
});

test('suspended launcher terminates a suspended process when DLL injection fails', async () => {
  const calls = [];
  const launcher = createSuspendedLauncher({
    createSuspendedProcess: () => ({ pid: 4321, processHandle: 'process-handle', threadHandle: 'thread-handle' }),
    injectDll: () => {
      calls.push(['injectDll']);
      throw new Error('inject failed');
    },
    terminateProcess: (processHandle) => {
      calls.push(['terminateProcess', processHandle]);
    },
    closeHandle: (handle) => {
      calls.push(['closeHandle', handle]);
    }
  });

  await assert.rejects(
    () => launcher.launchPlatform({
      exe_path: 'C:\\PddWorkbench.exe',
      inject_dllpath: 'D:\\PddExtend.dll'
    }),
    /inject failed/
  );

  assert.deepEqual(calls, [
    ['injectDll'],
    ['terminateProcess', 'process-handle'],
    ['closeHandle', 'thread-handle'],
    ['closeHandle', 'process-handle']
  ]);
});

test('helper runtime replies to launch_platform invokes with launcher result', async () => {
  const sent = [];
  const socket = new EventEmitter();
  socket.send = (payload) => sent.push(JSON.parse(payload));

  const runtime = createHelperRuntime({
    socket,
    launcher: {
      launchPlatform: async (param) => ({ pid: param.pid })
    },
    executeShell: async () => ({ output: '' })
  });

  runtime.start();
  socket.emit('open');
  socket.emit('message', JSON.stringify({
    type: 'invoke',
    id: 'launch-1',
    body: {
      name: 'launch_platform',
      param: { pid: 1234 }
    }
  }));

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sent[0], {
    type: 'event',
    body: {
      name: 'hello',
      param: {
        platform: 'fuke-helper',
        version: 'pdd-fuke-helper'
      }
    }
  });
  assert.deepEqual(sent[1], {
    type: 'response',
    id: 'launch-1',
    body: {
      data: { pid: 1234 },
      message: '',
      success: true
    }
  });
});
