'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { InternalWebSocketServer } = require('./websocket');
const { PddManager } = require('./pdd-manager');
const { QnManager } = require('./qn-manager');
const { createCdpManager } = require('./cdp-manager');
const { createFileLogger } = require('./logger');
const { WbChatWatcher } = require('./wbchat-watcher');
const { createDiagnosticsSnapshot } = require('./diagnostics-snapshot');
const { readAiSettings, saveAiSettings } = require('./ai-settings-store');
const { readCache: readAgentConfigCache, writeCache: writeAgentConfigCache } = require('./agent-config-cache');
const chatHandlers = require('./chat-handlers');
const observers = require('./pdd-observers');
const bridgeRuntime = require('./pdd-bridge-runtime');
const { requestTmagentChat, buildTmagentChatPayload, buildOrderInfoPayload, createOrderCache } = require('./tmagent-client');
const { createOssVersionManager, formatBytes } = require('./oss-version-manager');

let mainWindow = null;
let floatingWindow = null;
let productLibraryWindow = null;
let aiSettingsWindow = null;
let loginWindow = null;
let versionManagerWindow = null;
let loginState = { token: null, user: null, loggedIn: false };
let wsServer = null;
let bridgeServer = null;
let pddManager = null;
let qnManager = null;
let wbChatWatcher = null;
let bridgeObservationState = observers.createBridgeObservationState();
let ossVersionManager = null;

const logger = createFileLogger();
const noopLogger = { log() {}, error() {} };

const FLOATING_PLUGIN_SIZE = { width: 320, height: 640 };
const FLOATING_PLUGIN_GAP = 8;

const conversationHandoffStore = chatHandlers.createConversationHandoffStore({
  onChange(snapshot) {
    sendToRenderer('conversation:manual-state', snapshot);
  }
});

// 全局订单缓存：right_panel 探针抓取到的订单数据，供 autoReply 构建 payload 时查询
const globalOrderCache = createOrderCache();

// 新的 auth 接口地址（xingqiao.taluo.club）
// 使用 HTTPS，因为 HTTP 会被 nginx 301 重定向到 HTTPS
const AUTH_API_BASE_URL = 'https://xingqiao.taluo.club';

function httpsRequest(options, _redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const http = require('node:http');
    const url = new URL(options.url);
    const payload = options.body || null;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (payload) {
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers,
      rejectUnauthorized: false,
      timeout: options.timeout || 30000
    };

    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(reqOptions, (res) => {
      // 处理重定向 (301/302/307/308)
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (_redirectCount >= MAX_REDIRECTS) {
          reject(new Error(`重定向次数过多 (${_redirectCount})`));
          return;
        }
        const redirectUrl = res.headers.location;
        logger.log('[httpsRequest:redirect]', { from: options.url, to: redirectUrl, statusCode: res.statusCode, method: options.method });
        // 301/302: 浏览器通常会改为 GET；307/308: 保持原 method
        // 但针对 HTTP→HTTPS 升级场景，nginx 301 时需要保持原 method 重新请求
        const newMethod = (res.statusCode === 307 || res.statusCode === 308)
          ? options.method
          : options.method; // 保持原 method 不变（nginx HTTP→HTTPS 重定向需要这样）
        httpsRequest({ ...options, url: redirectUrl, method: newMethod }, _redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* ignore */ }
        // 响应体无法解析为 JSON → 记录日志后直接 reject，不 fallback 任何假数据
        if (parsed === null && data && data.length > 0) {
          logger.log('[httpsRequest:non-json-response]', {
            url: options.url,
            method: options.method,
            statusCode: res.statusCode,
            contentType: res.headers['content-type'],
            bodyPreview: data.substring(0, 200)
          });
          reject(new Error(`服务器返回了非 JSON 响应 (${res.statusCode})`));
          return;
        }
        // 允许调用方自定义特定状态码的处理
        if (typeof options.onStatus === 'function') {
          const customMsg = options.onStatus(res.statusCode, parsed);
          if (customMsg) {
            reject(new Error(customMsg));
            return;
          }
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(parsed?.detail || parsed?.message || `HTTP ${res.statusCode}`));
          return;
        }
        // 空响应体 → 返回空对象（兼容某些接口无 body 的场景）
        resolve(parsed || {});
      });
    });

    req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function proxyTmagentRequest(payload = {}) {
  const baseUrl = String(payload.baseUrl || '').trim().replace(/\/+$/, '');
  const requestPath = String(payload.path || '').trim();
  const method = String(payload.method || 'GET').toUpperCase();
  const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};

  if (!baseUrl) throw new Error('请先在 API设置与日志 里配置 Base URL');
  if (!requestPath.startsWith('/')) throw new Error('请求路径不合法');

  // 如果 baseUrl 是 http:// 开头，自动升级为 https://
  const finalUrl = baseUrl.startsWith('http://')
    ? baseUrl.replace(/^http:\/\//, 'https://') + requestPath
    : `${baseUrl}${requestPath}`;

  return httpsRequest({
    url: finalUrl,
    method,
    headers,
    body: payload.body
  });
}

