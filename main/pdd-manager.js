'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');
const {
  findPddWorkbenchWindows,
  findPddLoginWindows,
  findProcessByName,
  findWindowsByPid
} = require('./win32-helper');
const dllInjector = require('./dll-injector');
const cdpManager = require('./cdp-manager');

const DEFAULT_ARGS = ['--disable-web-security'];
const DEFAULT_INJECT_DIR = path.join(__dirname, '..', 'assets', 'inject');
const DEFAULT_FUKE_INJECT_DIR = 'D:\\Program Files\\fuke\\assets\\inject';
const DEFAULT_HELPER_PATH = 'D:\\Program Files\\fuke\\assets\\inject\\fuke-helper.exe';
const DEFAULT_CSHARP_HELPER_PATH = path.join(__dirname, '..', 'helper-csharp', 'bin', 'PddFukeHelper.exe');
const DEFAULT_HELPER_HOST = '127.0.0.1';
const DEFAULT_HELPER_PORT = 5555;
const DEFAULT_HELPER_PATHNAME = '/Extend';
const DEFAULT_HELPER_INVOKE_TIMEOUT_MS = 15000;
const DEFAULT_CDP_CONNECT_DELAY_MS = 5000;
const DEFAULT_CDP_RETRY_DELAY_MS = 2000;
const DEFAULT_CDP_MAX_ATTEMPTS = 12;
const DEFAULT_LAYER_SURVEY_POLL_MS = 1200;
const noopLogger = { log() {}, error() {} };

function resolveDefaultHelperPath(options = {}) {
  if (options.helperPath) return options.helperPath;
  if (process.env.PDD_FUKE_HELPER_EXE) return process.env.PDD_FUKE_HELPER_EXE;
  if (process.env.LG_HELPER_EXE) return process.env.LG_HELPER_EXE;
  if (process.env.PDD_FUKE_USE_CSHARP_HELPER === '1' || process.env.PDD_LG_USE_CSHARP_HELPER === '1') return DEFAULT_CSHARP_HELPER_PATH;
  if (process.env.PDD_FUKE_USE_OWN_HELPER === '1' || process.env.PDD_LG_USE_OWN_HELPER === '1') return path.join(__dirname, 'own-helper.js');
  if (fs.existsSync(DEFAULT_CSHARP_HELPER_PATH)) return DEFAULT_CSHARP_HELPER_PATH;
  return DEFAULT_HELPER_PATH;
}

class HelperClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.helperPath = resolveDefaultHelperPath(options);
    this.helperNodePath = options.helperNodePath || process.env.PDD_LG_NODE_EXE || process.execPath;
    this.host = options.host || DEFAULT_HELPER_HOST;
    this.port = options.port ?? DEFAULT_HELPER_PORT;
    this.path = options.path || DEFAULT_HELPER_PATHNAME;
    this.spawn = options.spawn || spawn;
    this.logger = options.logger || noopLogger;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_HELPER_INVOKE_TIMEOUT_MS;
    this.exitAfterLaunch = Boolean(options.exitAfterLaunch);
    this.server = null;
    this.socket = null;
    this.child = null;
    this.pending = [];
    this.nextId = 1;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  async start() {
    if (this.socket?.readyState === WebSocket.OPEN) return this;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    try {
      this.server = await this.createServer(this.port);
      const helperWsUrl = this.helperUrl();
      const launch = this.resolveHelperLaunch(helperWsUrl);
      this.logger.log('[helper:start]', { helperPath: this.helperPath, helperWsUrl, command: launch.command });
      this.child = this.spawn(launch.command, launch.args, { windowsHide: true, stdio: 'ignore', env: launch.env || process.env });
      this.child.once?.('error', (error) => {
        this.logger.error('[helper:process-error]', error);
        this.rejectReady?.(error);
        this.readyPromise = null;
      });
      this.child.once?.('exit', (code, signal) => {
        this.logger.log('[helper:process-exit]', { code, signal });
      });
    } catch (error) {
      this.rejectReady?.(error);
      this.readyPromise = null;
      throw error;
    }

    return this.readyPromise;
  }

  resolveHelperLaunch(helperWsUrl) {
    if (/\.js$/i.test(this.helperPath)) {
      return {
        command: this.helperNodePath,
        args: [this.helperPath, helperWsUrl]
      };
    }

    return {
      command: this.helperPath,
      args: [helperWsUrl],
      env: this.isCsharpHelper() ? this.resolveCsharpHelperEnv() : process.env
    };
  }

  isCsharpHelper() {
    const basename = path.basename(this.helperPath);
    return /^Pdd(?:Lg|Fuke|Landian)Helper.*\.exe$/i.test(basename);
  }

  resolveCsharpHelperEnv() {
    const env = { ...process.env, PDD_FUKE_HELPER_ELEVATE: '1', PDD_LG_HELPER_ELEVATE: '1' };
    if (this.exitAfterLaunch) {
      env.PDD_FUKE_HELPER_EXIT_AFTER_LAUNCH = '1';
      env.PDD_LG_HELPER_EXIT_AFTER_LAUNCH = '1';
    }
    return env;
  }

  async createServer(port) {
    try {
      return await this.listen(port);
    } catch (error) {
      if (Number(port) !== 0 && error.code === 'EADDRINUSE') {
        return this.listen(0);
      }
      throw error;
    }
  }

  listen(port) {
    const server = new WebSocketServer({ host: this.host, port, path: this.path });
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        server.off('listening', onListening);
        server.off('error', onError);
      };
      const onListening = () => {
        cleanup();
        server.on('connection', (socket) => this.handleConnection(socket));
        resolve(server);
      };
      const onError = (error) => {
        cleanup();
        server.close();
        reject(error);
      };

      server.once('listening', onListening);
      server.once('error', onError);
    });
  }

  helperUrl() {
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : this.port;
    return `ws://${this.host}:${port}${this.path}`;
  }

  handleConnection(socket) {
    this.socket = socket;
    socket.on('message', (buffer) => this.handleMessage(buffer.toString()));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.readyPromise = null;
    });
    socket.on('error', (error) => this.handleError(error));
  }

  handleMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch (error) {
      this.handleError(error);
      return;
    }

    if (frame.type === 'event' && frame.body?.name === 'hello' && /^(?:lg|fuke)-helper$/i.test(frame.body.param?.platform || '')) {
      this.logger.log('[helper:hello]', frame.body.param);
      this.resolveReady?.(this);
      return;
    }

    if (frame.type === 'response' && frame.body?.success !== undefined) {
      const pending = this.pending.shift();
      if (!pending) return;

      clearTimeout(pending.timer);
      this.logger.log('[helper:invoke-response]', frame);
      if (frame.body?.success === false) {
        pending.reject(new Error(frame.body?.message || frame.body?.error || 'fuke-helper request failed'));
      } else {
        pending.resolve(frame.body?.data);
      }
    }
  }

  async invoke(name, param = {}) {
    await this.start();

    if (!this.isSocketOpen()) {
      throw new Error('fuke-helper websocket is not connected.');
    }

    const id = String(this.nextId++);
    const frame = { type: 'invoke', id, body: { name, param } };
    const result = new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(pending);
        if (index !== -1) this.pending.splice(index, 1);
        reject(new Error(`fuke-helper invoke timed out after ${this.invokeTimeoutMs}ms: ${name}`));
      }, this.invokeTimeoutMs);
      timer.unref?.();
      pending.timer = timer;
      this.pending.push(pending);
    });
    this.logger.log('[helper:invoke-send]', frame);
    this.socket.send(JSON.stringify(frame));
    return result;
  }

  isSocketOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async executeShell(command) {
    await this.start();
    if (!this.isSocketOpen()) {
      throw new Error('fuke-helper websocket is not connected.');
    }
    return this.invoke('execute_shell', { command });
  }

  launchPlatform(param) {
    return this.invoke('launch_platform', param);
  }

  handleError(error) {
    this.logger.error('[helper:error]', error);
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  stop() {
    for (const pending of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('fuke-helper stopped before responding.'));
    }
    this.pending = [];
    this.socket?.close();
    this.socket = null;
    this.server?.close();
    this.server = null;
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }
}

class PddManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.exePath = options.exePath || process.env.PDD_WORKBENCH_EXE || '';
    this.args = options.args || DEFAULT_ARGS;
    this.dllInjector = options.dllInjector || dllInjector;
    this.cdpManager = options.cdpManager || cdpManager;
    this.logger = options.logger || noopLogger;
    this.helperClient = options.helperClient || new HelperClient({
      helperPath: options.helperPath,
      spawn: options.helperSpawn,
      logger: this.logger
    });
    this.wsPort = options.wsPort || null;
    this.jsUrl = options.jsUrl || process.env.JS_URL || '';
    this.child = null;
    this.monitorTimer = null;
    this.bridgeTimer = null;
    this.cdpTimer = null;
    this.nativeWindowTimer = null;
    this.lastNativeWindowSnapshot = '';
    this.layerSurveyTimer = null;
    this.layerSurveyTargets = [];
    this.rightPanelEventSummary = {
      counts: new Map(),
      recent: []
    };
    this.lastRightPanelSummarySnapshot = '';
    this.layerSurveyEnabled = options.layerSurveyEnabled ?? false;
    this.layerSurveyPollMs = options.layerSurveyPollMs ?? DEFAULT_LAYER_SURVEY_POLL_MS;
    this.cdpAttempt = 0;
    this.cdpRetryDelayMs = options.cdpRetryDelayMs ?? DEFAULT_CDP_RETRY_DELAY_MS;
    this.cdpMaxAttempts = options.cdpMaxAttempts ?? DEFAULT_CDP_MAX_ATTEMPTS;
    this.status = {
      running: false,
      pid: null,
      exePath: this.exePath,
      workbenchWindows: [],
      loginWindows: [],
      cdpConnected: Boolean(this.cdpManager.connected),
      cdpError: null,
      bridgeInjected: false,
      bridgeError: null,
      lastError: null
    };
  }

  async resolveExePath() {
    if (this.exePath && fs.existsSync(this.exePath)) return this.exePath;

    const localAppData = process.env.LOCALAPPDATA || '';
    const candidates = [
      // OSS 按需下载目录（优先级最高）
      path.join(localAppData, 'pdd-fuke', 'workbenches', 'pdd'),
      // 兼容旧版内置目录
      path.join(__dirname, '..', 'pdd-workbench', 'PddWorkbench.exe'),
      // 其他可能的安装目录
      path.join(localAppData, 'huihui', 'pdd', '3.5.7.16', 'PddWorkbench.exe'),
      path.join(localAppData, 'PddWorkbench', 'PddWorkbench.exe'),
      path.join(process.env.PROGRAMFILES || '', 'PddWorkbench', 'PddWorkbench.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'PddWorkbench', 'PddWorkbench.exe')
    ].filter(Boolean);

    // 特殊处理 OSS 目录：扫描所有版本
    const ossBase = candidates[0];
    if (fs.existsSync(ossBase)) {
      try {
        const versions = fs.readdirSync(ossBase, { withFileTypes: true })
          .filter((d) => d.isDirectory());
        for (const ver of versions.reverse()) { // 最新版本优先
          const exePath = path.join(ossBase, ver.name, 'extracted', 'PddWorkbench.exe');
          if (fs.existsSync(exePath)) {
            this.exePath = exePath;
            this.status.exePath = exePath;
            return exePath;
          }
        }
      } catch (_) {}
    }

    const found = candidates.slice(1).find((candidate) => fs.existsSync(candidate));
    if (found) {
      this.exePath = found;
      this.status.exePath = found;
    }

    return this.exePath;
  }

  async suppressPddUpdate(exePath) {
    const updatePath = path.join(path.dirname(exePath), 'PDDUpdate.exe');
    if (!fs.existsSync(updatePath)) return null;

    this.logger.log('[pdd:update-suppressed]', { updatePath, action: 'skip' });
    return { updatePath, action: 'skip' };
  }

  /**
   * 从 exe 路径中提取版本号，用于匹配对应版本的 DLL
   * 路径格式: .../pdd/3.5.7.16/extracted/PddWorkbench.exe 或 .../pdd/3.5.7.16/PddWorkbench.exe
   */
  resolveDllPath(exePath) {
    // 环境变量显式指定优先
    if (process.env.PDD_FUKE_DLL) return process.env.PDD_FUKE_DLL;
    if (process.env.PDD_LG_DLL) return process.env.PDD_LG_DLL;

    // 优先使用自研 CdpEnabler.dll（不依赖版本号，通用兼容）
    // 回退：从 exe 路径中提取版本号，匹配对应版本的 PddExtend DLL
    const parts = exePath.split(path.sep);
    const pddIdx = parts.lastIndexOf('pdd');
    if (pddIdx !== -1 && pddIdx + 1 < parts.length) {
      const version = parts[pddIdx + 1];
      if (/^\d+\.\d+\.\d+(\.\d+)?$/.test(version)) {
        const candidates = [
          path.join(path.dirname(exePath), `PddExtend-${version}.dll`),
          path.join(DEFAULT_INJECT_DIR, `PddExtend-${version}.dll`),
          path.join(DEFAULT_FUKE_INJECT_DIR, `PddExtend-${version}.dll`)
        ];
        for (const dllPath of candidates) {
          if (fs.existsSync(dllPath)) {
            this.logger.log('[dll:resolve]', { version, dllPath });
            return dllPath;
          }
        }
        this.logger.log('[dll:resolve-missing]', { version, tried: candidates });
      }
    }

    // 最后回退：使用默认推荐版本 DLL
    const fallbackCandidates = [
      path.join(path.dirname(exePath || ''), 'PddExtend-3.5.7.16.dll'),
      path.join(DEFAULT_INJECT_DIR, 'PddExtend-3.5.7.16.dll'),
      path.join(DEFAULT_FUKE_INJECT_DIR, 'PddExtend-3.5.7.16.dll')
    ];
    const fallback = fallbackCandidates.find((candidate) => fs.existsSync(candidate)) || fallbackCandidates[0];
    this.logger.log('[dll:resolve-fallback]', { fallback });
    return fallback;
  }

  async launch() {
    this.logger.log('[pdd:launch]', { exePath: this.exePath, args: this.args });
    const exePath = await this.resolveExePath();
    if (!exePath || !fs.existsSync(exePath)) {
      const error = new Error('PddWorkbench.exe was not found. Set PDD_WORKBENCH_EXE to the installed executable path.');
      this.status.lastError = error.message;
      this.logger.error('[pdd:launch-error]', error);
      this.emit('error', error);
      throw error;
    }

    let data;
    try {
      try {
        const taskkillResult = await this.helperClient.executeShell('taskkill /F /IM PddWorkbench.exe');
        assertTaskkillAllowed(taskkillResult);
      } catch (error) {
        this.logger.error('[pdd:taskkill-error]', error);
        if (error.code === 'PDD_TASKKILL_ACCESS_DENIED') throw error;
      }

      const wsUrl = this.wsPort ? `ws://127.0.0.1:${this.wsPort}/publicplatform` : '';
      const launchParam = {
        exe_path: exePath,
        inject_dllpath: this.resolveDllPath(exePath),
        use_devtool: 1,
        ws_url: wsUrl,
        js_url: this.jsUrl,
        js_data: String(this.wsPort ?? '')
      };
      this.logger.log('[pdd:launch-params]', launchParam);
      data = await this.helperClient.launchPlatform(launchParam);
    } catch (error) {
      this.status.running = false;
      this.status.pid = null;
      this.status.lastError = error.message;
      this.logger.error('[pdd:launch-error]', error);
      this.emit('error', error);
      throw error;
    }

    this.status.running = true;
    this.status.pid = data?.pid || null;
    this.status.lastError = null;
    this.emit('launched', this.status);
    this.scheduleCdpConnect();

    return this.status;
  }

  scheduleCdpConnect(delayMs = DEFAULT_CDP_CONNECT_DELAY_MS) {
    if (this.cdpTimer) clearTimeout(this.cdpTimer);
    this.cdpTimer = setTimeout(() => {
      this.cdpTimer = null;
      this.cdpAttempt += 1;
      this.connectCdp()
        .then(async (result) => {
          this.status.cdpConnected = true;
          this.status.cdpError = null;
          this.cdpAttempt = 0;
          if (this.wsPort) {
            try {
              await this.injectBridgeScript();
            } catch (error) {
              this.logger.error('[pdd:bridge-script-fallback-error]', error);
            }
          }
          if (this.layerSurveyEnabled) {
            this.startLayerSurvey().catch((error) => {
              this.logger.error('[pdd:layer-survey-start-error]', error);
              this.emit('probe', createProbePayload('layer-survey-start-error', {
                error: error.message || String(error)
              }));
            });
          }
          this.startNativeWindowSurvey();
          this.emit('cdp-ready', result);
        })
        .catch((error) => {
          this.status.cdpConnected = false;
          this.status.cdpError = error.message;
          this.logger.error('[cdp:error]', error);
          this.emit('cdp-error', error);
          if (this.status.running && this.cdpAttempt < this.cdpMaxAttempts) {
            this.logger.log('[cdp:retry-scheduled]', {
              attempt: this.cdpAttempt,
              nextDelayMs: this.cdpRetryDelayMs,
              maxAttempts: this.cdpMaxAttempts
            });
            this.scheduleCdpConnect(this.cdpRetryDelayMs);
          }
        });
    }, delayMs);
    this.cdpTimer.unref?.();
  }

  scheduleBridgeBootstrap() {
    if (this.bridgeTimer) clearTimeout(this.bridgeTimer);
    this.bridgeTimer = setTimeout(() => {
      this.bridgeTimer = null;
      this.bootstrapBridge().catch((error) => this.emit('bridge:inject-error', error));
    }, 3000);
    this.bridgeTimer.unref?.();
  }

  async bootstrapBridge() {
    let injection;
    try {
      injection = this.injectDll();
      this.status.bridgeInjected = true;
      this.status.bridgeError = null;
      this.emit('bridge:injected', injection);
    } catch (error) {
      this.status.bridgeInjected = false;
      this.status.bridgeError = error.message;
      this.logger.error('[dll:inject-error]', error);
      this.emit('bridge:inject-error', error);
      return;
    }

    try {
      const result = await this.connectCdp();
      await this.cdpExecute('Runtime.evaluate', { expression: '1+1' });
      await this.injectBridgeScript();
      this.status.cdpConnected = true;
      this.status.cdpError = null;
      this.emit('cdp-ready', result);
    } catch (error) {
      this.status.cdpConnected = false;
      this.status.cdpError = error.message;
      this.logger.error('[cdp:error]', error);
      this.emit('cdp-error', error);
    }
  }

  async injectBridgeScript() {
    if (!this.wsPort) return null;

    const expression = this.jsUrl
      ? [
        '(() => {',
        `window.js_data = ${Number(this.wsPort)};`,
        `window.JS_DATA = ${Number(this.wsPort)};`,
        `window.__pddFukeBridgeUrl = ${jsStringFromText(this.jsUrl)};`,
        'const previous = document.getElementById("__pdd_fuke_bridge_script__");',
        'if (previous) previous.remove();',
        'const script = document.createElement("script");',
        'script.id = "__pdd_fuke_bridge_script__";',
        'script.async = true;',
        'script.src = window.__pddFukeBridgeUrl;',
        'document.documentElement.appendChild(script);',
        'return { ok: true, mode: "script", src: script.src };',
        '})()'
      ].join('\n')
      : [
        '(() => {',
        `window.js_data = ${Number(this.wsPort)};`,
        'if (window.__pddLgBridgeSocket && window.__pddLgBridgeSocket.readyState < 2) {',
        'window.__pddLgBridgeSocket.close();',
        '}',
        `window.__pddLgBridgeSocket = new WebSocket('ws://127.0.0.1:${this.wsPort}/publicplatform');`,
        'return { ok: true, mode: "socket" };',
        '})()'
      ].join('\n');

    return this.cdpExecute('Runtime.evaluate', { expression });
  }

  async refreshStatus() {
    try {
      const [processes, workbenchWindows, loginWindows] = await Promise.all([
        findProcessByName('PddWorkbench.exe'),
        findPddWorkbenchWindows(),
        findPddLoginWindows()
      ]);

      this.status.running = processes.length > 0 || Boolean(this.child && !this.child.killed);
      this.status.pid = processes[0]?.ProcessId || processes[0]?.pid || this.child?.pid || null;
      this.status.workbenchWindows = workbenchWindows;
      this.status.loginWindows = loginWindows;
      this.status.lastError = null;
      this.emit('status', this.status);
    } catch (error) {
      this.status.lastError = error.message;
      this.emit('error', error);
    }

    return this.status;
  }

  startMonitoring(intervalMs = 5000) {
    if (this.monitorTimer) return;
    this.refreshStatus();
    this.monitorTimer = setInterval(() => this.refreshStatus(), intervalMs);
    this.monitorTimer.unref();
  }

  stopMonitoring() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  stop() {
    this.stopMonitoring();
    if (this.bridgeTimer) clearTimeout(this.bridgeTimer);
    this.bridgeTimer = null;
    if (this.cdpTimer) clearTimeout(this.cdpTimer);
    this.cdpTimer = null;
    this.stopNativeWindowSurvey();
    this.stopLayerSurvey();
    this.resetRightPanelSummary();
    this.disconnectCdp();
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.helperClient?.stop?.();
  }

  injectDll(pid = this.status.pid, dllPath = this.resolveDllPath(this.exePath)) {
    const result = this.dllInjector.injectDll(pid, dllPath);
    this.logger.log('[dll:inject-result]', result);
    this.emit('dll-injected', result);
    return result;
  }

  async connectCdp() {
    this.logger.log('[cdp:connect-attempt]');
    const connect = typeof this.cdpManager.connectWithFallback === 'function'
      ? () => this.cdpManager.connectWithFallback()
      : () => this.cdpManager.connect();
    const result = await connect();
    this.status.cdpConnected = true;
    this.emit('cdp-connected', result);
    return result;
  }

  async disconnectCdp() {
    await this.cdpManager.disconnect();
    this.status.cdpConnected = false;
    this.emit('cdp-disconnected');
  }

  async cdpExecute(method, params) {
    return this.cdpManager.execute(method, params);
  }

  async readCurrentChatDom() {
    if (!this.cdpManager.connected) {
      await this.connectCdp();
    }

    const expression = `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const messages = Array.from(document.querySelectorAll('.msg-li')).slice(-30).map((el, index) => {
        const contentNode = el.querySelector('.msg-content-box, .msg-content');
        const nicknameNode = el.querySelector('.nickname, .name, .user-name');
        const timeNode = el.querySelector('.message-time, .time, .msg-time');
        return {
          index,
          text: normalize(el.innerText || el.textContent),
          content: normalize(contentNode?.innerText || contentNode?.textContent),
          nickname: normalize(nicknameNode?.innerText || nicknameNode?.textContent),
          time: normalize(timeNode?.innerText || timeNode?.textContent),
          className: String(el.className || '')
        };
      });
      return {
        href: location.href,
        title: document.title,
        text: normalize(document.body?.innerText || document.body?.textContent).slice(-4000),
        messages
      };
    })()`;

    const result = await this.cdpExecute('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return result?.result?.value || null;
  }

  async sendCurrentChatMessage(text) {
    if (!this.cdpManager.connected) {
      await this.connectCdp();
    }

    const expression = `(() => new Promise((resolve) => {
      const text = ${jsStringFromText(text)};
      const uid = localStorage.currentUid || window.currentUserInfo?.UIDSwitchInfo;
      const csid = window.global_uid;
      if (!window.socketUtil?.sendMsg) {
        resolve({ ok: false, error: 'socketUtil.sendMsg not found' });
        return;
      }
      if (!uid || !csid) {
        resolve({ ok: false, error: 'missing uid or csid', uid: uid || '', csid: csid || '' });
        return;
      }

      let settled = false;
      const done = (extra = {}) => {
        if (settled) return;
        settled = true;
        resolve({ ok: true, text, uid: String(uid), csid: String(csid), ...extra });
      };

      try {
        const result = window.socketUtil.sendMsg({
          content: text,
          uid: String(uid),
          csid: String(csid),
          type: 0,
          cb: (response) => done({ callback: response || null })
        });
        setTimeout(() => done({ timeout: true, result }), 3000);
      } catch (error) {
        resolve({
          ok: false,
          error: error && error.stack || String(error),
          uid: String(uid),
          csid: String(csid)
        });
      }
    }))()`;

    const result = await this.cdpExecute('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return result?.result?.value || null;
  }

  async getCdpTargets() {
    return this.cdpManager.getTargets();
  }

  async startLayerSurvey() {
    if (!this.layerSurveyEnabled || typeof this.cdpManager.listPageTargets !== 'function' || typeof this.cdpManager.executeOnWebSocketUrl !== 'function') {
      return [];
    }

    const targets = await this.cdpManager.listPageTargets();
    const selectedTargets = selectLayerSurveyTargets(Array.isArray(targets) ? targets : []);
    this.layerSurveyTargets = selectedTargets;
    this.emit('probe', createProbePayload('layer-survey-targets', {
      total: Array.isArray(targets) ? targets.length : 0,
      selected: selectedTargets.map((target) => ({
        title: String(target.title || ''),
        url: String(target.url || ''),
        type: String(target.type || ''),
        webSocketDebuggerUrl: String(target.webSocketDebuggerUrl || ''),
        score: scoreLayerSurveyTarget(target)
      }))
    }));

    for (const target of selectedTargets) {
      const result = await this.cdpManager.executeOnWebSocketUrl(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: buildLayerSurveyInstallExpression(target),
        returnByValue: true,
        awaitPromise: true
      });
      this.emit('probe', createProbePayload('layer-survey-installed', {
        title: String(target.title || ''),
        url: String(target.url || ''),
        targetId: String(target.id || target.targetId || ''),
        result: result?.result?.value || null
      }));
    }

    this.scheduleLayerSurveyPoll();
    return selectedTargets;
  }

  stopLayerSurvey() {
    if (this.layerSurveyTimer) clearTimeout(this.layerSurveyTimer);
    this.layerSurveyTimer = null;
    this.layerSurveyTargets = [];
  }

  scheduleLayerSurveyPoll() {
    if (this.layerSurveyTimer) clearTimeout(this.layerSurveyTimer);
    if (!this.layerSurveyTargets.length) return;
    this.layerSurveyTimer = setTimeout(() => {
      this.layerSurveyTimer = null;
      this.pollLayerSurvey().catch((error) => {
        this.logger.error('[pdd:layer-survey-poll-error]', error);
        this.emit('probe', createProbePayload('layer-survey-poll-error', {
          error: error.message || String(error)
        }));
      });
    }, this.layerSurveyPollMs);
    this.layerSurveyTimer.unref?.();
  }

  async pollLayerSurvey() {
    if (!this.layerSurveyEnabled || !this.status.running || !this.layerSurveyTargets.length) return [];

    const events = [];
    for (const target of this.layerSurveyTargets) {
      try {
        const result = await this.cdpManager.executeOnWebSocketUrl(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
          expression: buildLayerSurveyDrainExpression(),
          returnByValue: true,
          awaitPromise: true
        });
        const value = result?.result?.value || {};
        for (const event of value.events || []) {
          this.recordRightPanelEvent(target, event);
          const payload = createProbePayload('layer-survey-event', {
            title: String(target.title || ''),
            targetUrl: String(target.url || ''),
            targetId: String(target.id || target.targetId || ''),
            event
          });
          events.push(payload);
          this.emit('probe', payload);
        }
      } catch (error) {
        this.emit('probe', createProbePayload('layer-survey-target-error', {
          title: String(target.title || ''),
          url: String(target.url || ''),
          error: error.message || String(error)
        }));
      }
    }

    this.scheduleLayerSurveyPoll();
    return events;
  }

  resetRightPanelSummary() {
    this.rightPanelEventSummary = {
      counts: new Map(),
      recent: []
    };
    this.lastRightPanelSummarySnapshot = '';
  }

  recordRightPanelEvent(target, event) {
    const title = String(target?.title || '');
    const targetUrl = String(target?.url || '');
    if (!/商品订单|right_panel/i.test(`${title} ${targetUrl}`)) return;
    if (!event || String(event.name || '') !== 'pinnotification-call') return;

    const method = String(event.payload?.method || '');
    const eventName = String(event.payload?.eventName || '');
    const summaryKey = `${method}:${eventName}`;
    const counts = this.rightPanelEventSummary.counts;
    counts.set(summaryKey, (counts.get(summaryKey) || 0) + 1);

    this.rightPanelEventSummary.recent.push({
      time: Number(event.time || Date.now()),
      method,
      eventName,
      sample: event.payload?.sample || [],
      parsed: event.payload?.parsed ?? null
    });
    if (this.rightPanelEventSummary.recent.length > 40) {
      this.rightPanelEventSummary.recent.splice(0, this.rightPanelEventSummary.recent.length - 40);
    }

    // 尝试从 pinnotification 事件中提取订单/物流信息
    const orderInfo = extractOrderInfoFromPinnotification(event);
    if (orderInfo) {
      // 通过 probe 上报（给外部监听者）
      this.emit('probe', createProbePayload('right-panel-order-info', {
        targetTitle: title,
        targetUrl,
        method,
        eventName,
        orderInfo
      }));
      // 同时通过 order-extracted 事件上报，保持与 bridge 消息一致的格式
      this.emit('order-extracted', {
        source: 'right-panel-pinnotification',
        targetTitle: title,
        method,
        eventName,
        orders: orderInfo
      });
    }

    const countsObject = Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
    const snapshot = JSON.stringify({
      counts: countsObject,
      recent: this.rightPanelEventSummary.recent.slice(-12)
    });
    if (snapshot === this.lastRightPanelSummarySnapshot) return;
    this.lastRightPanelSummarySnapshot = snapshot;

    this.emit('probe', createProbePayload('right-panel-pinnotification-summary', {
      targetTitle: title,
      targetUrl,
      counts: countsObject,
      recent: this.rightPanelEventSummary.recent.slice(-12)
    }));
  }

  startNativeWindowSurvey() {
    this.stopNativeWindowSurvey();
    this.scheduleNativeWindowPoll(0);
  }

  stopNativeWindowSurvey() {
    if (this.nativeWindowTimer) clearTimeout(this.nativeWindowTimer);
    this.nativeWindowTimer = null;
    this.lastNativeWindowSnapshot = '';
  }

  scheduleNativeWindowPoll(delayMs = 300) {
    if (!this.status.pid) return;
    this.nativeWindowTimer = setTimeout(() => {
      this.nativeWindowTimer = null;
      this.pollNativeWindows().catch((error) => {
        this.logger.error('[pdd:native-window-poll-error]', error);
      });
    }, delayMs);
    this.nativeWindowTimer.unref?.();
  }

  async pollNativeWindows() {
    if (!this.status.running || !this.status.pid) return [];
    const windows = await findWindowsByPid(this.status.pid);
    const normalized = windows
      .map((window) => ({
        hwnd: String(window.hwnd || ''),
        className: String(window.className || ''),
        title: String(window.title || ''),
        visible: Boolean(window.visible),
        bounds: window.bounds || null
      }))
      .sort((left, right) => left.hwnd.localeCompare(right.hwnd));
    const snapshot = JSON.stringify(normalized);
    if (snapshot !== this.lastNativeWindowSnapshot) {
      this.lastNativeWindowSnapshot = snapshot;
      this.emit('probe', createProbePayload('native-window-snapshot', {
        pid: this.status.pid,
        windows: normalized
      }));
    }
    this.scheduleNativeWindowPoll();
    return normalized;
  }
}

