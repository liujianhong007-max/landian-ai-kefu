'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { HelperClient } = require('./pdd-manager');
const { findProcessByName } = require('./win32-helper');

const DEFAULT_QN_VERSION = '9.95.00';
const DEFAULT_QN_DLL_PATH = `D:\\Program Files\\fuke\\assets\\inject\\QnExtend-${DEFAULT_QN_VERSION}.dll`;
const DEFAULT_QN_CSHARP_HELPER_PATH = path.join(__dirname, '..', 'helper-csharp', 'bin', 'PddFukeHelper.exe');
const DEFAULT_QN_FUKE_HELPER_PATH = 'D:\\Program Files\\fuke\\assets\\inject\\fuke-helper.exe';
const noopLogger = { log() {}, error() {} };

function resolveDefaultQnHelperPath(options = {}) {
  if (options.helperPath) return options.helperPath;
  if (process.env.QN_CSHARP_HELPER_EXE) return process.env.QN_CSHARP_HELPER_EXE;
  if (process.env.QN_FUKE_HELPER_EXE) return process.env.QN_FUKE_HELPER_EXE;
  if (process.env.QN_LG_HELPER_EXE) return process.env.QN_LG_HELPER_EXE;
  return DEFAULT_QN_CSHARP_HELPER_PATH;
}

class QnManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.exePath = options.exePath || process.env.QN_WORKBENCH_EXE || '';
    this.dllPath = options.dllPath || process.env.QN_FUKE_DLL || process.env.QN_LG_DLL || '';
    const HelperClientClass = options.HelperClient || HelperClient;
    this.helperClient = options.helperClient || new HelperClientClass({
      helperPath: resolveDefaultQnHelperPath(options),
      spawn: options.helperSpawn,
      logger: options.logger || noopLogger
    });
    const hasCustomProcessFinder = Boolean(options.processFinder);
    this.processFinder = options.processFinder || (() => findProcessByName('AliWorkbench.exe'));
    this.exitProcessFinders = options.exitProcessFinders || (hasCustomProcessFinder
      ? [this.processFinder]
      : [
          this.processFinder,
          () => findProcessByName('AliRender.exe')
        ]);
    this.windowFinder = options.windowFinder || (async () => []);
    this.logger = options.logger || noopLogger;
    this.wsPort = options.wsPort || null;
    this.jsUrl = options.jsUrl || process.env.JS_URL || '';
    this.monitorTimer = null;
    this.launchCooldownMs = options.launchCooldownMs ?? Number(process.env.PDD_FUKE_QN_LAUNCH_COOLDOWN_MS || 60 * 1000);
    this.lastLaunchAt = 0;
    this.launchInFlight = null;
    this.status = {
      running: false,
      pid: null,
      exePath: this.exePath,
      windows: [],
      lastError: null
    };
  }

  async resolveExePath() {
    if (this.exePath && fs.existsSync(this.exePath)) return this.exePath;

    const running = await this.processFinder().catch(() => []);
    const runningPath = running.find((process) => process?.ExecutablePath)?.ExecutablePath;
    if (runningPath && fs.existsSync(runningPath)) {
      this.exePath = runningPath;
      this.status.exePath = runningPath;
      return runningPath;
    }

    const localAppData = process.env.LOCALAPPDATA || '';
    const versions = [DEFAULT_QN_VERSION, '9.63.20'];

    // OSS 按需下载目录（优先级最高）
    const ossBase = path.join(localAppData, 'pdd-fuke', 'workbenches', 'qn');
    if (fs.existsSync(ossBase)) {
      try {
        const ossVersions = fs.readdirSync(ossBase, { withFileTypes: true })
          .filter((d) => d.isDirectory());
        for (const ver of ossVersions.reverse()) {
          const exePath = path.join(ossBase, ver.name, 'extracted', 'AliWorkbench.exe');
          if (fs.existsSync(exePath)) {
            this.exePath = exePath;
            this.status.exePath = exePath;
            return exePath;
          }
        }
      } catch (_) {}
    }

    const candidates = [
      ...versions.map((version) => path.join(localAppData, 'huihui', 'qn', version, 'AliWorkbench.exe')),
      ...versions.map((version) => path.join(localAppData, 'lg', 'qn', version, 'AliWorkbench.exe')),
      ...versions.map((version) => path.join(localAppData, 'qn', version, 'AliWorkbench.exe')),
      path.join(process.env.PROGRAMFILES || '', 'AliWorkbench', 'AliWorkbench.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'AliWorkbench', 'AliWorkbench.exe')
    ].filter(Boolean);

    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) {
      this.exePath = found;
      this.status.exePath = found;
    }

    return this.exePath;
  }

  resolveDllPath(exePath = this.exePath) {
    if (this.dllPath) return this.dllPath;
    const match = String(exePath || '').match(/\\qn\\([^\\]+)\\AliWorkbench\.exe$/i);
    const version = match?.[1] || DEFAULT_QN_VERSION;
    return `D:\\Program Files\\fuke\\assets\\inject\\QnExtend-${version}.dll`;
  }

  async launch() {
    if (this.launchInFlight) {
      this.logger.log('[qn:launch-skip]', { reason: 'in-flight' });
      return this.launchInFlight;
    }
    if (this.status.running && this.status.pid && this.launchCooldownMs > 0 && Date.now() - this.lastLaunchAt < this.launchCooldownMs) {
      this.logger.log('[qn:launch-skip]', { reason: 'cooldown', pid: this.status.pid, cooldownMs: this.launchCooldownMs });
      return this.status;
    }

    this.launchInFlight = this.doLaunch();
    try {
      return await this.launchInFlight;
    } finally {
      this.launchInFlight = null;
    }
  }

  async doLaunch() {
    this.logger.log('[qn:launch]', { exePath: this.exePath });
    const exePath = await this.resolveExePath();
    if (!exePath || !fs.existsSync(exePath)) {
      const error = new Error('AliWorkbench.exe was not found. Set QN_WORKBENCH_EXE to the installed executable path.');
      this.status.lastError = error.message;
      this.logger.error('[qn:launch-error]', error);
      this.emit('error', error);
      throw error;
    }

    let data;
    try {
      try {
        await this.killQnProcesses();
        await this.waitForQnProcessesExit();
      } catch (error) {
        this.logger.error('[qn:taskkill-error]', error);
      }

      const launchParam = {
        exe_path: exePath,
        exe_param: '',
        user_power: true,
        inject_dllpath: this.resolveDllPath(exePath),
        use_devtool: true,
        js_url: this.jsUrl,
        js_data: String(this.wsPort ?? '')
      };
      if (process.env.PDD_FUKE_INJECT_MODE || process.env.PDD_LG_INJECT_MODE) {
        launchParam.inject_mode = process.env.PDD_FUKE_INJECT_MODE || process.env.PDD_LG_INJECT_MODE;
      }
      this.logger.log('[qn:launch-params]', launchParam);
      data = await this.helperClient.launchPlatform(launchParam);
    } catch (error) {
      this.status.running = false;
      this.status.pid = null;
      this.status.lastError = error.message;
      this.logger.error('[qn:launch-error]', error);
      this.emit('error', error);
      throw error;
    }

    this.status.running = true;
    this.status.pid = data?.pid || null;
    this.lastLaunchAt = Date.now();
    this.status.lastError = null;
    this.emit('launched', this.status);
    return this.status;
  }

  async killQnProcesses() {
    const processNames = ['AliWorkbench.exe', 'AliRender.exe', 'AlibabaProtect.exe'];
    for (const processName of processNames) {
      try {
        await this.helperClient.executeShell(`taskkill /F /IM ${processName}`);
      } catch (error) {
        this.logger.error('[qn:taskkill-process-error]', error);
      }
    }
  }

  async listQnProcesses() {
    const batches = await Promise.all(this.exitProcessFinders.map((finder) => finder().catch(() => [])));
    return batches.flat();
  }

  async waitForQnProcessesExit({ timeoutMs = 10000, intervalMs = 300 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const processes = await this.listQnProcesses();
      if (processes.length === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    this.logger.error('[qn:taskkill-wait-timeout]', new Error('AliWorkbench/AliRender still exists after taskkill.'));
    return false;
  }

  async refreshStatus() {
    try {
      const [processes, windows] = await Promise.all([
        this.processFinder(),
        this.windowFinder()
      ]);
      const process = processes[0] || null;
      this.status.running = processes.length > 0;
      this.status.pid = process?.ProcessId || process?.pid || null;
      this.status.exePath = process?.ExecutablePath || this.exePath;
      this.status.windows = windows;
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
    this.monitorTimer.unref?.();
  }

  stopMonitoring() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  stop() {
    this.stopMonitoring();
    this.helperClient?.stop?.();
  }
}

module.exports = {
  QnManager,
  DEFAULT_QN_VERSION,
  DEFAULT_QN_DLL_PATH,
  DEFAULT_QN_CSHARP_HELPER_PATH,
  DEFAULT_QN_FUKE_HELPER_PATH,
  DEFAULT_QN_LG_HELPER_PATH: DEFAULT_QN_FUKE_HELPER_PATH,
  resolveDefaultQnHelperPath
};