function authFetch(path, body) {
  return httpsRequest({
    url: `${AUTH_API_BASE_URL}${path}`,
    method: 'POST',
    body: JSON.stringify(body),
    onStatus: (statusCode) => {
      if (statusCode === 409) {
        return '该手机号已注册，请直接登录';
      }
      return null;
    }
  });
}

async function handleLogin(payload) {
  const mobile = String(payload?.mobile || '').trim();
  const password = String(payload?.password || '').trim();
  if (!mobile || !password) throw new Error('手机号和密码不能为空');

  // 调用 xingqiao.taluo.club 登录接口
  const result = await authFetch('/api/auth/login', { mobile, password });
  // 响应格式: { mobile, apiKey, tmagentApiKey, bearerToken, tenantId, agentId, agentConfig }
  const bearerToken = result?.bearerToken;
  if (!bearerToken) throw new Error('登录返回数据异常，缺少 bearerToken');

  loginState = {
    token: bearerToken,
    user: {
      mobile: result.mobile || mobile,
      tenantId: result.tenantId || '',
      agentId: result.agentId || ''
    },
    loggedIn: true
  };
  logger.log('[login:success]', { mobile, tenantId: result.tenantId });

  // 登录成功后自动保存 apiKey 到 AI 设置
  if (result.apiKey) {
    try {
      const currentSettings = readAiSettings();
      currentSettings.apiKey = String(result.apiKey).trim();
      currentSettings.tenantId = String(result.tenantId || '').trim();
      currentSettings.merchantName = String(result.mobile || '').trim();
      currentSettings.baseUrl = String(result.baseUrl || currentSettings.baseUrl || '').trim();
      saveAiSettings(currentSettings);
      logger.log('[login:auto-save-settings]', { apiKey: result.apiKey.substring(0, 8) + '...' });
    } catch (err) {
      logger.log('[login:auto-save-settings-error]', err.message);
    }

    // 登录成功后自动拉取云端 AI客服配置 并缓存到本地
    fetchAndCacheAgentConfig(result).catch((err) => {
      logger.log('[login:fetch-agent-config-error]', err.message);
    });
  }

  return { token: bearerToken, user: loginState.user };
}

async function handleRegister(payload) {
  const mobile = String(payload?.mobile || '').trim();
  const password = String(payload?.password || '').trim();
  if (!mobile || !password) throw new Error('手机号和密码不能为空');

  // 调用注册接口（无需鉴权）
  const result = await authFetch('/api/auth/register', { mobile, password });
  // 响应格式与登录一致: { mobile, apiKey, tmagentApiKey, bearerToken, tenantId, agentId, agentConfig }
  const bearerToken = result?.bearerToken;
  if (!bearerToken) throw new Error('注册返回数据异常，缺少 bearerToken');

  loginState = {
    token: bearerToken,
    user: {
      mobile: result.mobile || mobile,
      tenantId: result.tenantId || '',
      agentId: result.agentId || ''
    },
    loggedIn: true
  };
  logger.log('[register:success]', { mobile, tenantId: result.tenantId });

  // 注册成功后自动保存 apiKey 到 AI 设置
  if (result.apiKey) {
    try {
      const currentSettings = readAiSettings();
      currentSettings.apiKey = String(result.apiKey).trim();
      currentSettings.tenantId = String(result.tenantId || '').trim();
      currentSettings.merchantName = String(result.mobile || '').trim();
      currentSettings.baseUrl = String(result.baseUrl || currentSettings.baseUrl || '').trim();
      saveAiSettings(currentSettings);
      logger.log('[register:auto-save-settings]', { apiKey: result.apiKey.substring(0, 8) + '...' });
    } catch (err) {
      logger.log('[register:auto-save-settings-error]', err.message);
    }

    // 注册成功后自动拉取云端 AI客服配置 并缓存到本地
    fetchAndCacheAgentConfig(result).catch((err) => {
      logger.log('[register:fetch-agent-config-error]', err.message);
    });
  }

  return { token: bearerToken, user: loginState.user };
}

/**
 * 登录/注册成功后，从云端拉取 AI客服配置 并写入本地缓存
 * @param {object} authResult - 登录/注册接口返回的 { apiKey, baseUrl, ... }
 */