function jsStringFromText(value) {
  const codePoints = Array.from(String(value || ''), (char) => char.codePointAt(0));
  return `String.fromCodePoint(${codePoints.join(',')})`;
}

function selectLayerSurveyTargets(targets) {
  return [...targets]
    .filter((target) => {
      if (!target?.webSocketDebuggerUrl) return false;
      const haystack = `${target?.title || ''} ${target?.url || ''}`.toLowerCase();
      return !/devtools|chrome-extension/.test(haystack);
    })
    .sort((left, right) => scoreLayerSurveyTarget(right) - scoreLayerSurveyTarget(left))
    .slice(0, 5);
}

function scoreLayerSurveyTarget(target) {
  const haystack = `${target?.title || ''} ${target?.url || ''}`.toLowerCase();
  let score = 0;
  if (/middle_panel|聊天详情|conversation|chat/.test(haystack)) score += 100;
  if (/right_panel|商品订单|buyer|order/.test(haystack)) score += 80;
  if (/notification|knock|sidebar|dialog/.test(haystack)) score += 60;
  if (/mms\.pinduoduo\.com|workbench|pinduoduo/.test(haystack)) score += 40;
  if (/devtools|chrome-extension/.test(haystack)) score -= 100;
  return score;
}

function createProbePayload(name, payload = {}) {
  return {
    platform: 'pdd',
    diagnostic: {
      name,
      time: Date.now(),
      payload
    }
  };
}

