const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const WebSocket = require('ws');
const { HelperClient, PddManager } = require('../main/pdd-manager');

const WORKBENCH_EXE = 'C:\\Users\\26799\\Desktop\\pdd-fuke\\pdd-workbench\\PddWorkbench.exe';
const DEFAULT_DLL = path.join(__dirname, '..', 'assets', 'inject', 'PddExtend-3.5.7.16.dll');

function waitFor(emitter, eventName, timeoutMs = 1000) {
  return Promise.race([
    new Promise((resolve) => emitter.once(eventName, resolve)),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
      timer.unref?.();
    })
  ]);
}

function createMockHelper(invokeFrames) {
  return (_helperPath, args) => {
    const child = new EventEmitter();
    child.pid = 1111;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };

    queueMicrotask(() => {
      const socket = new WebSocket(args.find((arg) => /^wss?:\/\//.test(arg)));
      socket.once('open', () => {
        socket.send(JSON.stringify({
          type: 'event',
          body: {
            name: 'hello',
            param: { platform: 'fuke-helper', version: '1.0.0' }
          }
        }));
      });
      socket.on('message', (buffer) => {
        const frame = JSON.parse(buffer.toString());
        invokeFrames.push(frame);
        const data = frame.body.name === 'launch_platform' ? { pid: 9876 } : { output: '' };
        socket.send(JSON.stringify({
          type: 'response',
          body: { data, id: null, message: '', success: true }
        }));
      });
      child.once('exit', () => socket.close());
    });

    return child;
  };
}

function createConnectingHelper(spawnCalls) {
  return (helperPath, args, options) => {
    spawnCalls.push([helperPath, args, options]);
    const child = new EventEmitter();
    child.pid = 1111;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };

    queueMicrotask(() => {
      const socket = new WebSocket(args.find((arg) => /^wss?:\/\//.test(arg)));
      socket.once('open', () => {
        socket.send(JSON.stringify({
          type: 'event',
          body: {
            name: 'hello',
            param: { platform: 'fuke-helper', version: '1.0.0' }
          }
        }));
      });
      child.once('exit', () => socket.close());
    });

    return child;
  };
}

function createResponsiveHelper(spawnCalls, invokeFrames) {
  return (helperPath, args, options) => {
    spawnCalls.push([helperPath, args, options]);
    const child = new EventEmitter();
    child.pid = 1111;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };

    queueMicrotask(() => {
      const socket = new WebSocket(args.find((arg) => /^wss?:\/\//.test(arg)));
      socket.once('open', () => {
        socket.send(JSON.stringify({
          type: 'event',
          body: {
            name: 'hello',
            param: { platform: 'fuke-helper', version: '1.0.0' }
          }
        }));
      });
      socket.on('message', (buffer) => {
        const frame = JSON.parse(buffer.toString());
        invokeFrames.push(frame);
        socket.send(JSON.stringify({
          type: 'response',
          body: { data: { output: 'ok' }, id: null, message: '', success: true }
        }));
      });
      child.once('exit', () => socket.close());
    });

    return child;
  };
}

function createQueuedHelper(responses) {
  return (_helperPath, args) => {
    const child = new EventEmitter();
    child.pid = 1111;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };

    queueMicrotask(() => {
      const socket = new WebSocket(args.find((arg) => /^wss?:\/\//.test(arg)));
      socket.once('open', () => {
        socket.send(JSON.stringify({
          type: 'event',
          body: {
            name: 'hello',
            param: { platform: 'fuke-helper', version: '1.0.0' }
          }
        }));
      });
      socket.on('message', () => {
        const data = responses.shift();
        socket.send(JSON.stringify({
          type: 'response',
          body: { data, id: null, message: '', success: true }
        }));
      });
      child.once('exit', () => socket.close());
    });

    return child;
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function startWithTimeout(helper, timeoutMs = 250) {
  return Promise.race([
    helper.start(),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for helper start')), timeoutMs);
      timer.unref?.();
    })
  ]);
}

test('helper client passes websocket URL to helper process', async () => {
  const spawnCalls = [];
  const helper = new HelperClient({
    helperPath: 'C:\\tools\\fuke-helper.exe',
    port: 0,
    spawn: createConnectingHelper(spawnCalls)
  });

  try {
    await startWithTimeout(helper);

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0][0], 'C:\\tools\\fuke-helper.exe');
    assert.match(spawnCalls[0][1][0], /^ws:\/\/127\.0\.0\.1:\d+\/Extend$/);
  } finally {
    helper.stop();
  }
});

test('helper client starts JavaScript helpers with the current node executable', async () => {
  const spawnCalls = [];
  const helper = new HelperClient({
    helperPath: 'C:\\tools\\pdd-fuke-helper.js',
    port: 0,
    spawn: createConnectingHelper(spawnCalls)
  });

  try {
    await startWithTimeout(helper);

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0][0], process.execPath);
    assert.equal(spawnCalls[0][1][0], 'C:\\tools\\pdd-fuke-helper.js');
    assert.match(spawnCalls[0][1][1], /^ws:\/\/127\.0\.0\.1:\d+\/Extend$/);
  } finally {
    helper.stop();
  }
});