async function fetchAndCacheAgentConfig(authResult) {
  const DEFAULT_BASE_URL = 'https://xingqiao.taluo.club';
  const baseUrl = String(authResult.baseUrl || readAiSettings().baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const apiKey = String(authResult.apiKey || '').trim();
  if (!baseUrl || !apiKey) {
    logger.log('[fetch-agent-config:skip]', '缺少 baseUrl 或 apiKey');
    return null;
  }
  logger.log('[fetch-agent-config:start]', { baseUrl });
  try {
    const result = await httpsRequest({
      url: `${baseUrl}/api/configs`,
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
      timeout: 15000
    });
    let config = Array.isArray(result) ? result[0] || null : result;
    // 标准化 basic/advanced
    if (config) {
      for (const field of ['basic', 'advanced']) {
        if (typeof config[field] === 'string') {
          try { config[field] = JSON.parse(config[field]); } catch (_) {}
        }
      }
      writeAgentConfigCache(config);
    }
    logger.log('[fetch-agent-config:done]', { hasConfig: !!config });
    sendToRenderer('agent-config:cache-updated', { config, fetchedAt: Date.now() });
    return config;
  } catch (err) {
    logger.log('[fetch-agent-config:error]', err.message);
    // 失败不阻塞登录流程，只是没有缓存
    return null;
  }
}

// ===== 自动登录凭据存储（加密） =====
const CREDENTIALS_FILE = path.join(app?.getPath?.('userData') || process.cwd(), '.login-credentials');
const CREDENTIALS_ENCRYPTION_KEY = 'bluelight-ai-kefu-2026-secure-key-v1';
const CREDENTIALS_IV_LENGTH = 16;
const CREDENTIALS_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7天

function encryptCredentials(data) {
  const json = JSON.stringify(data);
  const iv = crypto.randomBytes(CREDENTIALS_IV_LENGTH);
  const key = crypto.scryptSync(CREDENTIALS_ENCRYPTION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(json, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptCredentials(encryptedStr) {
  const parts = encryptedStr.split(':');
  if (parts.length !== 2) return null;
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  const key = crypto.scryptSync(CREDENTIALS_ENCRYPTION_KEY, 'salt', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  try {
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (_) {
    return null;
  }
}

function saveCredentialsFile(data) {
  try {
    fs.writeFileSync(CREDENTIALS_FILE, encryptCredentials(data), 'utf8');
  } catch (err) {
    logger.log('[credentials:save-error]', err.message);
  }
}

function readCredentialsFile() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    const encrypted = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    return decryptCredentials(encrypted);
  } catch (err) {
    logger.log('[credentials:read-error]', err.message);
    return null;
  }
}

function deleteCredentialsFile() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) fs.unlinkSync(CREDENTIALS_FILE);
  } catch (err) {
    logger.log('[credentials:delete-error]', err.message);
  }
}

function getLoginState() {
  return loginState;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 640,
    resizable: false,
    maximizable: false,
    title: '\u84dd\u5149\u7535\u5546AI\u5ba2\u670d',
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createFloatingPluginWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) return floatingWindow;

  floatingWindow = new BrowserWindow({
    width: FLOATING_PLUGIN_SIZE.width,
    height: FLOATING_PLUGIN_SIZE.height,
    minWidth: 300,
    minHeight: 520,
    maxWidth: 380,
    title: '\u5ba2\u670d\u52a9\u624b',
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  floatingWindow.loadFile(path.join(__dirname, '..', 'renderer', 'floating.html'));
  floatingWindow.on('closed', () => {
    floatingWindow = null;
  });
  return floatingWindow;
}

function createProductLibraryWindow() {
  if (productLibraryWindow && !productLibraryWindow.isDestroyed()) {
    productLibraryWindow.show();
    productLibraryWindow.focus();
    return productLibraryWindow;
  }

  productLibraryWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: '商品库',
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  productLibraryWindow.loadFile(path.join(__dirname, '..', 'renderer', 'product-library.html'));
  productLibraryWindow.on('closed', () => {
    productLibraryWindow = null;
  });
  return productLibraryWindow;
}

function createAiSettingsWindow() {
  if (aiSettingsWindow && !aiSettingsWindow.isDestroyed()) {
    aiSettingsWindow.show();
    aiSettingsWindow.focus();
    return aiSettingsWindow;
  }

  aiSettingsWindow = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 860,
    minHeight: 700,
    title: 'API设置与日志',
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  aiSettingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'ai-settings.html'));
  aiSettingsWindow.on('closed', () => {
    aiSettingsWindow = null;
  });
  return aiSettingsWindow;
}

function createVersionManagerWindow() {
  if (versionManagerWindow && !versionManagerWindow.isDestroyed()) {
    versionManagerWindow.show();
    versionManagerWindow.focus();
    return versionManagerWindow;
  }

  versionManagerWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 700,
    minHeight: 520,
    title: '工作台版本管理',
    backgroundColor: '#f0f2f5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  versionManagerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'version-manager.html'));
  versionManagerWindow.on('closed', () => {
    versionManagerWindow = null;
  });
  return versionManagerWindow;
}