/**
 * 从 pinnotification 事件中提取订单/物流信息
 * 拼多多 right_panel 的 pinnotification 会触发多种事件，包括：
 * - UIDSwitchInfo: 客服切换到某个买家时推送，包含当前会话关联的订单列表
 * - MMSSocketReceiveMessage: 服务端推送的订单状态变更/物流更新等
 * 返回提取到的订单信息数组，每个元素包含 order_sn/order_status/logistics 等字段
 */
function extractOrderInfoFromPinnotification(event) {
  try {
    const parsed = event?.payload?.parsed;
    if (!parsed || typeof parsed !== 'object') return null;

    const results = [];

    // 物流单号正则（与 bridge 保持一致）
    const EXPRESS_NO_RE = /\b((?:JD|SF|YT|YTO|STO|ZTO|DBL|HTKY|YD|EMS|UPS|DHL|FEDEX|TNT|BEST|TTK|ANE|UC|QFKD|JDKY|JTSD|DBKD|ZJS|YCG|GTO|AJ|SX|JTSD|DSK|DTW|GTSD|CITY)[A-Z0-9]{8,30}|(?:JDV?C?|SF|YT|YTO|STO|ZTO|DBL|HTKY|YD|EMS)[A-Z0-9]{8,30}|[A-Z]{2}[0-9]{9,20}[A-Z]{2}|[A-Z0-9]{10,30})\b/gi;

    // 递归搜索对象中所有可能的订单/物流字段
    function deepExtract(obj, _depth) {
      if (!obj || typeof obj !== 'object' || _depth > 6) return;
      if (Array.isArray(obj)) {
        for (const item of obj) deepExtract(item, _depth + 1);
        return;
      }

      // 检查是否有订单号特征
      const orderSn = obj.orderSn || obj.order_sn || obj.orderSnStr || obj.order_sn_str || '';
      const orderStatus = obj.orderStatus || obj.order_status || obj.orderState || obj.order_state || obj.status || '';
      const logistics = obj.logistics || obj.tracking || obj.express || obj.shipping || null;
      const logisticsCompany = obj.logisticsCompany || obj.expressCompany || obj.express_company || '';
      const logisticsNo = obj.logisticsNo || obj.trackingNo || obj.tracking_no || obj.expressNo || obj.express_no || obj.waybillCode || '';
      const goodsName = obj.goodsName || obj.goods_name || obj.goodsTitle || obj.goods_title || obj.productName || '';
      const amount = obj.amount || obj.payAmount || obj.pay_amount || obj.orderAmount || obj.order_amount || '';
      const buyerName = obj.buyerName || obj.buyer_name || obj.userName || obj.user_name || '';
      const createTime = obj.createTime || obj.create_time || obj.orderTime || obj.order_time || '';
      const afterSaleStatus = obj.afterSaleStatus || obj.after_sale_status || obj.refundStatus || obj.refund_status || '';

      // 有订单号就算有效
      if (orderSn && orderSn.length > 5) {
        const info = {
          order_sn: String(orderSn),
          order_status: String(orderStatus || ''),
          goods_name: String(goodsName || ''),
          amount: String(amount || ''),
          buyer_name: String(buyerName || ''),
          create_time: String(createTime || ''),
          after_sale_status: String(afterSaleStatus || '')
        };

        // 物流信息
        if (logistics && typeof logistics === 'object') {
          info.logistics_company = String(logistics.company || logisticsCompany || '');
          info.logistics_no = String(logistics.trackingNo || logisticsNo || '');
          info.logistics_status = String(logistics.status || logistics.state || '');
        } else if (logisticsNo) {
          info.logistics_company = String(logisticsCompany || '');
          info.logistics_no = String(logisticsNo);
        }

        // 去重（同 order_sn 只保留最新一条）
        const existing = results.find((r) => r.order_sn === info.order_sn);
        if (existing) {
          // 合并更新（后到的物流信息覆盖）
          Object.assign(existing, info);
        } else {
          results.push(info);
        }
      }

      // 递归子对象
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (val && typeof val === 'object') {
          deepExtract(val, _depth + 1);
        }
      }
    }

    deepExtract(parsed, 0);

    // 也尝试从 sample 中提取（兜底：sample 是 args 的字符串截断）
    if (results.length === 0) {
      const sampleArr = event?.payload?.sample || [];
      for (const s of sampleArr) {
        if (typeof s !== 'string') continue;
        try {
          const parsedSample = JSON.parse(s);
          deepExtract(parsedSample, 0);
        } catch {
          // 尝试正则匹配订单号（拼多多格式：日期-数字 或 18-30位纯数字）
          const orderMatches = s.match(/\b(\d{6}-\d{15,30}|\d{18,30})\b/g);
          if (orderMatches) {
            for (const m of orderMatches) {
              if (!results.find((r) => r.order_sn === m)) {
                results.push({ order_sn: m, order_status: '', goods_name: '' });
              }
            }
          }
          // 也尝试匹配物流单号
          const expressMatches = s.match(EXPRESS_NO_RE);
          if (expressMatches) {
            for (const m of expressMatches) {
              // 找一个已有的 order 或新建
              const existing = results.length > 0 ? results[results.length - 1] : null;
              if (existing && !existing.logistics_no) {
                existing.logistics_no = m;
              } else if (!results.find((r) => r.logistics_no === m)) {
                results.push({ order_sn: '', order_status: '', goods_name: '', logistics_no: m });
              }
            }
          }
        }
      }
    }

    return results.length > 0 ? results : null;
  } catch (_) {
    return null;
  }
}