test('helper client uses configured node executable for JavaScript helpers', async () => {
  const spawnCalls = [];
  const helper = new HelperClient({
    helperPath: 'C:\\tools\\pdd-fuke-helper.js',
    helperNodePath: 'C:\\node\\node.exe',
    port: 0,
    spawn: createConnectingHelper(spawnCalls)
  });

  try {
    await startWithTimeout(helper);

    assert.equal(spawnCalls[0][0], 'C:\\node\\node.exe');
    assert.equal(spawnCalls[0][1][0], 'C:\\tools\\pdd-fuke-helper.js');
  } finally {
    helper.stop();
  }
});

test('helper client uses bundled helper when own helper mode is enabled', () => {
  const original = process.env.PDD_FUKE_USE_OWN_HELPER;
  process.env.PDD_FUKE_USE_OWN_HELPER = '1';

  try {
    const helper = new HelperClient({ port: 0 });

    assert.match(helper.helperPath, /main[\\/]own-helper\.js$/);
    helper.stop();
  } finally {
    if (original === undefined) delete process.env.PDD_FUKE_USE_OWN_HELPER;
    else process.env.PDD_FUKE_USE_OWN_HELPER = original;
  }
});

test('helper client uses C# helper exe when csharp helper mode is enabled', () => {
  const originalOwn = process.env.PDD_FUKE_USE_OWN_HELPER;
  const originalCsharp = process.env.PDD_FUKE_USE_CSHARP_HELPER;
  delete process.env.PDD_FUKE_USE_OWN_HELPER;
  process.env.PDD_FUKE_USE_CSHARP_HELPER = '1';

  try {
    const helper = new HelperClient({ port: 0 });

    assert.match(helper.helperPath, /helper-csharp[\\/]bin[\\/]PddFukeHelper\.exe$/);
    helper.stop();
  } finally {
    if (originalOwn === undefined) delete process.env.PDD_FUKE_USE_OWN_HELPER;
    else process.env.PDD_FUKE_USE_OWN_HELPER = originalOwn;
    if (originalCsharp === undefined) delete process.env.PDD_FUKE_USE_CSHARP_HELPER;
    else process.env.PDD_FUKE_USE_CSHARP_HELPER = originalCsharp;
  }
});