function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return loginWindow;
  }

  loginWindow = new BrowserWindow({
    width: 460,
    height: 520,
    resizable: false,
    maximizable: false,
    title: '登录 - 蓝光电商AI客服',
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  loginWindow.loadFile(path.join(__dirname, '..', 'renderer', 'login.html'));
  loginWindow.on('closed', () => {
    loginWindow = null;
  });
  return loginWindow;
}

function computeFloatingBounds(options = {}) {
  const targetBounds = options.targetBounds || null;
  const displayBounds = options.displayBounds || { x: 0, y: 0, width: 1440, height: 900 };
  const pluginSize = options.pluginSize || FLOATING_PLUGIN_SIZE;
  const gap = options.gap ?? FLOATING_PLUGIN_GAP;
  const width = pluginSize.width;
  const height = Math.min(pluginSize.height, displayBounds.height);
  const rightEdge = displayBounds.x + displayBounds.width;
  const bottomEdge = displayBounds.y + displayBounds.height;

  if (!targetBounds) {
    return {
      x: rightEdge - width - gap,
      y: displayBounds.y + gap,
      width,
      height
    };
  }

  let x = targetBounds.x + targetBounds.width + gap;
  if (x + width > rightEdge) x = targetBounds.x - width - gap;
  x = Math.max(displayBounds.x + gap, Math.min(x, rightEdge - width - gap));

  const y = Math.max(displayBounds.y + gap, Math.min(targetBounds.y, bottomEdge - height - gap));
  return { x, y, width, height };
}

function updateFloatingPluginBounds(status = {}) {
  if (!floatingWindow || floatingWindow.isDestroyed()) return null;

  const display = screen?.getPrimaryDisplay?.();
  const displayBounds = display?.workArea || display?.bounds || { x: 0, y: 0, width: 1440, height: 900 };
  const targetBounds = status.workbenchWindows?.find?.((item) => item.bounds)?.bounds || null;
  const bounds = computeFloatingBounds({ targetBounds, displayBounds });
  floatingWindow.setBounds(bounds);
  return bounds;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send(channel, payload);
  }
  if (productLibraryWindow && !productLibraryWindow.isDestroyed()) {
    productLibraryWindow.webContents.send(channel, payload);
  }
  if (aiSettingsWindow && !aiSettingsWindow.isDestroyed()) {
    aiSettingsWindow.webContents.send(channel, payload);
  }
}

function bindPddStatusEvents(manager, send = sendToRenderer, eventLogger = noopLogger) {
  return observers.bindPddStatusEvents(manager, send, eventLogger, {
    updateFloatingPluginBounds,
    noteBridgeDiagnostic: observers.noteBridgeDiagnostic,
    getBridgeObservationState: () => bridgeObservationState
  });
}

function bindQnStatusEvents(manager, send = sendToRenderer) {
  return observers.bindQnStatusEvents(manager, send);
}

function createPddLaunchHandler(options = {}) {
  return chatHandlers.createPddLaunchHandler({
    getPddManager: options.getPddManager || (() => pddManager),
    getOssVersionManager: options.getOssVersionManager || (() => ossVersionManager),
    getSendToRenderer: options.getSendToRenderer || (() => sendToRenderer),
    logger: options.logger || logger
  });
}

function createQnLaunchHandler(options = {}) {
  return chatHandlers.createQnLaunchHandler({
    getQnManager: options.getQnManager || (() => qnManager),
    getOssVersionManager: options.getOssVersionManager || (() => ossVersionManager),
    getSendToRenderer: options.getSendToRenderer || (() => sendToRenderer),
    logger: options.logger || logger
  });
}

function createSendMessageHandler(options = {}) {
  return chatHandlers.createSendMessageHandler({
    getWsServer: options.getWsServer || (() => wsServer),
    getPddManager: options.getPddManager || (() => pddManager),
    logger: options.logger || logger
  });
}

function createFocusConversationHandler(options = {}) {
  return chatHandlers.createFocusConversationHandler({
    getWsServer: options.getWsServer || (() => wsServer),
    logger: options.logger || logger
  });
}

function createPddCommandHandler(options = {}) {
  return chatHandlers.createPddCommandHandler({
    commandAct: options.commandAct,
    getWsServer: options.getWsServer || (() => wsServer),
    logger: options.logger || logger
  });
}

function createResumeConversationHandler(options = {}) {
  return chatHandlers.createResumeConversationHandler({
    handoffStore: options.handoffStore || conversationHandoffStore,
    logger: options.logger || logger
  });
}

