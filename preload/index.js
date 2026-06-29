'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const subscriptions = new Set();

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  subscriptions.add({ channel, listener });
  return () => {
    ipcRenderer.removeListener(channel, listener);
    subscriptions.delete({ channel, listener });
  };
}

contextBridge.exposeInMainWorld('pddFuke', {
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  getAiSettings: () => ipcRenderer.invoke('ai-settings:get'),
  saveAiSettings: (payload) => ipcRenderer.invoke('ai-settings:save', payload),
  tmagentRequest: (payload) => ipcRenderer.invoke('tmagent:request', payload),
  getDiagnosticsSnapshot: () => ipcRenderer.invoke('diagnostics:get-snapshot'),
  launchPdd: () => ipcRenderer.invoke('pdd:launch'),
  launchQn: () => ipcRenderer.invoke('qn:launch'),
  sendMessage: (payload) => ipcRenderer.invoke('chat:send-message', payload),
  getCurrentPddCsr: () => ipcRenderer.invoke('pdd:get-current-csr'),
  getCurrentPddConv: (payload) => ipcRenderer.invoke('pdd:get-current-conv', payload),
  getPddRemoteHistory: (payload) => ipcRenderer.invoke('pdd:get-remote-history', payload),
  queryPddOrderRemark: (payload) => ipcRenderer.invoke('pdd:query-order-remark', payload),
  setPddOrderRemark: (payload) => ipcRenderer.invoke('pdd:set-order-remark', payload),
  sendPddOrderMessage: (payload) => ipcRenderer.invoke('pdd:auto-order-message', payload),
  focusConversation: (payload) => ipcRenderer.invoke('conversation:focus', payload),
  resumeConversation: (payload) => ipcRenderer.invoke('conversation:resume', payload),
  openProductLibrary: () => ipcRenderer.invoke('window:open-product-library'),
  openAiSettings: () => ipcRenderer.invoke('window:open-ai-settings'),
  openVersionManager: () => ipcRenderer.invoke('window:open-version-manager'),
  // AI客服配置
  getAgentConfig: () => ipcRenderer.invoke('agent-config:get'),
  saveAgentConfig: (payload) => ipcRenderer.invoke('agent-config:save', payload),
  onAgentConfigCacheUpdated: (callback) => on('agent-config:cache-updated', callback),
  closeFloating: () => ipcRenderer.invoke('floating:close'),
  minimizeFloating: () => ipcRenderer.invoke('floating:minimize'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  // 登录相关 API
  login: (payload) => ipcRenderer.invoke('login:login', payload),
  register: (payload) => ipcRenderer.invoke('login:register', payload),
  getLoginState: () => ipcRenderer.invoke('login:get-state'),
  notifyLoginSuccess: (payload) => ipcRenderer.invoke('login:notify-success', payload),
  closeLogin: () => ipcRenderer.invoke('login:close'),
  saveCredentials: (payload) => ipcRenderer.invoke('login:save-credentials', payload),
  clearCredentials: () => ipcRenderer.invoke('login:clear-credentials'),
  getSavedCredentials: () => ipcRenderer.invoke('login:get-saved-credentials'),
  onLoginStateChanged: (callback) => on('login:state-changed', callback),
  // 事件监听
  onServerStatus: (callback) => on('server:status', callback),
  onPddStatus: (callback) => on('pdd:status', callback),
  onPddError: (callback) => on('pdd:error', callback),
  onPddExit: (callback) => on('pdd:exit', callback),
  onQnStatus: (callback) => on('qn:status', callback),
  onQnError: (callback) => on('qn:error', callback),
  onBridgeStatus: (callback) => on('bridge:status', callback),
  onBridgeHealth: (callback) => on('bridge:health', callback),
  onBridgeDiagnostic: (callback) => on('bridge:diagnostic', callback),
  onCdpStatus: (callback) => on('cdp:status', callback),
  onClientConnected: (callback) => on('ws:client-connected', callback),
  onClientDisconnected: (callback) => on('ws:client-disconnected', callback),
  onProtocolMessage: (callback) => on('ws:protocol-message', callback),
  onRawMessage: (callback) => on('ws:raw-message', callback),
  onWsError: (callback) => on('ws:error', callback),
  onWbChatFileChange: (callback) => on('wbchat:file-change', callback),
  onDomChat: (callback) => on('pdd:dom-chat', callback),
  onDomChatError: (callback) => on('pdd:dom-chat-error', callback),
  onMessage: (callback) => on('pdd:message', callback),
  onManualState: (callback) => on('conversation:manual-state', callback),
  // OSS 版本管理
  getManifest: (forceRefresh) => ipcRenderer.invoke('oss:get-manifest', forceRefresh),
  refreshManifest: () => ipcRenderer.invoke('oss:refresh-manifest'),
  queryVersions: (platform) => ipcRenderer.invoke('oss:query-versions', platform),
  downloadVersion: (platform, version) => ipcRenderer.invoke('oss:download-version', platform, version),
  ensureRecommendation: (platform) => ipcRenderer.invoke('oss:ensure-recommendation', platform),
  getLocalVersions: () => ipcRenderer.invoke('oss:get-local-versions'),
  getStorageStats: () => ipcRenderer.invoke('oss:get-storage-stats'),
  cleanVersion: (platform, version) => ipcRenderer.invoke('oss:clean-version', platform, version),
  cleanOldVersions: () => ipcRenderer.invoke('oss:clean-old-versions'),
  onDownloadProgress: (callback) => on('oss:download-progress', callback),
  onExtractProgress: (callback) => on('oss:extract-progress', callback),
  onDownloadComplete: (callback) => on('oss:download-complete', callback),
  // 平台启动时按需下载进度（主窗口用）
  onPlatformDownloadStart: (callback) => on('platform:download-start', callback),
  onPlatformDownloadProgress: (callback) => on('platform:download-progress', callback),
  onPlatformDownloadComplete: (callback) => on('platform:download-complete', callback),
  onPlatformDownloadError: (callback) => on('platform:download-error', callback),
  disposeAll: () => {
    for (const item of subscriptions) {
      ipcRenderer.removeListener(item.channel, item.listener);
    }
    subscriptions.clear();
  }
});
