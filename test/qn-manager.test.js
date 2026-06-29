const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  QnManager,
  DEFAULT_QN_DLL_PATH,
  DEFAULT_QN_CSHARP_HELPER_PATH,
  resolveDefaultQnHelperPath
} = require('../main/qn-manager');

const QN_EXE = 'C:\\Users\\26799\\AppData\\Local\\fuke\\qn\\9.95.00\\AliWorkbench.exe';

function createHelperClient(calls, options = {}) {
  return {
    async executeShell(command) {
      calls.push(['executeShell', command]);
      return options.executeShellResult || { output: '' };
    },
    async launchPlatform(param) {
      calls.push(['launchPlatform', param]);
      return options.launchResult || { pid: 5678 };
    },
    stop() {
      calls.push(['helperStop']);
    }
  };
}

test('qn manager defaults to our csharp helper', () => {
  const originalQnHelper = process.env.QN_FUKE_HELPER_EXE;
  const originalQnCsharpHelper = process.env.QN_CSHARP_HELPER_EXE;
  const originalCsharp = process.env.PDD_FUKE_USE_CSHARP_HELPER;

  try {
    delete process.env.QN_FUKE_HELPER_EXE;
    delete process.env.QN_CSHARP_HELPER_EXE;
    process.env.PDD_FUKE_USE_CSHARP_HELPER = '1';

    assert.equal(resolveDefaultQnHelperPath(), DEFAULT_QN_CSHARP_HELPER_PATH);
  } finally {
    if (originalQnHelper === undefined) delete process.env.QN_FUKE_HELPER_EXE;
    else process.env.QN_FUKE_HELPER_EXE = originalQnHelper;
    if (originalQnCsharpHelper === undefined) delete process.env.QN_CSHARP_HELPER_EXE;
    else process.env.QN_CSHARP_HELPER_EXE = originalQnCsharpHelper;
    if (originalCsharp === undefined) delete process.env.PDD_FUKE_USE_CSHARP_HELPER;
    else process.env.PDD_FUKE_USE_CSHARP_HELPER = originalCsharp;
  }
});

test('qn manager keeps helper launch behavior platform neutral', () => {
  const helperOptions = [];
  class FakeHelperClient {
    constructor(options) {
      helperOptions.push(options);
    }
  }

  const manager = new QnManager({
    HelperClient: FakeHelperClient
  });

  assert.ok(manager.helperClient);
  assert.equal(Object.hasOwn(helperOptions[0], 'exitAfterLaunch'), false);
});

test('qn helper path can be overridden explicitly', () => {
  const originalQnHelper = process.env.QN_FUKE_HELPER_EXE;
  const originalQnCsharpHelper = process.env.QN_CSHARP_HELPER_EXE;

  try {
    delete process.env.QN_CSHARP_HELPER_EXE;
    process.env.QN_FUKE_HELPER_EXE = 'C:\\tools\\custom-qn-helper.exe';

    assert.equal(resolveDefaultQnHelperPath(), 'C:\\tools\\custom-qn-helper.exe');
    process.env.QN_CSHARP_HELPER_EXE = 'C:\\tools\\custom-csharp-helper.exe';
    assert.equal(resolveDefaultQnHelperPath(), 'C:\\tools\\custom-csharp-helper.exe');
    assert.equal(resolveDefaultQnHelperPath({ helperPath: 'C:\\tools\\explicit.exe' }), 'C:\\tools\\explicit.exe');
  } finally {
    if (originalQnHelper === undefined) delete process.env.QN_FUKE_HELPER_EXE;
    else process.env.QN_FUKE_HELPER_EXE = originalQnHelper;
    if (originalQnCsharpHelper === undefined) delete process.env.QN_CSHARP_HELPER_EXE;
    else process.env.QN_CSHARP_HELPER_EXE = originalQnCsharpHelper;
  }
});