function createAutoReplyHandler(options = {}) {
  const resolvedOptions = { ...options };
  if (!resolvedOptions.getWsServer) resolvedOptions.getWsServer = () => wsServer;
  if (!resolvedOptions.getAiSettings) resolvedOptions.getAiSettings = () => readAiSettings();
  if (!resolvedOptions.handoffStore) resolvedOptions.handoffStore = chatHandlers.createConversationHandoffStore();
  if (!resolvedOptions.logger) resolvedOptions.logger = logger;
  return chatHandlers.createAutoReplyHandler({
    ...resolvedOptions
  });
}

function createWbChatChangeHandler(options = {}) {
  return observers.createWbChatChangeHandler({
    getPddManager: options.getPddManager || (() => pddManager),
    send: options.send || sendToRenderer,
    logger: options.logger || logger
  });
}

async function startServices() {
  logger.log('[app:start]', { version: app?.getVersion?.(), cwd: process.cwd() });
  bridgeObservationState = observers.createBridgeObservationState();

  // 初始化 OSS 版本管理器
  ossVersionManager = createOssVersionManager({ logger });
  // 后台静默刷新版本清单
  ossVersionManager.refreshManifest().catch((err) => {
    logger.log('[oss:init-error]', err.message);
  });
  wsServer = new InternalWebSocketServer({ host: '127.0.0.1', port: Number(process.env.PDD_LG_PORT || 0), logger });
  pddManager = new PddManager({
    logger,
    cdpManager: createCdpManager({ logger }),
    layerSurveyEnabled: true
  });
  qnManager = new QnManager({ logger });

  wsServer.on('listening', (address) => {
    logger.log('[ws:listening]', address);
    sendToRenderer('server:status', address);
  });
  wsServer.on('client-connected', (client) => {
    sendToRenderer('ws:client-connected', client);
    if (bridgeRuntime.isPddBridgeClient(client)) {
      observers.noteBridgeClientConnected(bridgeObservationState, client);
      sendToRenderer('bridge:health', observers.getBridgeObservationSnapshot(bridgeObservationState));
    }
  });
  wsServer.on('client-disconnected', (client) => {
    sendToRenderer('ws:client-disconnected', client);
    if (bridgeRuntime.isPddBridgeClient(client)) {
      observers.noteBridgeClientDisconnected(bridgeObservationState, client);
      sendToRenderer('bridge:health', observers.getBridgeObservationSnapshot(bridgeObservationState));
    }
  });

  const autoReply = createAutoReplyHandler({ logger, handoffStore: conversationHandoffStore, orderCache: globalOrderCache });
  wsServer.on('pdd-message', (payload) => {
    conversationHandoffStore.noteMessage(payload);
    sendToRenderer('pdd:message', payload);
    Promise.resolve(autoReply(payload)).catch((error) => logger.error('[auto-reply:error]', error));
  });
  wsServer.on('protocol-message', (payload) => sendToRenderer('ws:protocol-message', payload));
  wsServer.on('raw-message', (payload) => sendToRenderer('ws:raw-message', payload));
  wsServer.on('bridge-diagnostic', (payload) => {
    const annotated = observers.noteBridgeDiagnostic(bridgeObservationState, payload);
    sendToRenderer('bridge:diagnostic', annotated);
    sendToRenderer('bridge:health', observers.getBridgeObservationSnapshot(bridgeObservationState));
  });
  wsServer.on('client-error', (payload) => sendToRenderer('ws:error', payload));

  // 监听 right_panel 的订单/物流信息 probe，转发给 tmagent 并写入缓存
  pddManager.on('probe', (probePayload) => {
    const name = probePayload?.diagnostic?.name || '';
    if (name !== 'right-panel-order-info') return;

    const orderInfo = probePayload?.diagnostic?.payload?.orderInfo;
    if (!Array.isArray(orderInfo) || !orderInfo.length) return;

    // 将订单数据写入全局缓存（暂无 buyer_id，会进入无主订单池）
    // 当买家发消息时，autoReply 会自动认领同店铺的无主订单
    const aiSettings = readAiSettings();
    const shopId = String(aiSettings.tenantId || process.env.PDD_LG_TMAGENT_SHOP_ID || 'default');
    globalOrderCache.cacheOrders('pdd', shopId, orderInfo);

    // 发送订单/物流信息给 tmagent
    const apiKey = aiSettings.apiKey || process.env.PDD_LG_TMAGENT_API_KEY || '';
    const baseUrl = (aiSettings.baseUrl || process.env.PDD_LG_TMAGENT_BASE_URL || '').trim().replace(/\/+$/, '');
    if (!apiKey || !baseUrl) {
      logger.log('[order-info:skip]', { reason: 'missing-credentials' });
      return;
    }

    const payload = buildOrderInfoPayload({
      platform: 'pdd',
      shopId,
      shopName: String(aiSettings.merchantName || process.env.PDD_LG_TMAGENT_SHOP_NAME || ''),
      orders: orderInfo
    });

    logger.log('[order-info:send]', {
      orderCount: orderInfo.length,
      orderSns: orderInfo.map((o) => o.order_sn).join(',')
    });

    requestTmagentChat({ baseUrl, apiKey, payload }).catch((err) => {
      logger.error('[order-info:send-error]', err.message);
    });
  });

  bindPddStatusEvents(pddManager, sendToRenderer, logger);
  bindQnStatusEvents(qnManager, sendToRenderer);

  wbChatWatcher = new WbChatWatcher({
    logger,
    onChange: createWbChatChangeHandler({ getPddManager: () => pddManager, send: sendToRenderer, logger })
  });
  wbChatWatcher.start();

  const address = await wsServer.start();
  bridgeServer = await bridgeRuntime.startPddBridgeServer({ wsPort: address.port, logger });
  observers.noteBridgeHttpStarted(bridgeObservationState, {
    httpStarted: true,
    url: bridgeServer.url,
    port: bridgeServer.address.port
  });
  sendToRenderer('bridge:status', { httpStarted: true, url: bridgeServer.url, port: bridgeServer.address.port });
  sendToRenderer('bridge:health', observers.getBridgeObservationSnapshot(bridgeObservationState));

  pddManager.wsPort = address.port;
  pddManager.jsUrl = bridgeServer.url;
  qnManager.wsPort = address.port;
  qnManager.jsUrl = bridgeServer.qnUrl || bridgeServer.url;
  pddManager.startMonitoring();
  qnManager.startMonitoring();
}

