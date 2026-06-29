const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PddManager, selectLayerSurveyTargets } = require('../main/pdd-manager');

const WORKBENCH_EXE = 'C:\\Users\\26799\\Desktop\\pdd-fuke\\pdd-workbench\\PddWorkbench.exe';
const DEFAULT_DLL = path.join(__dirname, '..', 'assets', 'inject', 'PddExtend-3.5.7.16.dll');

function createHelperClient(calls, options = {}) {
  return {
    async executeShell(command) {
      calls.push(['executeShell', command]);
      if (options.executeShellError) throw options.executeShellError;
      return options.executeShellResult || { output: '' };
    },
    async launchPlatform(param) {
      calls.push(['launchPlatform', param]);
      if (options.launchError) throw options.launchError;
      return options.launchResult || { pid: 4321 };
    },
    stop() {
      calls.push(['helperStop']);
    }
  };
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('pdd manager delegates DLL injection and CDP commands', async () => {
  const calls = [];
  const dllInjector = {
    injectDll(pid, dllPath) {
      calls.push(['injectDll', pid, dllPath]);
      return { pid, dllPath, remoteAddress: 100, threadHandle: 200 };
    }
  };
  const cdpManager = {
    connected: false,
    async connect() {
      calls.push(['connect']);
      this.connected = true;
      return { connected: true };
    },
    async disconnect() {
      calls.push(['disconnect']);
      this.connected = false;
    },
    async execute(method, params) {
      calls.push(['execute', method, params]);
      return { ok: true };
    },
    async getTargets() {
      calls.push(['getTargets']);
      return [{ targetId: 'page-1' }];
    }
  };

  const manager = new PddManager({ dllInjector, cdpManager });

  assert.deepEqual(manager.injectDll(1234, 'C:\\temp\\hook.dll'), {
    pid: 1234,
    dllPath: 'C:\\temp\\hook.dll',
    remoteAddress: 100,
    threadHandle: 200
  });
  assert.deepEqual(await manager.connectCdp(), { connected: true });
  assert.deepEqual(await manager.cdpExecute('Runtime.evaluate', { expression: '1 + 1' }), { ok: true });
  assert.deepEqual(await manager.getCdpTargets(), [{ targetId: 'page-1' }]);
  await manager.disconnectCdp();

  assert.deepEqual(calls, [
    ['injectDll', 1234, 'C:\\temp\\hook.dll'],
    ['connect'],
    ['execute', 'Runtime.evaluate', { expression: '1 + 1' }],
    ['getTargets'],
    ['disconnect']
  ]);
});

test('pdd manager launches through helper and schedules CDP after startup', async () => {
  const exePath = WORKBENCH_EXE;
  const calls = [];
  const originalExistsSync = fs.existsSync;
  const originalSetTimeout = global.setTimeout;
  const originalDllEnv = process.env.PDD_FUKE_DLL;
  fs.existsSync = (candidate) => candidate === exePath || originalExistsSync(candidate);
  global.setTimeout = (_callback, delay) => {
    calls.push(['setTimeout', delay]);
    return { unref() {} };
  };
  delete process.env.PDD_FUKE_DLL;

  const dllInjector = {
    injectDll() {
      throw new Error('manual DLL injection should not run from launch');
    }
  };
  const cdpManager = {
    connected: false,
    async connect() {
      calls.push(['connect']);
      this.connected = true;
      return { connected: true, url: 'ws://127.0.0.1:19999' };
    },
    async disconnect() {
      this.connected = false;
    }
  };

  try {
    const manager = new PddManager({
      exePath,
      dllInjector,
      cdpManager,
      helperClient: createHelperClient(calls),
      wsPort: 4567
    });
    manager.suppressPddUpdate = async () => null;

    const status = await manager.launch();

    assert.deepEqual(calls.map((call) => call[0]), [
      'executeShell',
      'launchPlatform',
      'setTimeout'
    ]);
    assert.equal(status.pid, 4321);
    assert.equal(status.running, true);
  } finally {
    fs.existsSync = originalExistsSync;
    global.setTimeout = originalSetTimeout;
    if (originalDllEnv === undefined) delete process.env.PDD_FUKE_DLL;
    else process.env.PDD_FUKE_DLL = originalDllEnv;
  }
});

test('pdd manager retries delayed CDP availability and injects bridge script after connect', async () => {
  const calls = [];
  const timers = [];
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return { unref() {} };
  };

  const cdpManager = {
    connected: false,
    async connectWithFallback() {
      calls.push(['connectWithFallback']);
      if (calls.filter(([name]) => name === 'connectWithFallback').length < 3) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:19999');
      }
      this.connected = true;
      return { connected: true, url: 'ws://127.0.0.1:19999/devtools/page/chat' };
    },
    async execute(method, params) {
      calls.push([method, params]);
      return { ok: true };
    },
    async disconnect() {}
  };

  try {
    const manager = new PddManager({
      cdpManager,
      wsPort: 4567,
      jsUrl: 'http://127.0.0.1:3000/pdd-bridge.js'
    });
    manager.status.running = true;

    manager.scheduleCdpConnect(5000);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 5000);

    timers.shift().callback();
    await flushAsyncWork();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 2000);

    timers.shift().callback();
    await flushAsyncWork();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 2000);

    timers.shift().callback();
    await flushAsyncWork();

    assert.deepEqual(calls.map((call) => call[0]), [
      'connectWithFallback',
      'connectWithFallback',
      'connectWithFallback',
      'Runtime.evaluate'
    ]);
    assert.match(calls[3][1].expression, /__pdd_fuke_bridge_script__/);
    assert.match(calls[3][1].expression, /__pddFukeBridgeUrl/);
    assert.equal(manager.status.cdpConnected, true);
    assert.equal(manager.status.cdpError, null);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('pdd manager bootstraps CDP through fallback discovery after DLL injection', async () => {
  const calls = [];
  const dllInjector = {
    injectDll(pid, dllPath) {
      calls.push(['injectDll', pid, dllPath]);
      return { pid, dllPath };
    }
  };
  const cdpManager = {
    connected: false,
    async connectWithFallback() {
      calls.push(['connectWithFallback']);
      this.connected = true;
      return { connected: true, url: 'ws://127.0.0.1:45678' };
    },
    async execute(method, params) {
      calls.push(['execute', method, params]);
      return { ok: true };
    }
  };

  const manager = new PddManager({ dllInjector, cdpManager, wsPort: 4567 });
  manager.status.pid = 4321;

  await manager.bootstrapBridge();

  assert.deepEqual(calls.map((call) => call[0]), [
    'injectDll',
    'connectWithFallback',
    'execute',
    'execute'
  ]);
  assert.equal(manager.status.cdpConnected, true);
  assert.equal(manager.status.cdpError, null);
});