function buildLayerSurveyInstallExpression(target) {
  const label = `${target?.title || ''} | ${target?.url || ''}`;
  return `(() => {
    const targetLabel = ${jsStringFromText(label)};
    const queue = window.__pddLgLayerSurveyQueue = window.__pddLgLayerSurveyQueue || [];
    const sample = (value) => {
      try {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return String(text || '').slice(0, 400);
      } catch (error) {
        return String(value || '');
      }
    };
    const tryParse = (value) => {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };
    const summarize = (node) => {
      if (!node) return '';
      const text = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
      return {
        tag: String(node.tagName || '').toLowerCase(),
        className: String(node.className || '').slice(0, 120),
        text: text.slice(0, 120)
      };
    };
    const push = (name, payload = {}) => {
      queue.push({
        name,
        time: Date.now(),
        label: targetLabel,
        href: String(location.href || ''),
        title: String(document.title || ''),
        payload
      });
      if (queue.length > 200) queue.splice(0, queue.length - 200);
    };
    const globals = () => ({
      socketUtil: Boolean(window.socketUtil?.sendMsg),
      pinnotification: Boolean(window.pinnotification),
      onNativeEvent: Boolean(window.OnNativeEvent),
      webpackChunk: Object.keys(window).some((key) => /^webpackChunk/.test(key)),
      iframeCount: document.querySelectorAll('iframe,webview').length
    });
    const listFrames = () => Array.from(document.querySelectorAll('iframe,webview')).slice(0, 10).map((node) => ({
      tag: String(node.tagName || '').toLowerCase(),
      src: String(node.getAttribute('src') || node.src || '').slice(0, 300),
      name: String(node.getAttribute('name') || '').slice(0, 120),
      className: String(node.className || '').slice(0, 120)
    }));
    const wrapNativeBridge = () => {
      const bridge = window.pinnotification;
      if (!bridge || window.__pddLgLayerSurveyNativeWrapped) return;
      window.__pddLgLayerSurveyNativeWrapped = true;
      for (const key of Object.keys(bridge)) {
        const native = bridge[key];
        if (typeof native !== 'function') continue;
        try {
          bridge[key] = function wrappedPinnotificationMethod(...args) {
            const eventName = String(args[0] || '');
            const parsedPayload = tryParse(args[1]);
            push('pinnotification-call', {
              method: String(key || ''),
              eventName,
              sample: args.map((item) => sample(item)).slice(0, 4),
              parsed: parsedPayload
            });
            return native.apply(this, args);
          };
        } catch (error) {
          push('pinnotification-wrap-error', {
            method: String(key || ''),
            error: String(error && error.message || error || '')
          });
        }
      }
    };
    const installFrameProbe = (frameWindow, frameLabel, depth = 1) => {
      if (!frameWindow || depth > 3) return;
      if (frameWindow.__pddLgLayerSurveyInstalled) return;
      frameWindow.__pddLgLayerSurveyInstalled = true;
      try {
        frameWindow.addEventListener('message', (event) => {
          push('frame-window-message', {
            frameLabel,
            depth,
            origin: String(event.origin || ''),
            sample: sample(event.data)
          });
        }, true);
      } catch {}
      try {
        frameWindow.document?.addEventListener('click', (event) => {
          const node = event.target?.closest?.('button,a,[role="button"],li,div,span') || event.target;
          push('frame-click', {
            frameLabel,
            depth,
            target: summarize(node)
          });
        }, true);
      } catch (error) {
        push('frame-install-error', {
          frameLabel,
          depth,
          stage: 'click-listener',
          error: String(error && error.message || error || '')
        });
      }
      try {
        const frameBridge = frameWindow.pinnotification;
        if (frameBridge && !frameWindow.__pddLgLayerSurveyNativeWrapped) {
          frameWindow.__pddLgLayerSurveyNativeWrapped = true;
          for (const key of Object.keys(frameBridge)) {
            const native = frameBridge[key];
            if (typeof native !== 'function') continue;
            frameBridge[key] = function wrappedFramePinnotification(...args) {
              const eventName = String(args[0] || '');
              const parsedPayload = tryParse(args[1]);
              push('frame-pinnotification-call', {
                frameLabel,
                depth,
                method: String(key || ''),
                eventName,
                sample: args.map((item) => sample(item)).slice(0, 4),
                parsed: parsedPayload
              });
              return native.apply(this, args);
            };
          }
        }
      } catch (error) {
        push('frame-install-error', {
          frameLabel,
          depth,
          stage: 'pinnotification',
          error: String(error && error.message || error || '')
        });
      }
      try {
        Array.from(frameWindow.document?.querySelectorAll?.('iframe,webview') || []).slice(0, 10).forEach((childNode, index) => {
          try {
            const childWindow = childNode.contentWindow;
            if (!childWindow) return;
            const childLabel = frameLabel + ' > ' + (childNode.getAttribute('name') || childNode.getAttribute('src') || ('child-' + index));
            installFrameProbe(childWindow, String(childLabel).slice(0, 300), depth + 1);
          } catch (error) {
            push('frame-child-access-error', {
              frameLabel,
              depth,
              index,
              error: String(error && error.message || error || '')
            });
          }
        });
      } catch {}
    };
    const installNestedFrameProbes = () => {
      Array.from(document.querySelectorAll('iframe,webview')).slice(0, 10).forEach((node, index) => {
        try {
          const frameWindow = node.contentWindow;
          if (!frameWindow) {
            push('frame-missing-window', {
              index,
              tag: String(node.tagName || '').toLowerCase(),
              src: String(node.getAttribute('src') || node.src || '').slice(0, 300)
            });
            return;
          }
          const frameLabel = String(node.getAttribute('name') || node.getAttribute('src') || node.src || ('frame-' + index)).slice(0, 300);
          installFrameProbe(frameWindow, frameLabel, 1);
        } catch (error) {
          push('frame-access-error', {
            index,
            tag: String(node.tagName || '').toLowerCase(),
            src: String(node.getAttribute('src') || node.src || '').slice(0, 300),
            error: String(error && error.message || error || '')
          });
        }
      });
    };
    if (window.__pddLgLayerSurveyInstalled) {
      return { ok: true, reused: true, label: targetLabel, globals: globals() };
    }
    window.__pddLgLayerSurveyInstalled = true;
    wrapNativeBridge();
    push('probe-installed', { globals: globals(), readyState: document.readyState, frames: listFrames() });

    document.addEventListener('click', (event) => {
      const node = event.target?.closest?.('button,a,[role="button"],li,div,span') || event.target;
      push('click', { target: summarize(node) });
    }, true);

    window.addEventListener('message', (event) => {
      push('window-message', { origin: String(event.origin || ''), sample: sample(event.data) });
    }, true);

    if (typeof window.OnNativeEvent === 'function' && !window.__pddFukeLayerSurveyOnNativeWrapped) {
      window.__pddFukeLayerSurveyOnNativeWrapped = true;
      const nativeOnNativeEvent = window.OnNativeEvent;
      window.OnNativeEvent = function wrappedOnNativeEvent(...args) {
        push('on-native-event', { sample: args.map((item) => sample(item)).slice(0, 4) });
        return nativeOnNativeEvent.apply(this, args);
      };
    }

    installNestedFrameProbes();
    setTimeout(installNestedFrameProbes, 500);
    setTimeout(installNestedFrameProbes, 1500);

    if (window.fetch && !window.__pddLgLayerSurveyFetchPatched) {
      window.__pddLgLayerSurveyFetchPatched = true;
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (...args) => {
        const input = args[0];
        const url = typeof input === 'string' ? input : String(input?.url || '');
        push('fetch-request', { url });
        return nativeFetch(...args).then((response) => {
          push('fetch-response', { url, status: Number(response?.status || 0) });
          return response;
        });
      };
    }

    if (window.XMLHttpRequest && !window.__pddLgLayerSurveyXhrPatched) {
      window.__pddLgLayerSurveyXhrPatched = true;
      const nativeOpen = XMLHttpRequest.prototype.open;
      const nativeSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
        this.__pddLgLayerSurveyUrl = String(url || '');
        push('xhr-open', { method: String(method || ''), url: this.__pddLgLayerSurveyUrl });
        return nativeOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function patchedSend(...rest) {
        const currentUrl = String(this.__pddLgLayerSurveyUrl || '');
        this.addEventListener('load', () => {
          push('xhr-load', { url: currentUrl, status: Number(this.status || 0) });
        }, { once: true });
        return nativeSend.apply(this, rest);
      };
    }

    return {
      ok: true,
      reused: false,
      label: targetLabel,
      href: String(location.href || ''),
      title: String(document.title || ''),
      globals: globals()
    };
  })()`;
}

function buildLayerSurveyDrainExpression() {
  return `(() => {
    const queue = window.__pddLgLayerSurveyQueue || [];
    return {
      events: queue.splice(0, queue.length)
    };
  })()`;
}

function assertTaskkillAllowed(result) {
  if (!result || typeof result !== 'object') return;
  const exitCode = result.exitCode ?? result.exit_code;
  if (!exitCode) return;
  const text = `${result.stderr || ''}\n${result.output || ''}`;
  if (!/(拒绝访问|access\s+is\s+denied|access\s+denied)/i.test(text)) return;

  const error = new Error(`taskkill failed: ${text.trim()}`);
  error.code = 'PDD_TASKKILL_ACCESS_DENIED';
  throw error;
}

module.exports = {
  PddManager,
  HelperClient,
  DEFAULT_ARGS,
  DEFAULT_INJECT_DIR,
  DEFAULT_HELPER_PATH,
  DEFAULT_HELPER_INVOKE_TIMEOUT_MS,
  selectLayerSurveyTargets,
  scoreLayerSurveyTarget
};