if (ipcMain) {
  ipcMain.handle('app:get-status', async () => ({
    server: wsServer?.address() || null,
    clients: wsServer?.publicClients?.() || [],
    bridge: observers.getBridgeObservationSnapshot(bridgeObservationState),
    pdd: await pddManager?.refreshStatus(),
    qn: await qnManager?.refreshStatus(),
    handoff: conversationHandoffStore.snapshot()
  }));
  ipcMain.handle('ai-settings:get', () => readAiSettings());
  ipcMain.handle('ai-settings:save', (_event, payload) => saveAiSettings(payload));
  ipcMain.handle('tmagent:request', (_event, payload) => proxyTmagentRequest(payload));
  ipcMain.handle('diagnostics:get-snapshot', () => createDiagnosticsSnapshot({ logPath: logger.logPath }));
  ipcMain.handle('login:login', (_event, payload) => handleLogin(payload));
  ipcMain.handle('login:register', (_event, payload) => handleRegister(payload));
  ipcMain.handle('login:get-state', () => getLoginState());
  ipcMain.handle('login:notify-success', async (_event, payload) => {
    // handleLogin 已经设置了 loginState，这里只负责启动服务
    if (payload?.token) {
      loginState = { token: payload.token, user: payload.user, loggedIn: true };
    }
    sendToRenderer('login:state-changed', loginState);

    // 登录成功后，创建主窗口并启动服务
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      createFloatingPluginWindow();
      await startServices();
    }
    return { ok: true };
  });
  ipcMain.handle('login:open', () => {
    createLoginWindow();
    return { opened: true };
  });
  ipcMain.handle('login:close', () => {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    return { closed: true };
  });
  // 自动登录凭据存储
  ipcMain.handle('login:save-credentials', (_event, payload) => {
    saveCredentialsFile({
      mobile: String(payload?.mobile || ''),
      password: String(payload?.password || ''),
      timestamp: Number(payload?.timestamp || Date.now())
    });
    logger.log('[credentials:saved]', { mobile: payload?.mobile });
    return { saved: true };
  });
  ipcMain.handle('login:clear-credentials', () => {
    deleteCredentialsFile();
    logger.log('[credentials:cleared]');
    return { cleared: true };
  });
  ipcMain.handle('login:get-saved-credentials', () => {
    const data = readCredentialsFile();
    if (!data || !data.mobile || !data.password) return null;
    // 检查是否过期（7天）
    const now = Date.now();
    if (now - data.timestamp > CREDENTIALS_MAX_AGE) {
      deleteCredentialsFile();
      logger.log('[credentials:expired]', { savedAt: new Date(data.timestamp).toISOString() });
      return null;
    }
    return data;
  });

  ipcMain.handle('pdd:launch', createPddLaunchHandler({ logger }));
  ipcMain.handle('qn:launch', createQnLaunchHandler({ logger }));
  ipcMain.handle('chat:send-message', createSendMessageHandler({ logger }));
  ipcMain.handle('pdd:get-current-csr', createPddCommandHandler({ logger, commandAct: 'getCurrentCsr' }));
  ipcMain.handle('pdd:get-current-conv', createPddCommandHandler({ logger, commandAct: 'getCurrentConv' }));
  ipcMain.handle('pdd:get-remote-history', createPddCommandHandler({ logger, commandAct: 'getRemoteHisMsg' }));
  ipcMain.handle('pdd:query-order-remark', createPddCommandHandler({ logger, commandAct: 'queryOrderRemark' }));
  ipcMain.handle('pdd:set-order-remark', createPddCommandHandler({ logger, commandAct: 'setOrderRemark' }));
  ipcMain.handle('pdd:auto-order-message', createPddCommandHandler({ logger, commandAct: 'autoOrderMessage' }));
  ipcMain.handle('conversation:focus', createFocusConversationHandler({ logger }));
  ipcMain.handle('conversation:resume', createResumeConversationHandler({ logger, handoffStore: conversationHandoffStore }));
  ipcMain.handle('window:open-product-library', () => {
    createProductLibraryWindow();
    return { opened: true };
  });
  ipcMain.handle('window:open-ai-settings', () => {
    createAiSettingsWindow();
    return { opened: true };
  });
  ipcMain.handle('window:open-version-manager', () => {
    createVersionManagerWindow();
    return { opened: true };
  });
  // AI客服配置 - 代理到 tmagent 后端
  // 读取：优先返回本地缓存，同时后台静默刷新云端数据
  ipcMain.handle('agent-config:get', async () => {
    console.log('[agent-config:get] IPC handler triggered');
    logger.log('[agent-config:get] IPC handler triggered');
    const settings = readAiSettings();
    const baseUrl = String(settings.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(settings.apiKey || '').trim();

    // 先返回本地缓存（如果有）
    const cache = readAgentConfigCache();
    const cachedConfig = cache?.config || null;

    // 如果无网络凭据，仅返回缓存
    if (!baseUrl || !apiKey) {
      return { config: cachedConfig, fromCache: true, fetchedAt: cache?.fetchedAt || 0 };
    }

    // 后台静默从云端拉取最新配置，不阻塞返回
    const refreshPromise = httpsRequest({
      url: `${baseUrl}/api/configs`,
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
      timeout: 15000
    }).then((result) => {
      let config = Array.isArray(result) ? result[0] || null : result;
      if (config) {
        for (const field of ['basic', 'advanced']) {
          if (typeof config[field] === 'string') {
            try { config[field] = JSON.parse(config[field]); } catch (_) {}
          }
        }
        writeAgentConfigCache(config);
        sendToRenderer('agent-config:cache-updated', { config, fetchedAt: Date.now() });
      }
      return config;
    }).catch((err) => {
      logger.log('[agent-config:refresh-error]', err.message);
      return null;
    });

    // 如果有缓存，立即返回缓存；同时后台刷新
    if (cachedConfig) {
      // 不 await，让刷新在后台跑
      refreshPromise.catch(() => {});
      return { config: cachedConfig, fromCache: true, fetchedAt: cache.fetchedAt || 0 };
    }

    // 没有缓存，等待云端返回
    try {
      const config = await refreshPromise;
      return { config, fromCache: false, fetchedAt: Date.now() };
    } catch (err) {
      throw new Error(`获取配置失败: ${err.message}`);
    }
  });
  ipcMain.handle('agent-config:save', async (_event, payload) => {
    console.log('[agent-config:save] IPC handler triggered', { payloadKeys: Object.keys(payload || {}) });
    const settings = readAiSettings();
    const baseUrl = String(settings.baseUrl || '').trim().replace(/\/+$/, '');
    const apiKey = String(settings.apiKey || '').trim();
    logger.log('[agent-config:save]', { baseUrl, hasApiKey: !!apiKey, payloadKeys: Object.keys(payload || {}) });
    if (!baseUrl) throw new Error('请先在设置里配置 Base URL');
    if (!apiKey) throw new Error('请先在设置里配置 API Key');
    const body = {};
    // 只传有值的字段
    const fields = [
      'llm_temperature', 'llm_max_tokens', 'soul_name', 'soul_prompt',
      'persona_name', 'persona_system_prompt', 'epsilon', 'strategy',
      'max_context_turns', 'top_k', 'basic', 'advanced'
    ];
    for (const key of fields) {
      if (payload[key] !== undefined && payload[key] !== null) {
        body[key] = payload[key];
      }
    }
    const url = `${baseUrl}/api/configs`;
    logger.log('[agent-config:save:request]', { url, method: 'PUT', bodyKeys: Object.keys(body), bodySize: JSON.stringify(body).length });
    const putResult = await httpsRequest({
      url,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(body)
    });
    logger.log('[agent-config:save:put-response]', { type: typeof putResult, keys: putResult ? Object.keys(putResult) : 'null' });
    // 标准化：确保 basic/advanced 是对象而非 JSON 字符串
    if (putResult) {
      for (const field of ['basic', 'advanced']) {
        if (typeof putResult[field] === 'string') {
          try { putResult[field] = JSON.parse(putResult[field]); } catch (_) {}
        }
      }
      writeAgentConfigCache(putResult);
    }
    return putResult;
  });
  // ===== OSS 版本管理 =====
  ipcMain.handle('oss:get-manifest', async (_event, forceRefresh) => {
    if (!ossVersionManager) throw new Error('OSS 版本管理器未初始化');
    return ossVersionManager.getManifest(!!forceRefresh);
  });
  ipcMain.handle('oss:refresh-manifest', async () => {
    if (!ossVersionManager) throw new Error('OSS 版本管理器未初始化');
    return ossVersionManager.refreshManifest();
  });
  ipcMain.handle('oss:query-versions', async (_event, platform) => {
    if (!ossVersionManager) throw new Error('OSS 版本管理器未初始化');
    return ossVersionManager.queryVersions(platform);
  });
  ipcMain.handle('oss:download-version', async (_event, platform, version) => {
    if (!ossVersionManager) throw new Error('OSS 版本管理器未初始化');
    // 下载进度通过 sendToRenderer 推送
    const result = await ossVersionManager.downloadVersion(
      platform, version,
      // 下载进度回调
      (progress) => {
        sendToRenderer('oss:download-progress', { platform, version, ...progress });
      },
      // 解压进度回调
      (extractProgress) => {
        sendToRenderer('oss:extract-progress', { platform, version, ...extractProgress });
      }
    );
    sendToRenderer('oss:download-complete', result);
    return result;
  });
  ipcMain.handle('oss:ensure-recommendation', async (_event, platform) => {
    if (!ossVersionManager) throw new Error('OSS 版本管理器未初始化');
    const result = await ossVersionManager.ensureRecommendation(platform);
    sendToRenderer('oss:download-complete', result);
    return result;
  });
  ipcMain.handle('oss:get-local-versions', () => {
    if (!ossVersionManager) return {};
    return ossVersionManager.getLocalVersions();
  });
  ipcMain.handle('oss:get-storage-stats', () => {
    if (!ossVersionManager) return { totalSize: 0, totalFiles: 0, platforms: {} };
    return ossVersionManager.getStorageStats();
  });
  ipcMain.handle('oss:clean-version', (_event, platform, version) => {
    if (!ossVersionManager) throw new Error('OSS 版本管理器未初始化');
    return ossVersionManager.cleanVersion(platform, version);
  });
  ipcMain.handle('oss:clean-old-versions', async () => {
    if (!ossVersionManager) throw new Error('OSS 版本管理器未初始化');
    return ossVersionManager.cleanOldVersions();
  });

  ipcMain.handle('floating:close', () => {
    floatingWindow?.hide();
    return { hidden: true };
  });
  ipcMain.handle('floating:minimize', () => {
    floatingWindow?.minimize();
    return { minimized: true };
  });
  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
    return { minimized: true };
  });
  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
    return { closed: true };
  });
}