test('helper client prefers bundled C# helper by default when it exists', () => {
  const originalOwn = process.env.PDD_FUKE_USE_OWN_HELPER;
  const originalCsharp = process.env.PDD_FUKE_USE_CSHARP_HELPER;
  const originalHelperExe = process.env.FUKE_HELPER_EXE;
  const originalExistsSync = fs.existsSync;
  delete process.env.PDD_FUKE_USE_OWN_HELPER;
  delete process.env.PDD_FUKE_USE_CSHARP_HELPER;
  delete process.env.FUKE_HELPER_EXE;
  fs.existsSync = (candidate) => /helper-csharp[\\/]bin[\\/]PddFukeHelper\.exe$/i.test(candidate) || originalExistsSync(candidate);

  try {
    const helper = new HelperClient({ port: 0 });

    assert.match(helper.helperPath, /helper-csharp[\\/]bin[\\/]PddFukeHelper\.exe$/);
    helper.stop();
  } finally {
    fs.existsSync = originalExistsSync;
    if (originalOwn === undefined) delete process.env.PDD_FUKE_USE_OWN_HELPER;
    else process.env.PDD_FUKE_USE_OWN_HELPER = originalOwn;
    if (originalCsharp === undefined) delete process.env.PDD_FUKE_USE_CSHARP_HELPER;
    else process.env.PDD_FUKE_USE_CSHARP_HELPER = originalCsharp;
    if (originalHelperExe === undefined) delete process.env.FUKE_HELPER_EXE;
    else process.env.FUKE_HELPER_EXE = originalHelperExe;
  }
});

test('helper client enables elevation mode for C# helper launches', async () => {
  const originalOwn = process.env.PDD_FUKE_USE_OWN_HELPER;
  const originalCsharp = process.env.PDD_FUKE_USE_CSHARP_HELPER;
  delete process.env.PDD_FUKE_USE_OWN_HELPER;
  process.env.PDD_FUKE_USE_CSHARP_HELPER = '1';
  const spawnCalls = [];
  const helper = new HelperClient({
    port: 0,
    spawn: createConnectingHelper(spawnCalls)
  });

  try {
    await startWithTimeout(helper);

    assert.equal(spawnCalls[0][2].env.PDD_FUKE_HELPER_ELEVATE, '1');
  } finally {
    helper.stop();
    if (originalOwn === undefined) delete process.env.PDD_FUKE_USE_OWN_HELPER;
    else process.env.PDD_FUKE_USE_OWN_HELPER = originalOwn;
    if (originalCsharp === undefined) delete process.env.PDD_FUKE_USE_CSHARP_HELPER;
    else process.env.PDD_FUKE_USE_CSHARP_HELPER = originalCsharp;
  }
});

test('helper client can ask C# helper to exit after launch', () => {
  const helper = new HelperClient({
    helperPath: 'C:\\tools\\PddFukeHelper-debug.exe',
    port: 0,
    exitAfterLaunch: true
  });

  try {
    const launch = helper.resolveHelperLaunch('ws://127.0.0.1:1234/Extend');

    assert.equal(launch.env.PDD_FUKE_HELPER_ELEVATE, '1');
    assert.equal(launch.env.PDD_FUKE_HELPER_EXIT_AFTER_LAUNCH, '1');
  } finally {
    helper.stop();
  }
});

test('helper client uses random port when requested port is busy', async () => {
  const busyServer = net.createServer();
  busyServer.listen(0, '127.0.0.1');
  await listen(busyServer);
  const busyPort = busyServer.address().port;
  const spawnCalls = [];
  const helper = new HelperClient({
    port: busyPort,
    spawn: createConnectingHelper(spawnCalls)
  });

  try {
    await startWithTimeout(helper);

    const helperWsUrl = new URL(spawnCalls[0][1][0]);
    assert.notEqual(Number(helperWsUrl.port), busyPort);
    assert.equal(helperWsUrl.pathname, '/Extend');
  } finally {
    helper.stop();
    busyServer.close();
  }
});

