'use strict';

const noopLogger = { log() {}, error() {} };

function createBridgeObservationState() {
  return {
    httpStarted: false,
    bridgeUrl: '',
    wsConnected: false,
    pageReadyAt: null,
    lastClientId: null,
    activeTraceId: null,
    activeTraceAt: null
  };
}

function getBridgeObservationSnapshot(state) {
  const current = state || createBridgeObservationState();
  return {
    httpStarted: Boolean(current.httpStarted),
    bridgeUrl: current.bridgeUrl || '',
    wsConnected: Boolean(current.wsConnected),
    pageReady: Number.isFinite(current.pageReadyAt),
    pageReadyAt: Number.isFinite(current.pageReadyAt) ? current.pageReadyAt : null,
    lastClientId: current.lastClientId || null,
    activeTraceId: current.activeTraceId || null,
    ready: Boolean(current.httpStarted && current.wsConnected && Number.isFinite(current.pageReadyAt))
  };
}

function noteBridgeHttpStarted(state, status = {}) {
  const current = state || createBridgeObservationState();
  current.httpStarted = status.httpStarted !== false && Boolean(status.url || status.port || status.httpStarted);
  current.bridgeUrl = String(status.url || current.bridgeUrl || '');
  return getBridgeObservationSnapshot(current);
}

function noteBridgeClientConnected(state, client = {}) {
  const current = state || createBridgeObservationState();
  current.wsConnected = true;
  current.lastClientId = client.id ? String(client.id) : current.lastClientId;
  current.pageReadyAt = null;
  current.activeTraceId = null;
  current.activeTraceAt = null;
  return getBridgeObservationSnapshot(current);
}

function noteBridgeClientDisconnected(state, client = {}) {
  const current = state || createBridgeObservationState();
  if (!client?.id || String(client.id) === String(current.lastClientId || '')) {
    current.wsConnected = false;
    current.lastClientId = null;
    current.pageReadyAt = null;
    current.activeTraceId = null;
    current.activeTraceAt = null;
  }
  return getBridgeObservationSnapshot(current);
}

function noteBridgeDiagnostic(state, payload = {}, options = {}) {
  const current = state || createBridgeObservationState();
  const now = options.now || Date.now;
  const sourceDiagnostic = payload?.diagnostic || {};
  const diagnostic = {
    ...sourceDiagnostic,
    payload: sourceDiagnostic.payload && typeof sourceDiagnostic.payload === 'object'
      ? { ...sourceDiagnostic.payload }
      : {}
  };
  const name = String(diagnostic.name || '');
  const snapshotBefore = getBridgeObservationSnapshot(current);
  const isTransferEvent = /^transfer-/.test(name);

  if (name === 'page-ready') {
    current.pageReadyAt = Number(diagnostic.time || now()) || now();
  }

  const snapshotAfter = getBridgeObservationSnapshot(current);
  if (isTransferEvent && snapshotAfter.ready) {
    if (name === 'transfer-click' || !current.activeTraceId) {
      current.activeTraceAt = now();
      current.activeTraceId = `transfer-${current.activeTraceAt}`;
    }
    diagnostic.payload.traceId = current.activeTraceId;
  }

  if (isTransferEvent) {
    diagnostic.payload.bridgeReady = snapshotAfter.ready;
    if (!snapshotAfter.ready) {
      diagnostic.payload.bridgeGate = {
        httpStarted: snapshotBefore.httpStarted,
        wsConnected: snapshotBefore.wsConnected,
        pageReady: snapshotBefore.pageReady
      };
    }
  }

  return { ...payload, diagnostic };
}

function bindPddStatusEvents(manager, send, eventLogger = noopLogger, options = {}) {
  const updateFloatingPluginBounds = options.updateFloatingPluginBounds || (() => null);
  const noteDiagnostic = options.noteBridgeDiagnostic || ((_, payload) => payload);
  const getBridgeObservationState = options.getBridgeObservationState || (() => null);

  manager.on('status', (status) => {
    updateFloatingPluginBounds(status);
    send('pdd:status', status);
  });
  manager.on('launched', (status) => {
    updateFloatingPluginBounds(status);
    send('pdd:status', status);
  });
  manager.on('exit', (event) => send('pdd:exit', event));
  manager.on('error', (error) => send('pdd:error', error.message));
  manager.on('bridge:injected', (result) => {
    eventLogger.log('[dll:inject-result]', result);
    send('bridge:status', { injected: true, pid: result.pid, dllPath: result.dllPath });
    send('pdd:status', { ...manager.status, bridgeInjected: true, bridgeError: null });
  });
  manager.on('bridge:inject-error', (error) => {
    const message = error.message || String(error);
    eventLogger.error('[dll:inject-error]', error);
    send('bridge:status', { injected: false, error: message });
    send('pdd:status', { ...manager.status, bridgeInjected: false, bridgeError: message });
  });
  manager.on('cdp-ready', (result) => {
    eventLogger.log('[cdp:ready]', result);
    send('cdp:status', { connected: true, url: result.url });
    send('pdd:status', { ...manager.status, cdpConnected: true, cdpError: null });
  });
  manager.on('cdp-error', (error) => {
    const message = error.message || String(error);
    eventLogger.error('[cdp:error]', error);
    send('cdp:status', { connected: false, error: message });
    send('pdd:status', { ...manager.status, cdpConnected: false, cdpError: message });
  });
  manager.on('probe', (payload) => {
    const annotated = noteDiagnostic(getBridgeObservationState(), payload);
    eventLogger.log('[pdd:probe]', annotated);
    send('bridge:diagnostic', annotated);
  });
}

function bindQnStatusEvents(manager, send) {
  manager.on('status', (status) => send('qn:status', status));
  manager.on('launched', (status) => send('qn:status', status));
  manager.on('error', (error) => send('qn:error', error.message));
}

// DOM/WBChat polling is isolated from startup so diagnostics work can evolve
// without changing launcher or auto-reply behavior.
function createWbChatChangeHandler(options = {}) {
  const getPddManager = options.getPddManager;
  const send = options.send;
  const logger = options.logger || noopLogger;
  let readInFlight = false;

  return async (event) => {
    send('wbchat:file-change', event);
    if (event?.name !== 'message.db-wal' || readInFlight) return null;

    const manager = getPddManager();
    if (!manager?.readCurrentChatDom) return null;

    readInFlight = true;
    try {
      const chat = await manager.readCurrentChatDom();
      const payload = { event, chat, time: Date.now() };
      logger.log('[pdd:dom-chat]', {
        sourceId: event.sourceId,
        messageCount: chat?.messages?.length || 0,
        title: chat?.title || '',
        href: chat?.href || ''
      });
      send('pdd:dom-chat', payload);
      return payload;
    } catch (error) {
      logger.error('[pdd:dom-chat-error]', error);
      send('pdd:dom-chat-error', { event, error: error.message || String(error) });
      return null;
    } finally {
      readInFlight = false;
    }
  };
}

module.exports = {
  createBridgeObservationState,
  getBridgeObservationSnapshot,
  noteBridgeHttpStarted,
  noteBridgeClientConnected,
  noteBridgeClientDisconnected,
  noteBridgeDiagnostic,
  bindPddStatusEvents,
  bindQnStatusEvents,
  createWbChatChangeHandler
};