if (app) {
  app.whenReady().then(async () => {
    // 先创建登录窗口，登录成功后主窗口再启动服务
    createLoginWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createLoginWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    wsServer?.close();
    bridgeServer?.close().catch((error) => logger.error('[pdd-bridge:http-stop-error]', error));
    wbChatWatcher?.stop();
    pddManager?.stop();
    qnManager?.stopMonitoring();
    ossVersionManager = null;
    productLibraryWindow?.close();
    aiSettingsWindow?.close();
    versionManagerWindow?.close();
    loginWindow?.close();
  });
}

module.exports = {
  createBridgeObservationState: observers.createBridgeObservationState,
  getBridgeObservationSnapshot: observers.getBridgeObservationSnapshot,
  noteBridgeHttpStarted: observers.noteBridgeHttpStarted,
  noteBridgeClientConnected: observers.noteBridgeClientConnected,
  noteBridgeClientDisconnected: observers.noteBridgeClientDisconnected,
  noteBridgeDiagnostic: observers.noteBridgeDiagnostic,
  createPddLaunchHandler,
  createQnLaunchHandler,
  createSendMessageHandler,
  createPddCommandHandler,
  createFocusConversationHandler,
  createResumeConversationHandler,
  createAutoReplyHandler,
  createProductLibraryWindow,
  createAiSettingsWindow,
  createLoginWindow,
  getLoginState,
  handleLogin,
  handleRegister,
  createConversationHandoffStore: chatHandlers.createConversationHandoffStore,
  createWbChatChangeHandler,
  computeFloatingBounds,
  bindPddStatusEvents,
  bindQnStatusEvents,
  createPddBridgeScript: bridgeRuntime.createPddBridgeScript,
  startPddBridgeServer: bridgeRuntime.startPddBridgeServer,
  isPddBridgeClient: bridgeRuntime.isPddBridgeClient,
  createDiagnosticsSnapshot
};
