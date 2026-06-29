'use strict';

const { DEFAULT_API_KEY, buildTmagentChatPayload, requestTmagentChat, createMessageBuffer, createOrderCache, normalizePlatform } = require('./tmagent-client');
const { readAiSettings, DEFAULT_AI_SETTINGS, normalizeShopOverrideKey } = require('./ai-settings-store');

const noop = () => {};

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeQnUserId(value) {
  return String(value || '').replace(/^cntaobao/i, '');
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}***${text.slice(-1)}`;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function hashText(value) {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function waitForPddSendOutcome(server, options = {}) {
  if (!server || typeof server.on !== 'function' || typeof server.off !== 'function') {
    return Promise.resolve(null);
  }

  const clientId = String(options.clientId || '').trim();
  const targetId = String(options.targetId || '').trim();
  const contentHash = String(options.contentHash || '').trim();
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.off('bridge-diagnostic', onBridgeDiagnostic);
      resolve(result);
    };

    const onBridgeDiagnostic = (event = {}) => {
      const diagnostic = event.diagnostic || {};
      const payload = diagnostic.payload || {};
      const eventClientId = String(event.client?.id || '').trim();
      if (clientId && eventClientId && eventClientId !== clientId) return;

      if (diagnostic.name === 'pdd-send-callback') {
        if (String(payload.uid || '').trim() !== targetId) return;
        if (contentHash && payload.contentHash && String(payload.contentHash) !== contentHash) return;
        finish({
          ok: payload.ok !== false,
          type: 'callback',
          error: String(payload.error || payload.message || '')
        });
        return;
      }

      if (diagnostic.name === 'window-error') {
        finish({
          ok: false,
          type: 'window-error',
          error: String(payload.message || payload.error || 'window-error')
        });
      }    };

    server.on('bridge-diagnostic', onBridgeDiagnostic);
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

function normalizeClientPlatform(platform) {
  const value = String(platform || '').trim().toLowerCase();
  if (value === 'publicplatform' || value === 'pdd') return 'pdd';
  if (value === 'taobao' || value === 'qianniu' || value === 'qn') return 'qn';
  return value;
}

function resolveShopOverride(aiSettings, client = {}) {
  const key = normalizeShopOverrideKey(
    normalizeClientPlatform(client.platform),
    client.shopId || client.shop_id || client.mallId || client.mall_id
  );
  if (!key) return null;
  return aiSettings?.shopOverrides?.[key] || null;
}

function createConversationHandoffStore(options = {}) {
  const entries = new Map();
  const onChange = typeof options.onChange === 'function' ? options.onChange : noop;

  function snapshot() {
    return {
      manual: Array.from(entries.values())
        .filter((item) => item.muted)
        .sort((a, b) => (b.pendingSince || b.lastBuyerAt || 0) - (a.pendingSince || a.lastBuyerAt || 0))
        .map((item) => ({ ...item }))
    };
  }

  function emitChange() {
    onChange(snapshot());
  }

  function manualEntry(conversationId, patch = {}) {
    const id = String(conversationId || '').trim();
    if (!id) return null;
    const current = entries.get(id) || {
      conversationId: id,
      platform: '',
      customerName: '',
      reason: '',
      scope: '',
      muted: false,
      enteredAt: 0,
      pendingSince: 0,
      lastBuyerAt: 0,
      lastAssistantAt: 0
    };
    const next = { ...current, ...patch, conversationId: id };
    entries.set(id, next);
    return next;
  }

  return {
    noteMessage(payload = {}) {
      const message = payload.message || {};
      const conversationId = String(message.conversationId || '').trim();
      if (!conversationId || !entries.has(conversationId)) return;
      const timestamp = Number(message.timestamp) || Date.now();
      const patch = {
        platform: String(payload?.client?.platform || entries.get(conversationId)?.platform || ''),
        customerName: String(message.senderName || entries.get(conversationId)?.customerName || '')
      };
      if (message.direction === 'user') {
        patch.lastBuyerAt = timestamp;
        patch.pendingSince = entries.get(conversationId)?.pendingSince || timestamp;
      } else if (message.direction === 'assistant') {
        patch.lastAssistantAt = timestamp;
        patch.pendingSince = 0;
      }
      manualEntry(conversationId, patch);
      emitChange();
    },
    markManual(payload = {}) {
      const conversationId = String(payload.conversationId || '').trim();
      if (!conversationId) return null;
      const current = entries.get(conversationId);
      const next = manualEntry(conversationId, {
        platform: String(payload.platform || current?.platform || ''),
        customerName: String(payload.customerName || current?.customerName || ''),
        reason: String(payload.reason || current?.reason || ''),
        scope: String(payload.scope || current?.scope || ''),
        muted: true,
        enteredAt: current?.enteredAt || Number(payload.enteredAt) || Date.now(),
        pendingSince: current?.pendingSince || Number(payload.pendingSince) || Number(payload.lastBuyerAt) || 0,
        lastBuyerAt: Number(payload.lastBuyerAt) || current?.lastBuyerAt || 0,
        lastAssistantAt: Number(payload.lastAssistantAt) || current?.lastAssistantAt || 0
      });
      emitChange();
      return next ? { ...next } : null;
    },
    resumeConversation(conversationId) {
      const id = String(conversationId || '').trim();
      if (!id || !entries.has(id)) return false;
      entries.delete(id);
      emitChange();
      return true;
    },
    isMuted(conversationId) {
      return Boolean(entries.get(String(conversationId || '').trim())?.muted);
    },
    getManualConversation(conversationId) {
      const item = entries.get(String(conversationId || '').trim());
      return item ? { ...item } : null;
    },
    snapshot
  };
}

/**
 * 通用按需下载 + 启动处理器
 * @param {object} options
 * @param {string} options.platform - 平台标识 (pdd/qn/dy/ks/jd)
 * @param {function} options.getManager - 获取平台 manager
 * @param {function} options.getOssVersionManager - 获取 OSS 版本管理器
 * @param {function} options.getSendToRenderer - 推送进度到渲染进程
 * @param {object} options.logger
 */
function createPlatformLaunchHandler(options = {}) {
  const { platform, getManager, getOssVersionManager, getSendToRenderer, logger: _logger } = options;
  const logger = _logger || console;

  return async () => {
    logger.log(`[${platform}:launch] launch requested`);
    try {
      const manager = getManager();
      if (!manager) throw new Error(`${platform.toUpperCase()} manager is not initialized.`);
      if (typeof manager.resolveExePath !== 'function') {
        const status = await manager.launch();
        if (status?.lastError) logger.error(`[${platform}:launch] launch returned error status`, status.lastError);
        else logger.log(`[${platform}:launch] launch result`, status);
        return status;
      }

      // 先尝试直接启动（本地已有工作台）
      try {
        const exePath = await manager.resolveExePath();
        if (exePath && require('node:fs').existsSync(exePath)) {
          const status = await manager.launch();
          if (status?.lastError) logger.error(`[${platform}:launch] launch returned error status`, status.lastError);
          else logger.log(`[${platform}:launch] launch result`, status);
          return status;
        }
      } catch (_) {
        // 本地没有，进入下载流程
      }

      // 本地没有工作台 → 自动下载推荐版本
      const oss = getOssVersionManager();
      if (!oss) throw new Error(`OSS version manager is not initialized, cannot download ${platform} workbench.`);

      const send = getSendToRenderer();
      logger.log(`[${platform}:launch] local workbench not found, starting download...`);

      // 通知 UI：开始下载
      if (send) send('platform:download-start', { platform });

      // ensureRecommendation 会检查本地已有 + 自动下载推荐版本 + 带进度回调
      const result = await oss.ensureRecommendation(
        platform,
        // 下载进度回调
        (progress) => {
          if (send) send('platform:download-progress', { platform, phase: 'download', ...progress });
        },
        // 解压进度回调
        (extractProgress) => {
          if (send) send('platform:download-progress', { platform, phase: 'extract', ...extractProgress });
        }
      );

      logger.log(`[${platform}:launch] download complete`, { extractedDir: result.extractedDir });

      // 设置 manager 的 exePath
      if (result.extractedDir) {
        const fs = require('node:fs');
        const path = require('node:path');
        const exeNames = {
          pdd: 'PddWorkbench.exe',
          qn: 'AliWorkbench.exe',
          dy: 'DouyinWorkbench.exe',
          ks: 'KuaishouWorkbench.exe',
          jd: 'JdWorkbench.exe'
        };
        const exeName = exeNames[platform] || `${platform}Workbench.exe`;
        const candidate = path.join(result.extractedDir, exeName);
        if (fs.existsSync(candidate)) {
          manager.exePath = candidate;
          manager.status.exePath = candidate;
        } else {
          // 递归找 exe
          const findExe = (dir, depth = 0) => {
            if (depth > 3) return null;
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isFile() && e.name === exeName) return full;
                if (e.isDirectory()) {
                  const found = findExe(full, depth + 1);
                  if (found) return found;
                }
              }
            } catch (_) {}
            return null;
          };
          const foundExe = findExe(result.extractedDir);
          if (foundExe) {
            manager.exePath = foundExe;
            manager.status.exePath = foundExe;
          }
        }

        if (send) send('platform:download-complete', { platform, extractedDir: result.extractedDir });
      }

      // 下载完成后启动
      const status = await manager.launch();
      if (status?.lastError) logger.error(`[${platform}:launch] post-download launch error`, status.lastError);
      else logger.log(`[${platform}:launch] post-download launch result`, status);
      return status;
    } catch (error) {
      logger.error(`[${platform}:launch] launch failed`, error);
      const send = getSendToRenderer();
      if (send) send('platform:download-error', { platform, error: error.message });
      throw error;
    }
  };
}

function createPddLaunchHandler(options = {}) {
  return createPlatformLaunchHandler({
    platform: 'pdd',
    getManager: options.getPddManager || (() => null),
    getOssVersionManager: options.getOssVersionManager || (() => null),
    getSendToRenderer: options.getSendToRenderer || (() => null),
    logger: options.logger
  });
}

function createQnLaunchHandler(options = {}) {
  return createPlatformLaunchHandler({
    platform: 'qn',
    getManager: options.getQnManager || (() => null),
    getOssVersionManager: options.getOssVersionManager || (() => null),
    getSendToRenderer: options.getSendToRenderer || (() => null),
    logger: options.logger
  });
}

function createSendMessageHandler(options = {}) {
  const getWsServer = options.getWsServer;
  const getPddManager = options.getPddManager;
  const logger = options.logger || console;

  return async (_event, payload) => {
    logger.log('[chat:send-message]', {
      targetId: payload?.targetId,
      textLength: String(payload?.text || '').length
    });

    const manager = getPddManager();
    if (manager?.sendCurrentChatMessage) {
      const result = await manager.sendCurrentChatMessage(payload.text);
      logger.log('[chat:send-native-result]', result);
      return { sent: Boolean(result?.ok), native: true, result };
    }

    const server = getWsServer();
    if (!server) throw new Error('WebSocket server is not initialized.');

    const message = {
      act: 'sendtext',
      id: payload.targetId,
      text: payload.text,
      timestamp: Date.now()
    };
    const sent = server.sendToTarget(payload.targetId, message);
    logger.log('[chat:send-result]', { targetId: payload.targetId, sent });
    return { sent };
  };
}

function createFocusConversationHandler(options = {}) {
  const getWsServer = options.getWsServer;
  const logger = options.logger || console;

  return async (_event, payload) => {
    const conversationId = String(payload?.conversationId || '').trim();
    const platform = String(payload?.platform || 'pdd').trim();
    const customerName = String(payload?.customerName || '').trim();
    if (!conversationId) throw new Error('conversationId is required.');

    const server = getWsServer();
    if (!server) throw new Error('WebSocket server is not initialized.');

    const command = platform === 'qn'
      ? { act: 'switchConversation', id: conversationId, customerName }
      : { act: 'switchConversation', id: conversationId };
    const sent = server.sendToTarget(conversationId, command);
    logger.log('[conversation:focus]', { conversationId, platform, customerName, sent });
    return { sent };
  };
}

function createPddCommandHandler(options = {}) {
  const commandAct = String(options.commandAct || '').trim();
  const getWsServer = options.getWsServer;
  const logger = options.logger || console;

  return async (_event, payload = {}) => {
    if (!commandAct) throw new Error('commandAct is required.');
    const server = getWsServer();
    if (!server) throw new Error('WebSocket server is not initialized.');

    const conversationId = String(payload.conversationId || payload.ccode || payload.targetId || '').trim();
    const message = { act: commandAct };
    if (conversationId) message.id = conversationId;
    if (payload.customerName) message.customerName = payload.customerName;
    if (payload.limit !== undefined) message.limit = payload.limit;
    if (payload.params && typeof payload.params === 'object') message.params = payload.params;

    const sent = server.sendToTarget(conversationId, message);
    logger.log('[pdd:command]', { act: commandAct, conversationId, sent });
    return { sent };
  };
}

function createResumeConversationHandler(options = {}) {
  const handoffStore = options.handoffStore;
  const logger = options.logger || console;

  return async (_event, payload) => {
    const conversationId = String(payload?.conversationId || '').trim();
    if (!conversationId) throw new Error('conversationId is required.');
    const resumed = handoffStore.resumeConversation(conversationId);
    logger.log('[conversation:resume]', { conversationId, resumed });
    return { resumed };
  };
}

// The auto-reply path stays isolated here so bridge/runtime changes do not
// accidentally alter reply orchestration and dedupe semantics.
function createAutoReplyHandler(options = {}) {
  const getWsServer = options.getWsServer;
  const getAiSettings = options.getAiSettings || (() => readAiSettings());
  const handoffStore = options.handoffStore || createConversationHandoffStore();
  const logger = options.logger || console;
  const enabled = options.enabled ?? process.env.PDD_LG_AUTO_REPLY !== '0';
  const replyText = options.replyText || process.env.PDD_LG_AUTO_REPLY_TEXT || '收到0806，自动回复测试';
  const tmagent = options.tmagent || {};
  const maxAutoReplyAgeMs = options.maxAutoReplyAgeMs ?? Number(process.env.PDD_LG_AUTO_REPLY_MAX_AGE_MS || 5 * 60 * 1000);
  const qnSwitchDelayMs = options.qnSwitchDelayMs ?? Number(process.env.PDD_LG_QN_SWITCH_DELAY_MS || 300);
  const pddSendAckTimeoutMs = options.pddSendAckTimeoutMs ?? Number(process.env.PDD_LG_PDD_SEND_ACK_TIMEOUT_MS || 2500);
  const maxSeen = options.maxSeen || 200;
  const seenMessageIds = new Set();
  const inFlightMessageIds = new Set();
  // 订单缓存：用于在文本消息中注入 right_panel 抓取到的订单数据
  const orderCache = options.orderCache || createOrderCache();

  const rememberSeenMessage = (messageKey) => {
    if (!messageKey) return;
    seenMessageIds.add(messageKey);
    if (seenMessageIds.size > maxSeen) {
      seenMessageIds.delete(seenMessageIds.values().next().value);
    }
  };

  // Resolve tmagent config once per handler creation (not per-message)
  const hasExplicitTmagentConfig = Boolean(
    tmagent.apiKey
    || tmagent.baseUrl
    || tmagent.shopId
    || tmagent.shopName
    || tmagent.fetchImpl
  );
  const useTmagent = options.useTmagent
    ?? (hasExplicitTmagentConfig
      ? true
      : (process.env.PDD_LG_USE_TMAGENT === '0' ? false : true));

  // Message buffer for merging bursts within the same conversation
  const buffer = createMessageBuffer({
    bufferMs: Number(process.env.PDD_LG_BUFFER_MS || 2000),
    logger,
    onFlush: async (targetId, mergedPayload, rawMessages) => {
      const server = getWsServer();
      if (!server) {
        logger.log('[buffer:flush-skip]', { reason: 'server-not-ready', targetId });
        return;
      }

      // Mark all source messages as seen
      for (const rawMsg of rawMessages) {
        const key = rawMsg.id || `${targetId}:${rawMsg.timestamp || ''}:${rawMsg.content?.text || ''}`;
        if (key) rememberSeenMessage(key);
      }

      // Re-read AI settings at flush time
      const aiSettings = getAiSettings() || DEFAULT_AI_SETTINGS;
      const tmagentBaseUrl = tmagent.baseUrl || aiSettings.baseUrl || process.env.PDD_LG_TMAGENT_BASE_URL;
      const tmagentShopId = mergedPayload.shop_id || process.env.PDD_LG_TMAGENT_SHOP_ID || '';
      const tmagentShopName = mergedPayload.shop_name || process.env.PDD_LG_TMAGENT_SHOP_NAME || '';
      const tmagentApiKey = useTmagent
        ? (tmagent.apiKey || aiSettings.apiKey || process.env.PDD_LG_TMAGENT_API_KEY || DEFAULT_API_KEY)
        : '';

      if (!tmagentApiKey) {
        logger.log('[buffer:flush-skip]', { reason: 'no-tmagent-apikey', targetId });
        return;
      }

      const conversationId = `${mergedPayload.platform}:${mergedPayload.shop_id}:${mergedPayload.buyer_id}`;

      logger.log('[auto-reply:tmagent-request]', {
        triggerMsgId: rawMessages.map((m) => m.id).join(','),
        messageCount: rawMessages.length,
        targetId,
        platform: mergedPayload.platform,
        endpoint: `${String(tmagentBaseUrl || '').replace(/\/+$/, '')}/api/orchestrate/chat`,
        shopId: mergedPayload.shop_id,
        shopName: mergedPayload.shop_name,
        buyerId: mergedPayload.buyer_id,
        conversationId,
        messageType: mergedPayload.message_type,
        textHash: hashText(mergedPayload.message),
        textSample: mergedPayload.message,
        apiKey: maskSecret(tmagentApiKey)
      });

      try {
        const tmagentResponse = await requestTmagentChat({
          baseUrl: tmagentBaseUrl,
          apiKey: tmagentApiKey,
          payload: mergedPayload,
          fetchImpl: tmagent.fetchImpl
        });

        logger.log('[auto-reply:tmagent-response]', {
          targetId,
          buyerId: mergedPayload.buyer_id,
          conversationId,
          action: tmagentResponse?.action || null,
          replyLength: String(tmagentResponse?.reply || '').trim().length,
          replyHash: hashText(tmagentResponse?.reply || ''),
          replySample: tmagentResponse?.reply || ''
        });

        const tmagentAction = String(tmagentResponse?.action || '');
        const tmagentHandoff = tmagentResponse?.handoff || null;

        if (tmagentAction === 'human_takeover') {
          buffer.cancel(targetId);
          const lastMsg = rawMessages[rawMessages.length - 1] || {};
          handoffStore.markManual({
            conversationId: targetId,
            platform: mergedPayload.platform,
            customerName: lastMsg.senderName || lastMsg.senderId || '',
            reason: String(tmagentResponse?.handoff?.reason || ''),
            scope: String(tmagentResponse?.handoff?.scope || ''),
            pendingSince: Number(lastMsg.timestamp) || Date.now(),
            lastBuyerAt: Number(lastMsg.timestamp) || Date.now()
          });
          logger.log('[auto-reply:handoff]', { targetId, reason: tmagentResponse?.handoff?.reason || '' });
          return { skipped: true, reason: 'human-takeover' };
        }

        const outboundText = String(tmagentResponse?.reply || '').trim();
        if (!outboundText && tmagentAction !== 'transfer_conversation_2') {
          logger.log('[auto-reply:skip]', { reason: 'empty-tmagent-reply', targetId });
          return { skipped: true, reason: 'empty-tmagent-reply' };
        }

        const isQnClient = mergedPayload.platform === 'qianniu';
        const lastMsg = rawMessages[rawMessages.length - 1] || {};
        const qnUserId = normalizeQnUserId(lastMsg.senderName || lastMsg.senderId);
        const transferRequested = tmagentAction === 'transfer_conversation_2';
        const shouldSendOutboundText = Boolean(outboundText);
        const outbound = isQnClient && qnUserId
          ? { act: 'sendMsg', param: { userid: qnUserId, ccode: targetId, msg: outboundText } }
          : { act: 'sendtext', id: targetId, text: outboundText };
        let switchSent = 0;

        if (isQnClient && qnUserId && shouldSendOutboundText) {
          const switchCommand = { act: 'switchConversation', id: targetId, customerName: qnUserId };
          switchSent = server.sendToTarget(targetId, switchCommand);
          logger.log('[auto-reply:qn-switch]', { targetId, customerName: qnUserId, sent: switchSent });
          await delay(qnSwitchDelayMs);
        }

        const sent = shouldSendOutboundText ? server.sendToTarget(targetId, outbound) : 0;
        let sendOutcome = null;
        if (shouldSendOutboundText && !isQnClient && sent > 0) {
          sendOutcome = await waitForPddSendOutcome(server, {
            clientId: lastMsg._clientId || '',
            targetId,
            contentHash: hashText(outboundText),
            timeoutMs: pddSendAckTimeoutMs
          });
        }
        let transferSent = 0;
        if (transferRequested && !isQnClient) {
          const transferCommand = {
            act: 'transferConversation',
            id: targetId,
            transferType: tmagentAction,
            reason: String(tmagentHandoff?.reason || ''),
            scope: String(tmagentHandoff?.scope || '')
          };
          transferSent = server.sendToTarget(targetId, transferCommand);
          handoffStore.markManual({
            conversationId: targetId,
            platform: mergedPayload.platform,
            customerName: lastMsg.senderName || lastMsg.senderId || '',
            reason: transferCommand.reason,
            scope: transferCommand.scope,
            pendingSince: Number(lastMsg.timestamp) || Date.now(),
            lastBuyerAt: Number(lastMsg.timestamp) || Date.now()
          });
          logger.log('[auto-reply:transfer]', {
            targetId,
            sent: transferSent,
            reason: transferCommand.reason,
            scope: transferCommand.scope
          });
        }

        if (shouldSendOutboundText && sendOutcome && sendOutcome.ok === false) {
          logger.log('[auto-reply:send-failed]', {
            targetId,
            triggerMsgIds: rawMessages.map((m) => m.id).join(','),
            error: sendOutcome.error,
            failureType: sendOutcome.type
          });
          return { skipped: true, reason: 'send-failed', error: sendOutcome.error };
        }

        if (shouldSendOutboundText) {
          logger.log('[auto-reply:sent]', {
            targetId,
            sent,
            switchSent,
            transferSent,
            textLength: outboundText.length,
            textSource: 'tmagent',
            triggerMsgIds: rawMessages.map((m) => m.id).join(','),
            messageCount: rawMessages.length,
            buyerId: mergedPayload.buyer_id,
            conversationId,
            outboundTextHash: hashText(outboundText),
            outboundTextSample: outboundText
          });
        }
        return {
          sent,
          switchSent,
          transferSent,
          message: shouldSendOutboundText ? outbound : null
        };
      } catch (error) {
        logger.error('[auto-reply:tmagent-error]', error);
        return { skipped: true, reason: 'tmagent-error', error: error.message || String(error) };
      }
    }
  });

  return async (payload) => {
    const message = payload?.message;
    if (!enabled) return { skipped: true, reason: 'disabled' };
    if (!message || message.direction !== 'user' || (message.kind !== 'text' && message.kind !== 'image' && message.kind !== 'goods' && message.kind !== 'order')) {
      return { skipped: true, reason: 'not-buyer-text' };
    }
    if (message.timestamp && maxAutoReplyAgeMs > 0 && Date.now() - Number(message.timestamp) > maxAutoReplyAgeMs) {
      logger.log('[auto-reply:skip]', { reason: 'stale-message', msgId: message.id, timestamp: message.timestamp });
      return { skipped: true, reason: 'stale-message' };
    }

    const targetId = message.conversationId;
    if (!targetId || targetId === 'unknown') {
      logger.log('[auto-reply:skip]', { reason: 'missing-target', msgId: message.id });
      return { skipped: true, reason: 'missing-target' };
    }
    if (handoffStore.isMuted(targetId)) {
      logger.log('[auto-reply:skip]', { reason: 'human-takeover-muted', targetId, msgId: message.id });
      return { skipped: true, reason: 'human-takeover-muted' };
    }

    const messageKey = message.id || `${targetId}:${message.timestamp || ''}:${message.content?.text || ''}`;
    if (messageKey && inFlightMessageIds.has(messageKey)) {
      logger.log('[auto-reply:skip]', { reason: 'duplicate-inflight', targetId, msgId: message.id });
      return { skipped: true, reason: 'duplicate-inflight' };
    }
    if (messageKey && seenMessageIds.has(messageKey)) {
      logger.log('[auto-reply:skip]', { reason: 'duplicate', targetId, msgId: message.id });
      return { skipped: true, reason: 'duplicate' };
    }

    const server = getWsServer();
    if (!server) {
      logger.log('[auto-reply:skip]', { reason: 'server-not-ready', targetId });
      return { skipped: true, reason: 'server-not-ready' };
    }
    if (messageKey) inFlightMessageIds.add(messageKey);

    try {
      const aiSettings = getAiSettings() || DEFAULT_AI_SETTINGS;
      const shopOverride = resolveShopOverride(aiSettings, payload?.client);
      if (aiSettings.enabled === false) {
        logger.log('[auto-reply:skip]', { reason: 'global-ai-disabled', targetId });
        rememberSeenMessage(messageKey);
        return { skipped: true, reason: 'global-ai-disabled' };
      }
      if (shopOverride?.enabled === false) {
        logger.log('[auto-reply:skip]', {
          reason: 'shop-ai-disabled',
          targetId,
          platform: payload?.client?.platform || '',
          shopId: payload?.client?.shopId || ''
        });
        rememberSeenMessage(messageKey);
        return { skipped: true, reason: 'shop-ai-disabled' };
      }

      const tmagentShopId = payload?.client?.shopId
        || tmagent.shopId
        || aiSettings.tenantId
        || process.env.PDD_LG_TMAGENT_SHOP_ID;
      const tmagentShopName = payload?.client?.shopName || tmagent.shopName || aiSettings.merchantName || process.env.PDD_LG_TMAGENT_SHOP_NAME;
      const tmagentApiKey = useTmagent
        ? (tmagent.apiKey || aiSettings.apiKey || process.env.PDD_LG_TMAGENT_API_KEY || DEFAULT_API_KEY)
        : '';

      if (tmagentApiKey) {
        // Build payload and enqueue into buffer (not immediate request)
        const tmagentPayload = buildTmagentChatPayload(payload, {
          platform: payload?.client?.platform,
          shopId: tmagentShopId,
          shopName: tmagentShopName,
          orderCache
        });

        // Attach clientId for later send-outcome tracking
        const rawMsg = { ...message, _clientId: payload?.client?.id };
        buffer.add(targetId, tmagentPayload, rawMsg);
        if (tmagent.fetchImpl || options.flushTmagentImmediately) {
          return await buffer.flush(targetId);
        }

        // Return immediately; the actual request+reply will happen in buffer.onFlush
        return { buffered: true, targetId };
      }

      // Static reply fallback (no tmagent)
      const outboundText = replyText;
      const isQnClient = normalizePlatform(payload?.client?.platform) === 'qianniu';
      const qnUserId = normalizeQnUserId(message.senderName || message.senderId);
      let switchSent = 0;
      if (isQnClient && qnUserId) {
        const switchCommand = { act: 'switchConversation', id: targetId, customerName: qnUserId };
        switchSent = server.sendToTarget(targetId, switchCommand);
        logger.log('[auto-reply:qn-switch]', { targetId, customerName: qnUserId, sent: switchSent });
        await delay(qnSwitchDelayMs);
      }
      const outbound = isQnClient && qnUserId
        ? { act: 'sendMsg', param: { userid: qnUserId, ccode: targetId, msg: outboundText } }
        : { act: 'sendtext', id: targetId, text: outboundText };
      const sent = server.sendToTarget(targetId, outbound);
      let sendOutcome = null;
      if (sent > 0) {
        sendOutcome = await waitForPddSendOutcome(server, {
          clientId: payload?.client?.id,
          targetId,
          contentHash: hashText(outboundText),
          timeoutMs: pddSendAckTimeoutMs
        });
      }

      if (sendOutcome && sendOutcome.ok === false) {
        logger.log('[auto-reply:send-failed]', {
          targetId,
          triggerMsgId: message.id,
          messageKey,
          error: sendOutcome.error,
          failureType: sendOutcome.type
        });
        return { skipped: true, reason: 'send-failed', error: sendOutcome.error };
      }

      rememberSeenMessage(messageKey);
      logger.log('[auto-reply:sent]', {
        targetId,
        sent,
        textLength: outboundText.length,
        textSource: 'static',
        triggerMsgId: message.id,
        messageKey,
        buyerId: message.senderId || '',
        conversationId: message.conversationId,
        inboundTextHash: hashText(message.content?.text),
        outboundTextHash: hashText(outboundText),
        inboundTextSample: message.content?.text,
        outboundTextSample: outboundText
      });
      return { sent, switchSent, message: outbound };
    } catch (error) {
      logger.error('[auto-reply:tmagent-error]', error);
      return { skipped: true, reason: 'tmagent-error', error: error.message || String(error) };
    } finally {
      if (messageKey) inFlightMessageIds.delete(messageKey);
    }
  };
}

module.exports = {
  createConversationHandoffStore,
  createPlatformLaunchHandler,
  createPddLaunchHandler,
  createQnLaunchHandler,
  createSendMessageHandler,
  createPddCommandHandler,
  createFocusConversationHandler,
  createResumeConversationHandler,
  createAutoReplyHandler
};