test('qn manager launches AliWorkbench through helper with QnExtend parameters', async () => {
  const calls = [];
  const originalExistsSync = fs.existsSync;
  const originalInjectMode = process.env.PDD_FUKE_INJECT_MODE;
  fs.existsSync = (candidate) => candidate === QN_EXE || originalExistsSync(candidate);

  try {
    process.env.PDD_FUKE_INJECT_MODE = 'thread-context-w';
    const manager = new QnManager({
      exePath: QN_EXE,
      wsPort: 4567,
      jsUrl: 'http://127.0.0.1:3000/pdd-bridge.js',
      helperClient: createHelperClient(calls),
      processFinder: async () => []
    });

    const status = await manager.launch();

    assert.equal(status.running, true);
    assert.equal(status.pid, 5678);
    assert.deepEqual(calls[0], ['executeShell', 'taskkill /F /IM AliWorkbench.exe']);
    assert.deepEqual(calls[1], ['executeShell', 'taskkill /F /IM AliRender.exe']);
    assert.deepEqual(calls[2], ['executeShell', 'taskkill /F /IM AlibabaProtect.exe']);
    assert.deepEqual(calls.find((call) => call[0] === 'launchPlatform'), ['launchPlatform', {
      exe_path: QN_EXE,
      exe_param: '',
      user_power: true,
      inject_dllpath: DEFAULT_QN_DLL_PATH,
      use_devtool: true,
      js_url: 'http://127.0.0.1:3000/pdd-bridge.js',
      js_data: '4567',
      inject_mode: 'thread-context-w'
    }]);
  } finally {
    fs.existsSync = originalExistsSync;
    if (originalInjectMode === undefined) delete process.env.PDD_FUKE_INJECT_MODE;
    else process.env.PDD_FUKE_INJECT_MODE = originalInjectMode;
  }
});

test('qn manager refreshes AliWorkbench process status', async () => {
  const manager = new QnManager({
    processFinder: async () => [{
      ProcessId: 1234,
      Name: 'AliWorkbench.exe',
      ExecutablePath: QN_EXE,
      CommandLine: `"${QN_EXE}"`
    }],
    windowFinder: async () => [{
      pid: 1234,
      title: '千牛工作台',
      visible: true
    }]
  });

  const status = await manager.refreshStatus();

  assert.equal(status.running, true);
  assert.equal(status.pid, 1234);
  assert.equal(status.exePath, QN_EXE);
  assert.equal(status.windows.length, 1);
});

test('qn manager matches QnExtend dll version from AliWorkbench path', async () => {
  const calls = [];
  const exePath = 'C:\\Users\\26799\\AppData\\Local\\huihui\\qn\\9.63.20\\AliWorkbench.exe';
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (candidate) => candidate === exePath || originalExistsSync(candidate);

  try {
    const manager = new QnManager({
      exePath,
      wsPort: 4567,
      jsUrl: 'http://127.0.0.1:3000/pdd-bridge.js',
      helperClient: createHelperClient(calls),
      processFinder: async () => []
    });

    await manager.launch();

    assert.equal(calls.find((call) => call[0] === 'launchPlatform')[1].inject_dllpath, 'D:\\Program Files\\fuke\\assets\\inject\\QnExtend-9.63.20.dll');
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test('qn manager waits for AliWorkbench processes to exit before launch', async () => {
  const calls = [];
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (candidate) => candidate === QN_EXE || originalExistsSync(candidate);
  let processChecks = 0;

  try {
    const manager = new QnManager({
      exePath: QN_EXE,
      helperClient: createHelperClient(calls),
      processFinder: async () => {
        processChecks += 1;
        return processChecks < 3 ? [{ ProcessId: 1111, ExecutablePath: QN_EXE }] : [];
      }
    });

    await manager.launch();

    assert.equal(processChecks, 3);
    assert.equal(calls[0][0], 'executeShell');
    assert.equal(calls.find((call) => call[0] === 'launchPlatform')[0], 'launchPlatform');
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test('qn manager ignores duplicate launch during cooldown', async () => {
  const calls = [];
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (candidate) => candidate === QN_EXE || originalExistsSync(candidate);

  try {
    const manager = new QnManager({
      exePath: QN_EXE,
      helperClient: createHelperClient(calls),
      processFinder: async () => [],
      launchCooldownMs: 60000
    });

    const first = await manager.launch();
    const second = await manager.launch();

    assert.equal(first.pid, 5678);
    assert.equal(second.pid, 5678);
    assert.equal(calls.filter((call) => call[0] === 'launchPlatform').length, 1);
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test('qn manager shares an in-flight launch request', async () => {
  const calls = [];
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (candidate) => candidate === QN_EXE || originalExistsSync(candidate);
  let releaseLaunch;
  const helperClient = createHelperClient(calls, {
    launchResult: new Promise((resolve) => {
      releaseLaunch = () => resolve({ pid: 9012 });
    })
  });

  try {
    const manager = new QnManager({
      exePath: QN_EXE,
      helperClient,
      processFinder: async () => []
    });

    const first = manager.launch();
    const second = manager.launch();
    releaseLaunch();
    const results = await Promise.all([first, second]);

    assert.equal(results[0].pid, 9012);
    assert.equal(results[1].pid, 9012);
    assert.equal(calls.filter((call) => call[0] === 'launchPlatform').length, 1);
  } finally {
    fs.existsSync = originalExistsSync;
  }
});