test('helper client passes shell commands raw and logs invoke traffic', async () => {
  const spawnCalls = [];
  const invokeFrames = [];
  const logs = [];
  const helper = new HelperClient({
    port: 0,
    spawn: createResponsiveHelper(spawnCalls, invokeFrames),
    logger: {
      log: (...args) => logs.push(args),
      error() {}
    }
  });

  try {
    const response = await helper.executeShell('echo ok');

    assert.deepEqual(response, { output: 'ok' });
    assert.equal(invokeFrames.length, 1);
    assert.deepEqual(invokeFrames[0].body, {
      name: 'execute_shell',
      param: { command: 'echo ok' }
    });
    assert.equal(logs.some((entry) => entry[0] === '[helper:invoke-send]' && entry[1].id === '1'), true);
    assert.equal(logs.some((entry) => entry[0] === '[helper:invoke-response]' && entry[1].body?.id === null), true);
  } finally {
    helper.stop();
  }
});

test('helper client matches helper responses to pending invokes in FIFO order', async () => {
  const helper = new HelperClient({
    port: 0,
    spawn: createQueuedHelper([{ output: 'first' }, { pid: 2222 }]),
    invokeTimeoutMs: 100
  });

  try {
    await startWithTimeout(helper);

    const first = helper.invoke('first_call');
    const second = helper.invoke('second_call');

    assert.deepEqual(await first, { output: 'first' });
    assert.deepEqual(await second, { pid: 2222 });
  } finally {
    helper.stop();
  }
});

test('helper client rejects executeShell when websocket is not open after start', async () => {
  const helper = new HelperClient({ port: 0 });
  helper.start = async () => helper;
  helper.socket = { readyState: WebSocket.CLOSED };

  await assert.rejects(
    () => helper.executeShell('echo ok'),
    /fuke-helper websocket is not connected/
  );
});

test('helper client times out unanswered invokes', async () => {
  const spawnCalls = [];
  const helper = new HelperClient({
    port: 0,
    spawn: createConnectingHelper(spawnCalls),
    invokeTimeoutMs: 20
  });

  try {
    await assert.rejects(
      () => helper.launchPlatform({ exe_path: 'C:\\PddWorkbench.exe' }),
      /timed out after 20ms: launch_platform/
    );
    assert.equal(helper.pending.length, 0);
  } finally {
    helper.stop();
  }
});

test('pdd manager launches through fuke helper after killing existing PDD', async () => {
  const exePath = WORKBENCH_EXE;
  const helperPath = 'D:\\Program Files\\fuke\\assets\\inject\\fuke-helper.exe';
  const originalExistsSync = fs.existsSync;
  const invokeFrames = [];

  fs.existsSync = (candidate) => candidate === exePath || candidate === helperPath || originalExistsSync(candidate);

  try {
    const manager = new PddManager({
      exePath,
      helperPath,
      helperSpawn: createMockHelper(invokeFrames),
      wsPort: 4567,
      jsUrl: 'http://127.0.0.1:3000/pdd-bridge.js',
      dllInjector: {
        injectDll() {
          throw new Error('manual DLL injection should not run when helper launches PDD');
        }
      },
      cdpManager: {
        connected: false,
        async disconnect() {}
      }
    });
    const launched = waitFor(manager, 'launched');
    manager.suppressPddUpdate = async () => null;

    const status = await manager.launch();

    assert.equal((await launched).pid, 9876);
    assert.equal(status.running, true);
    assert.equal(status.pid, 9876);
    assert.equal(invokeFrames.length, 2);
    assert.deepEqual(invokeFrames[0].body, {
      name: 'execute_shell',
      param: { command: 'taskkill /F /IM PddWorkbench.exe' }
    });
    assert.equal(invokeFrames[1].body.name, 'launch_platform');
    assert.deepEqual(invokeFrames[1].body.param, {
      exe_path: exePath,
      inject_dllpath: DEFAULT_DLL,
      use_devtool: 1,
      ws_url: 'ws://127.0.0.1:4567/publicplatform',
      js_url: 'http://127.0.0.1:3000/pdd-bridge.js',
      js_data: '4567'
    });

    manager.stop();
  } finally {
    fs.existsSync = originalExistsSync;
  }
});
