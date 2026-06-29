const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const HELPER_EXE = process.env.FUKE_HELPER_EXE || 'D:\\Program Files\\fuke\\assets\\inject\\fuke-helper.exe';
const HELPER_URL = 'ws://127.0.0.1:5555/Extend';
const WORKBENCH_EXE = 'C:\\Users\\26799\\Desktop\\pdd-fuke\\pdd-workbench\\PddWorkbench.exe';
const DEFAULT_DLL = 'D:\\Program Files\\fuke\\assets\\inject\\PddExtend-3.5.7.16.dll';

function invoke(id, name, param = {}) {
  return {
    type: 'invoke',
    id: String(id),
    body: { name, param }
  };
}

function launchPlatform(id, options) {
  return invoke(id, 'launch_platform', {
    exe_path: options.exePath,
    exe_param: options.exeParam || '',
    user_power: options.userPower ? 1 : 0,
    inject_dllpath: options.injectDllPath || '',
    use_devtool: options.useDevtool ? 1 : 0,
    ws_url: options.wsUrl || '',
    js_url: options.jsUrl || '',
    js_data: options.jsData || ''
  });
}

function parseHelperFrame(raw) {
  const frame = typeof raw === 'string' ? JSON.parse(raw) : raw;
  assert.equal(typeof frame, 'object');
  assert.equal(typeof frame.type, 'string');
  assert.equal(typeof frame.body, 'object');
  return frame;
}

function isHelloEvent(frame) {
  return frame.type === 'event'
    && frame.body?.name === 'hello'
    && frame.body.param?.platform === 'fuke-helper';
}

function waitFor(emitter, eventName, timeoutMs = 5000) {
  return Promise.race([
    new Promise((resolve) => emitter.once(eventName, resolve)),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
      timer.unref?.();
    })
  ]);
}

test('formats helper RPC invoke frames with top-level id and body param', () => {
  assert.deepEqual(invoke(7, 'execute_shell', { command: 'cmd /c echo ok' }), {
    type: 'invoke',
    id: '7',
    body: {
      name: 'execute_shell',
      param: { command: 'cmd /c echo ok' }
    }
  });
});

test('formats launch_platform with the helper field names found in fuke-helper.exe', () => {
  assert.deepEqual(launchPlatform('launch-1', {
    exePath: WORKBENCH_EXE,
    exeParam: '--remote-debugging-port=19999 --disable-web-security',
    userPower: false,
    injectDllPath: DEFAULT_DLL,
    useDevtool: true,
    wsUrl: 'ws://127.0.0.1:4567/publicplatform',
    jsUrl: 'http://127.0.0.1:3000/pdd-bridge.js',
    jsData: '4567'
  }), {
    type: 'invoke',
    id: 'launch-1',
    body: {
      name: 'launch_platform',
      param: {
        exe_path: WORKBENCH_EXE,
        exe_param: '--remote-debugging-port=19999 --disable-web-security',
        user_power: 0,
        inject_dllpath: DEFAULT_DLL,
        use_devtool: 1,
        ws_url: 'ws://127.0.0.1:4567/publicplatform',
        js_url: 'http://127.0.0.1:3000/pdd-bridge.js',
        js_data: '4567'
      }
    }
  });
});

test('recognizes the helper hello event shape', () => {
  const frame = parseHelperFrame({
    type: 'event',
    body: {
      name: 'hello',
      param: {
        platform: 'fuke-helper',
        version: '1.0.0',
        data: {}
      }
    }
  });

  assert.equal(isHelloEvent(frame), true);
});

test('live helper protocol probe', { skip: process.env.FUKE_HELPER_LIVE !== '1' }, async () => {
  const { WebSocketServer } = WebSocket;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 5555, path: '/Extend' });
  await waitFor(server, 'listening');
  const child = spawn(HELPER_EXE, [HELPER_URL], { windowsHide: true, stdio: 'ignore' });
  const messages = [];

  try {
    const socket = await waitFor(server, 'connection', 10000);
    socket.on('message', (buffer) => messages.push(parseHelperFrame(buffer.toString())));

    const firstMessage = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for helper hello')), 10000);
      timer.unref?.();
      socket.once('message', (buffer) => {
        clearTimeout(timer);
        resolve(parseHelperFrame(buffer.toString()));
      });
    });

    assert.equal(isHelloEvent(firstMessage), true);

    socket.send(JSON.stringify(invoke('shell-1', 'execute_shell', { command: 'cmd /c echo fuke-helper-probe' })));
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for helper response')), 10000);
      timer.unref?.();
      socket.on('message', (buffer) => {
        const frame = parseHelperFrame(buffer.toString());
        if (frame.type === 'response' && frame.id === 'shell-1') {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });

    assert.equal(response.body.success, true);
    assert.match(String(response.body.data?.output || response.body.output || ''), /fuke-helper-probe/);
    assert.equal(messages.length >= 1, true);
  } finally {
    child.kill();
    server.close();
  }
});

module.exports = {
  HELPER_URL,
  invoke,
  launchPlatform,
  parseHelperFrame,
  isHelloEvent
};