test('pdd manager falls back to plain CDP connect when discovery is unavailable', async () => {
  const calls = [];
  const dllInjector = {
    injectDll(pid, dllPath) {
      calls.push(['injectDll', pid, dllPath]);
      return { pid, dllPath };
    }
  };
  const cdpManager = {
    connected: false,
    async connect() {
      calls.push(['connect']);
      this.connected = true;
      return { connected: true, url: 'ws://127.0.0.1:19999' };
    },
    async execute(method, params) {
      calls.push(['execute', method, params]);
      return { ok: true };
    }
  };

  const manager = new PddManager({ dllInjector, cdpManager, wsPort: 4567 });
  manager.status.pid = 4321;

  await manager.bootstrapBridge();

  assert.equal(calls[1][0], 'connect');
});

test('pdd manager records helper launch errors without leaving PDD marked running', async () => {
  const exePath = WORKBENCH_EXE;
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (candidate) => candidate === exePath || originalExistsSync(candidate);
  const calls = [];
  const launchFailure = new Error('helper launch failed');

  try {
    const manager = new PddManager({
      exePath,
      helperClient: createHelperClient(calls, { launchError: launchFailure })
    });
    const errors = [];
    manager.on('error', (error) => errors.push(error));

    await assert.rejects(() => manager.launch(), launchFailure);

    assert.equal(manager.status.running, false);
    assert.equal(manager.status.pid, null);
    assert.equal(manager.status.lastError, 'helper launch failed');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, launchFailure.message);
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test('pdd manager sends helper launch_platform parameters with bridge URLs', async () => {
  const exePath = WORKBENCH_EXE;
  const calls = [];
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (candidate) => candidate === exePath || originalExistsSync(candidate);

  try {
    const manager = new PddManager({
      exePath,
      args: ['--flag'],
      wsPort: 4567,
      jsUrl: 'http://127.0.0.1:3000/pdd-bridge.js',
      helperClient: createHelperClient(calls)
    });
    manager.suppressPddUpdate = async () => null;

    await manager.launch();

    assert.deepEqual(calls[0], ['executeShell', 'taskkill /F /IM PddWorkbench.exe']);
    assert.deepEqual(calls[1], ['launchPlatform', {
      exe_path: exePath,
      inject_dllpath: DEFAULT_DLL,
      use_devtool: 1,
      ws_url: 'ws://127.0.0.1:4567/publicplatform',
      js_url: 'http://127.0.0.1:3000/pdd-bridge.js',
      js_data: '4567'
    }]);
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test('pdd manager logs taskkill errors and continues helper launch', async () => {
  const exePath = WORKBENCH_EXE;
  const calls = [];
  const messages = [];
  const originalExistsSync = fs.existsSync;
  const taskkillError = new Error('no PDD running');
  fs.existsSync = (candidate) => candidate === exePath || originalExistsSync(candidate);

  try {
    const manager = new PddManager({
      exePath,
      helperClient: createHelperClient(calls, { executeShellError: taskkillError }),
      logger: {
        log() {},
        error: (...args) => messages.push(args)
      }
    });
    manager.suppressPddUpdate = async () => null;

    const status = await manager.launch();

    assert.deepEqual(calls.map((call) => call[0]), [
      'executeShell',
      'launchPlatform'
    ]);
    assert.equal(status.running, true);
    assert.equal(status.pid, 4321);
    assert.equal(status.lastError, null);
    assert.deepEqual(messages[0], ['[pdd:taskkill-error]', taskkillError]);
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test('pdd manager stops launch when taskkill is denied by Windows', async () => {
  const exePath = WORKBENCH_EXE;
  const calls = [];
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (candidate) => candidate === exePath || originalExistsSync(candidate);

  try {
    const manager = new PddManager({
      exePath,
      helperClient: createHelperClient(calls, {
        executeShellResult: {
          output: '',
          stderr: '错误: 无法终止进程 "PddWorkbench.exe"，其 PID 为 30820。\r\n原因: 拒绝访问。\r\n',
          exitCode: 1
        }
      })
    });
    const errors = [];
    manager.on('error', (error) => errors.push(error));

    await assert.rejects(() => manager.launch(), /taskkill failed:[\s\S]*拒绝访问/);

    assert.deepEqual(calls.map((call) => call[0]), ['executeShell']);
    assert.equal(manager.status.running, false);
    assert.match(manager.status.lastError, /拒绝访问/);
    assert.equal(errors.length, 1);
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test('pdd manager reports helper permission launch errors', async () => {
  const exePath = WORKBENCH_EXE;
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (candidate) => candidate === exePath || originalExistsSync(candidate);
  const accessError = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });

  try {
    const manager = new PddManager({
      exePath,
      helperClient: createHelperClient([], { launchError: accessError })
    });
    const errors = [];
    manager.on('error', (error) => errors.push(error));

    await assert.rejects(() => manager.launch(), /permission|EACCES/i);

    assert.equal(manager.status.running, false);
    assert.match(manager.status.lastError, /permission|EACCES/i);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'EACCES');
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test('pdd manager resolves the bundled pdd-workbench executable by default', async () => {
  const originalExistsSync = fs.existsSync;
  const originalEnv = process.env.PDD_WORKBENCH_EXE;
  delete process.env.PDD_WORKBENCH_EXE;
  fs.existsSync = (candidate) => candidate === WORKBENCH_EXE || originalExistsSync(candidate);

  try {
    const manager = new PddManager();

    assert.equal(await manager.resolveExePath(), WORKBENCH_EXE);
    assert.equal(manager.status.exePath, WORKBENCH_EXE);
  } finally {
    fs.existsSync = originalExistsSync;
    if (originalEnv === undefined) delete process.env.PDD_WORKBENCH_EXE;
    else process.env.PDD_WORKBENCH_EXE = originalEnv;
  }
});

test('pdd manager does not run update suppression during helper launch', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-manager-'));
  const exePath = path.join(tempDir, 'PddWorkbench.exe');
  const updatePath = path.join(tempDir, 'PDDUpdate.exe');
  fs.writeFileSync(exePath, '');
  fs.writeFileSync(updatePath, '');
  const messages = [];

  try {
    const manager = new PddManager({
      exePath,
      helperClient: createHelperClient([]),
      logger: {
        log: (...args) => messages.push(args),
        error() {}
      }
    });

    await manager.launch();

    assert.equal(fs.existsSync(updatePath), true);
    assert.equal(messages.some(([name]) => name === '[pdd:update-suppressed]'), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('pdd manager reads current chat DOM through CDP', async () => {
  const calls = [];
  const manager = new PddManager({
    cdpManager: {
      connected: false,
      async connectWithFallback() {
        calls.push(['connectWithFallback']);
        this.connected = true;
        return { connected: true, url: 'ws://chat' };
      },
      async execute(method, params) {
        calls.push([method, params]);
        return {
          result: {
            value: {
              href: 'https://mms.pinduoduo.com/win-plugin/web/web_19.5.0/view/middle_panel/index.html?uid=',
              title: '聊天详情',
              text: '买家消息\n主账号\n客服回复',
              messages: [
                { text: '买家消息', className: 'msg-li' },
                { text: '主账号\n客服回复', className: 'msg-li' }
              ]
            }
          }
        };
      },
      async disconnect() {}
    }
  });

  const chat = await manager.readCurrentChatDom();

  assert.equal(chat.title, '聊天详情');
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].text, '买家消息');
  assert.deepEqual(calls.map((call) => call[0]), ['connectWithFallback', 'Runtime.evaluate']);
});

test('pdd manager sends a message to the current chat through PDD native socket bridge', async () => {
  const calls = [];
  const manager = new PddManager({
    cdpManager: {
      connected: false,
      async connectWithFallback() {
        calls.push(['connectWithFallback']);
        this.connected = true;
        return { connected: true, url: 'ws://chat' };
      },
      async execute(method, params) {
        calls.push([method, params]);
        assert.equal(method, 'Runtime.evaluate');
        assert.match(params.expression, /socketUtil\.sendMsg/);
        assert.match(params.expression, /String\.fromCodePoint\(104,101,108,108,111\)/);
        return {
          result: {
            value: {
              ok: true,
              text: 'hello',
              uid: 'buyer-1',
              csid: '125934914',
              callback: null
            }
          }
        };
      },
      async disconnect() {}
    }
  });

  const result = await manager.sendCurrentChatMessage('hello');

  assert.deepEqual(result, {
    ok: true,
    text: 'hello',
    uid: 'buyer-1',
    csid: '125934914',
    callback: null
  });
  assert.deepEqual(calls.map((call) => call[0]), ['connectWithFallback', 'Runtime.evaluate']);
});

test('pdd manager injectBridgeScript prefers JS_URL script injection when available', async () => {
  const calls = [];
  const manager = new PddManager({
    wsPort: 4567,
    jsUrl: 'http://127.0.0.1:3000/pdd-bridge.js',
    cdpManager: {
      connected: true,
      async execute(method, params) {
        calls.push([method, params]);
        return { ok: true };
      },
      async disconnect() {}
    }
  });

  await manager.injectBridgeScript();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'Runtime.evaluate');
  assert.match(calls[0][1].expression, /document\.createElement\("script"\)/);
  assert.match(calls[0][1].expression, /__pdd_fuke_bridge_script__/);
  assert.match(calls[0][1].expression, /__pddFukeBridgeUrl/);
});

test('layer survey target selector keeps the five most relevant PDD targets', () => {
  const selected = selectLayerSurveyTargets([
    { title: '无关页签', url: 'https://example.com/1', type: 'other', webSocketDebuggerUrl: 'ws://1' },
    { title: '商品订单', url: 'https://mms.pinduoduo.com/right_panel', type: 'other', webSocketDebuggerUrl: 'ws://2' },
    { title: '聊天详情', url: 'https://mms.pinduoduo.com/middle_panel', type: 'other', webSocketDebuggerUrl: 'ws://3' },
    { title: 'notification', url: 'https://mms.pinduoduo.com/notification', type: 'other', webSocketDebuggerUrl: 'ws://4' },
    { title: 'knock', url: 'https://mms.pinduoduo.com/knockComponent', type: 'other', webSocketDebuggerUrl: 'ws://5' },
    { title: '拼多多 商家后台', url: 'https://mms.pinduoduo.com/workbench', type: 'other', webSocketDebuggerUrl: 'ws://6' },
    { title: 'chrome devtools', url: 'chrome-extension://devtools', type: 'page', webSocketDebuggerUrl: 'ws://7' }
  ]);

  assert.equal(selected.length, 5);
  assert.equal(selected[0].title, '聊天详情');
  assert.equal(selected.some((target) => target.title === 'chrome devtools'), false);
});

test('pdd manager installs and drains the five-layer survey probe across selected targets', async () => {
  const calls = [];
  const timers = [];
  const probeEvents = [];
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return { unref() {} };
  };

  const cdpManager = {
    async listPageTargets() {
      return [
        { targetId: 'chat', title: '聊天详情', url: 'https://mms.pinduoduo.com/middle_panel', type: 'page', webSocketDebuggerUrl: 'ws://chat' },
        { targetId: 'order', title: '商品订单', url: 'https://mms.pinduoduo.com/right_panel', type: 'page', webSocketDebuggerUrl: 'ws://order' }
      ];
    },
    async executeOnWebSocketUrl(url, method, params) {
      calls.push([url, method, params.expression]);
      if (params.expression.includes('__pddFukeLayerSurveyInstalled')) {
        return { result: { value: { ok: true, href: `https://${url}`, title: url } } };
      }
      return {
        result: {
          value: {
            events: [{
              name: 'click',
              label: url,
              payload: { text: '转移会话' }
            }]
          }
        }
      };
    }
  };

  try {
    const manager = new PddManager({
      cdpManager,
      layerSurveyEnabled: true,
      layerSurveyPollMs: 300
    });
    manager.status.running = true;
    manager.on('probe', (payload) => probeEvents.push(payload));

    const selected = await manager.startLayerSurvey();

    assert.equal(selected.length, 2);
    assert.equal(calls.length, 2);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 300);

    timers.shift().callback();
    await flushAsyncWork();

    assert.equal(calls.length, 4);
    assert.equal(probeEvents.some((payload) => payload.diagnostic?.name === 'layer-survey-targets'), true);
    assert.equal(probeEvents.some((payload) => payload.diagnostic?.name === 'layer-survey-event'), true);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
