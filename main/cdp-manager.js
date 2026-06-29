'use strict';

const WebSocket = require('ws');
const { execFile } = require('node:child_process');
const http = require('node:http');
const { findProcessByName } = require('./win32-helper');

const DEFAULT_CDP_URL = 'ws://127.0.0.1:19999';
const FALLBACK_CDP_PORTS = [9222, 9229];
const RANDOM_CDP_SCAN_PORTS = [
  ...range(9220, 9230),
  ...range(19990, 20000)
];
const noopLogger = { log() {}, error() {} };

class CdpManager {
  constructor({
    url = DEFAULT_CDP_URL,
    WebSocket: WebSocketImpl = WebSocket,
    scanPddWebWorkbenchPorts = defaultScanPddWebWorkbenchPorts,
    httpGetJson = defaultHttpGetJson,
    resolveDebuggingPort = false,
    logger = noopLogger
  } = {}) {
    this.url = url;
    this.WebSocket = WebSocketImpl;
    this.scanPddWebWorkbenchPorts = scanPddWebWorkbenchPorts;
    this.httpGetJson = httpGetJson;
    this.resolveDebuggingPort = resolveDebuggingPort;
    this.logger = logger;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
  }

  connect() {
    return this.connectToUrl(this.url);
  }

  async connectWithFallback() {
    const fallbackConnectOptions = { resolveDebuggingPort: this.shouldResolveDebuggingPortInFallback() };
    const urls = [this.url];
    for (const port of FALLBACK_CDP_PORTS) {
      urls.push(cdpUrlForPort(port));
    }
    const attemptedUrls = new Set();
    let lastError = null;

    for (const url of [...new Set(urls)]) {
      attemptedUrls.add(url);
      try {
        this.logger.log('[cdp:connect-attempt]', { url });
        return await this.connectToUrl(url, fallbackConnectOptions);
      } catch (error) {
        lastError = error;
        this.logger.error('[cdp:error]', { url, error: error.message });
      }
    }

    const scannedPorts = await this.scanPddWebWorkbenchPorts().catch((error) => {
      this.logger.error('[cdp:scan-error]', error);
      return [];
    });
    for (const item of scannedPorts) {
      const url = cdpUrlForPort(item.port);
      if (attemptedUrls.has(url)) continue;
      attemptedUrls.add(url);

      try {
        this.logger.log('[cdp:connect-attempt]', { url, pid: item.pid });
        return await this.connectToUrl(url, fallbackConnectOptions);
      } catch (error) {
        lastError = error;
        this.logger.error('[cdp:error]', { url, pid: item.pid, error: error.message });
      }
    }

    for (const port of RANDOM_CDP_SCAN_PORTS) {
      const url = cdpUrlForPort(port);
      if (attemptedUrls.has(url)) continue;
      attemptedUrls.add(url);

      try {
        this.logger.log('[cdp:connect-attempt]', { url });
        return await this.connectToUrl(url, fallbackConnectOptions);
      } catch (error) {
        lastError = error;
        this.logger.error('[cdp:error]', { url, error: error.message });
      }
    }

    throw lastError || new Error('No CDP endpoint found');
  }

  shouldResolveDebuggingPortInFallback() {
    return this.resolveDebuggingPort || this.httpGetJson !== defaultHttpGetJson || this.WebSocket === WebSocket;
  }

  connectToUrl(url, options = {}) {
    const resolveDebuggingPort = options.resolveDebuggingPort ?? this.resolveDebuggingPort;
    if (resolveDebuggingPort && isDebuggingPortUrl(url)) {
      return this.resolvePageWebSocketUrl(url).then((resolvedUrl) => this.connectToUrl(resolvedUrl));
    }

    if (this.connected && this.socket && this.url === url) {
      return Promise.resolve({ connected: true, url: this.url });
    }

    return new Promise((resolve, reject) => {
      const socket = new this.WebSocket(url);
      this.socket = socket;

      const cleanupStartup = () => {
        socket.off('open', onOpen);
        socket.off('error', onStartupError);
      };
      const onOpen = () => {
        cleanupStartup();
        this.connected = true;
        this.url = url;
        socket.on('message', (buffer) => this.handleMessage(buffer));
        socket.on('close', () => this.handleClose());
        socket.on('error', (error) => this.handleError(error));
        resolve({ connected: true, url: this.url });
      };
      const onStartupError = (error) => {
        cleanupStartup();
        this.socket = null;
        reject(error);
      };

      socket.once('open', onOpen);
      socket.once('error', onStartupError);
    });
  }

  async resolvePageWebSocketUrl(url) {
    const port = portFromCdpUrl(url);
    const targets = await this.listPageTargetsForPort(port);
    const target = selectPddChatTarget(Array.isArray(targets) ? targets : []);
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(`No debuggable PDD page target found on port ${port}`);
    }
    this.logger.log('[cdp:target-selected]', {
      port,
      title: target.title,
      url: target.url,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl
    });
    return target.webSocketDebuggerUrl;
  }

  async listPageTargets(url = this.url) {
    const port = portFromCdpUrl(url);
    return this.listPageTargetsForPort(port);
  }

  async listPageTargetsForPort(port) {
    return this.httpGetJson(`http://127.0.0.1:${Number(port)}/json/list`);
  }

  disconnect() {
    if (!this.socket) {
      this.connected = false;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const socket = this.socket;
      socket.once('close', resolve);
      socket.close();
      this.handleClose();
    });
  }

  execute(method, params = {}) {
    if (!this.socket || !this.connected || this.socket.readyState !== this.WebSocket.OPEN) {
      return Promise.reject(new Error('CDP connection is not open'));
    }

    const id = this.nextId++;
    const payload = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async getTargets() {
    const result = await this.execute('Target.getTargets');
    return result.targetInfos || [];
  }

  async executeOnWebSocketUrl(url, method, params = {}) {
    const resolvedUrl = isDebuggingPortUrl(url)
      ? await this.resolvePageWebSocketUrl(url)
      : String(url || '');
    if (!resolvedUrl) {
      throw new Error('Missing CDP target websocket url');
    }
    if (this.connected && this.socket && this.url === resolvedUrl) {
      return this.execute(method, params);
    }
    return executeCdpCommand({
      url: resolvedUrl,
      method,
      params,
      WebSocketImpl: this.WebSocket
    });
  }

  handleMessage(buffer) {
    const message = JSON.parse(buffer.toString());
    if (!message || !message.id || !this.pending.has(message.id)) return;

    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      return;
    }

    pending.resolve(message.result || {});
  }

  handleClose() {
    this.connected = false;
    this.socket = null;
    const error = new Error('CDP connection closed');
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  handleError(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function createCdpManager(options) {
  return new CdpManager(options);
}

function executeCdpCommand({
  url,
  method,
  params = {},
  WebSocketImpl = WebSocket
}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    let settled = false;
    let requestId = 1;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
      try {
        if (socket.readyState === WebSocketImpl.OPEN || socket.readyState === WebSocketImpl.CONNECTING) {
          socket.close();
        }
      } catch {}
    };

    const cleanup = () => {
      socket.off('open', onOpen);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    const onOpen = () => {
      socket.send(JSON.stringify({
        id: requestId,
        method,
        params
      }), (error) => {
        if (error) finish(reject, error);
      });
    };

    const onMessage = (buffer) => {
      let message;
      try {
        message = JSON.parse(buffer.toString());
      } catch (error) {
        finish(reject, error);
        return;
      }
      if (!message || message.id !== requestId) return;
      if (message.error) {
        finish(reject, new Error(message.error.message || JSON.stringify(message.error)));
        return;
      }
      finish(resolve, message.result || {});
    };

    const onError = (error) => finish(reject, error);
    const onClose = () => {
      if (!settled) finish(reject, new Error('CDP temporary session closed'));
    };

    socket.once('open', onOpen);
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function cdpUrlForPort(port) {
  return `ws://127.0.0.1:${Number(port)}`;
}

function isDebuggingPortUrl(url) {
  return /^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(String(url || ''));
}

function portFromCdpUrl(url) {
  const parsed = new URL(url);
  return Number(parsed.port);
}

function selectPddChatTarget(targets) {
  const candidates = targets.filter((target) => target?.webSocketDebuggerUrl);
  return candidates.find((target) => /聊天详情|middle_panel/i.test(`${target.title || ''} ${target.url || ''}`)) ||
    candidates.find((target) => /conversation|chat/i.test(`${target.title || ''} ${target.url || ''}`)) ||
    candidates.find((target) => /mms\.pinduoduo\.com/i.test(target.url || '')) ||
    candidates[0] ||
    null;
}

function range(start, end) {
  const values = [];
  for (let port = start; port <= end; port += 1) {
    values.push(port);
  }
  return values;
}

function runNetstat() {
  return new Promise((resolve, reject) => {
    execFile('netstat.exe', ['-ano'], { windowsHide: true, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function defaultHttpGetJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 3000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(`HTTP timeout from ${url}`));
    });
    request.on('error', reject);
  });
}

function parseListeningPorts(netstatOutput) {
  const ports = [];
  for (const line of String(netstatOutput || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue;

    const local = parts[1];
    const pid = Number(parts[4]);
    const portMatch = local.match(/:(\d+)$/);
    if (!Number.isFinite(pid) || !portMatch) continue;

    ports.push({
      address: local.slice(0, -portMatch[0].length),
      port: Number(portMatch[1]),
      pid
    });
  }
  return ports;
}

async function defaultScanPddWebWorkbenchPorts({
  processFinder = findProcessByName,
  netstat = runNetstat
} = {}) {
  const processes = await processFinder('pddwebworkbench.exe');
  const pids = new Set(processes.map((process) => Number(process.ProcessId || process.pid || process.Id)).filter(Number.isFinite));
  if (pids.size === 0) return [];

  const listeningPorts = parseListeningPorts(await netstat());
  return listeningPorts.filter((item) => pids.has(item.pid));
}

const defaultManager = createCdpManager();

module.exports = {
  DEFAULT_CDP_URL,
  FALLBACK_CDP_PORTS,
  CdpManager,
  cdpUrlForPort,
  selectPddChatTarget,
  parseListeningPorts,
  scanPddWebWorkbenchPorts: defaultScanPddWebWorkbenchPorts,
  createCdpManager,
  connect: () => defaultManager.connectWithFallback(),
  disconnect: () => defaultManager.disconnect(),
  execute: (method, params) => defaultManager.execute(method, params),
  getTargets: () => defaultManager.getTargets()
};
