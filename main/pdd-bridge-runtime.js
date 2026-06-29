'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const noopLogger = { log() {}, error() {} };

function normalizeShopLabel(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function looksLikePddShopName(value) {
  const text = normalizeShopLabel(value);
  if (!text) return false;
  if (text.length < 2 || text.length > 40) return false;
  if (!/[\u4e00-\u9fff]/.test(text)) return false;
  if (!/(店|旗舰店|专营店|专卖店|企业店|官方店|个体店)/.test(text)) return false;
  if (/^(主账号|子账号|在线|离线|展开|收起|查询|待办|会话|接待|订单|推荐|回复|详情)$/.test(text)) return false;
  return true;
}

function pickBestPddShopName(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  let best = '';
  let bestScore = -1;
  for (const item of list) {
    const text = normalizeShopLabel(item?.text);
    if (!looksLikePddShopName(text)) continue;
    let score = 0;
    if (item?.active) score += 100;
    if (item?.top != null && item.top <= 140) score += 40;
    if (item?.top != null && item.top <= 80) score += 20;
    if (item?.left != null && item.left <= 900) score += 10;
    if (/旗舰店|官方店/.test(text)) score += 8;
    if (/店$/.test(text)) score += 4;
    if (text.length <= 16) score += 2;
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  }
  return best;
}

function isPddBridgeClient(client) {
  const platform = String(client?.platform || '').trim().toLowerCase();
  return platform === 'pdd' || platform === 'publicplatform';
}

function createPddBridgeScript(wsPort) {
  const fallbackPort = Number(wsPort || 0);
  return `(() => {
  console.log('[pdd-bridge] loaded');

  const rawData = window.js_data;
  const port = Number(
    rawData && typeof rawData === 'object'
      ? (rawData.wsPort || rawData.port || rawData.publicPlatformPort)
      : (rawData || ${fallbackPort})
  );

  if (!port) {
    console.log('[pdd-bridge] missing websocket port', rawData);
    return;
  }

  const wsOrigin = \`ws://127.0.0.1:\${port}/publicplatform\`;
  if (window.__pddFukeBridgeSocket && window.__pddFukeBridgeSocket.readyState < 2) {
    window.__pddFukeBridgeSocket.close();
  }

  const scriptUrl = (() => {
    try {
      const currentScript = document.currentScript;
      if (currentScript?.src) return new URL(currentScript.src, location.href);
    } catch {}
    try {
      return new URL(location.href);
    } catch {
      return null;
    }
  })();
  const beaconBaseUrl = scriptUrl ? scriptUrl.origin + '/pdd-bridge-beacon' : '';
  const BridgeWebSocket = window.WebSocket;
  const pendingDiagnostics = [];

  function bridgeHttpBeacon(name, payload = {}) {
    if (!beaconBaseUrl) return;
    try {
      const params = new URLSearchParams();
      params.set('name', String(name || ''));
      for (const [key, value] of Object.entries(payload || {})) {
        params.set(key, typeof value === 'string' ? value : sample(value));
      }
      const image = new Image();
      image.src = beaconBaseUrl + '?' + params.toString();
    } catch {}
  }

  bridgeHttpBeacon('bridge-js-entered', {
    href: location.href,
    readyState: document.readyState,
    top: window.top === window ? '1' : '0'
  });

  function sample(value) {
    try {
      if (typeof value === 'string') return value.slice(0, 200);
      if (value instanceof ArrayBuffer) return '[ArrayBuffer ' + value.byteLength + ']';
      if (value && typeof value === 'object' && 'data' in value) return sample(value.data);
      return JSON.stringify(value).slice(0, 200);
    } catch {
      return String(value).slice(0, 200);
    }
  }

  const normalizeShopLabel = ${normalizeShopLabel.toString()};
  const looksLikePddShopName = ${looksLikePddShopName.toString()};
  const pickBestPddShopName = ${pickBestPddShopName.toString()};

  let socket = null;

  function getActiveSocket() {
    return window.__pddFukeBridgeSocket || socket || null;
  }

  function emitDiagnostic(name, payload = {}) {
    const activeSocket = getActiveSocket();
    if (!activeSocket || activeSocket.readyState !== BridgeWebSocket.OPEN) return;
    activeSocket.send(JSON.stringify({
      type: 'diagnostic',
      source: 'pdd-bridge',
      name,
      payload,
      time: Date.now()
    }));
  }

  function sendDiagnostic(name, payload = {}) {
    const activeSocket = getActiveSocket();
    if (!activeSocket) {
      pendingDiagnostics.push({ name, payload });
      return;
    }
    if (activeSocket.readyState === BridgeWebSocket.OPEN) {
      emitDiagnostic(name, payload);
      return;
    }
    pendingDiagnostics.push({ name, payload });
  }

  function flushPendingDiagnostics() {
    const activeSocket = getActiveSocket();
    while (activeSocket && activeSocket.readyState === BridgeWebSocket.OPEN && pendingDiagnostics.length > 0) {
      const item = pendingDiagnostics.shift();
      emitDiagnostic(item.name, item.payload);
    }
  }

  function safeParse(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  }

  const TRANSFER_TEXT_RE = /转移|转接|会话|微信通知|无原因直接转移|催发货|催售后处理|发货\\\/物流问题|退款\\\/退货问题|换货问题/i;
  const TRANSFER_URL_RE = /refraction\\\/robot\\\/mall\\\/chat|popup|transfer|handoff/i;

  function isVisibleElement(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getElementText(element) {
    try {
      return String(
        element?.innerText ||
        element?.textContent ||
        element?.value ||
        element?.getAttribute?.('aria-label') ||
        ''
      ).replace(/\\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }

  function getElementSummary(element) {
    if (!element) return null;
    try {
      const rect = typeof element.getBoundingClientRect === 'function'
        ? element.getBoundingClientRect()
        : { x: 0, y: 0, width: 0, height: 0 };
      return {
        tag: String(element.tagName || ''),
        className: String(element.className || '').slice(0, 200),
        text: getElementText(element).slice(0, 200),
        role: String(element.getAttribute?.('role') || ''),
        dataTestid: String(element.getAttribute?.('data-testid') || ''),
        href: String(element.getAttribute?.('href') || ''),
        x: Math.round(rect.x || 0),
        y: Math.round(rect.y || 0),
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0)
      };
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  }

  function isTransferRelevantElement(element) {
    if (!element) return false;
    const text = getElementText(element);
    const cls = String(element.className || '');
    const aria = String(element.getAttribute?.('aria-label') || '');
    return TRANSFER_TEXT_RE.test(text) || TRANSFER_TEXT_RE.test(cls) || TRANSFER_TEXT_RE.test(aria);
  }

  function isTransferRelevantUrl(urlText) {
    return TRANSFER_URL_RE.test(String(urlText || ''));
  }

  function isTransferRelevantPayload(value) {
    return TRANSFER_TEXT_RE.test(sample(value)) || TRANSFER_URL_RE.test(sample(value));
  }

  function collectTransferUiItems() {
    const nodes = Array.from(document.querySelectorAll('body *'));
    const items = [];
    for (const node of nodes) {
      if (!isVisibleElement(node) || !isTransferRelevantElement(node)) continue;
      items.push(getElementSummary(node));
      if (items.length >= 12) break;
    }
    return items;
  }

  function emitTransferUiSnapshot(reason) {
    try {
      const items = collectTransferUiItems();
      if (!items.length) return;
      const conversation = getCurrentConversation();
      const payload = {
        reason,
        conversationId: String(conversation?.UIDSwitchInfo || ''),
        items
      };
      const signature = JSON.stringify(payload);
      if (signature === window.__pddFukeLastTransferUiSignature) return;
      window.__pddFukeLastTransferUiSignature = signature;
      sendDiagnostic('transfer-ui', payload);
    } catch (error) {
      sendDiagnostic('transfer-ui-error', { reason, message: String(error?.message || error) });
    }
  }

  function getCurrentUserInfo() {
    try {
      const app = document.getElementById('app');
      const storeUser = app?.__vue__?.$store?.state?.userInfo;
      if (storeUser) return storeUser;
      if (window.localStorage?.userinfo) return JSON.parse(window.localStorage.userinfo);
    } catch (error) {
      sendDiagnostic('pdd-userinfo-error', { message: String(error?.message || error) });
    }
    return null;
  }

  function buildHandshakeUrl() {
    const user = getCurrentUserInfo();
    const params = new URLSearchParams();
    params.set('platform', 'pdd');

    const shopName = normalizeShopLabel(user?.mall?.mall_name || user?.mall_name || '');
    const username = String(user?.username || '').trim();
    const targetId = String(user?.cs_id || '').trim();
    const csrName = shopName && username ? \`\${shopName}:\${username}\` : (shopName || username);

    if (csrName) params.set('csrName', csrName);
    if (targetId) params.set('targetId', targetId);

    const query = params.toString();
    return query ? \`\${wsOrigin}?\${query}\` : wsOrigin;
  }

  function resolveTopShopNameFromDom() {
    const seen = new Set();
    const candidates = [];
    const collect = (nodes, forceActive = false) => {
      for (const node of nodes) {
        if (!node || typeof node.getBoundingClientRect !== 'function') continue;
        const text = normalizeShopLabel(node.innerText || node.textContent || '');
        if (!looksLikePddShopName(text) || seen.has(text)) continue;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
        if (!rect || rect.width < 20 || rect.height < 12) continue;
        if (rect.top < -10 || rect.top > 140) continue;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
        seen.add(text);
        candidates.push({
          text,
          top: rect.top,
          left: rect.left,
          active: forceActive || node.matches?.('.is-active, .active, [aria-selected="true"]')
        });
      }
    };
    collect(Array.from(document.querySelectorAll('.is-active, .active, [aria-selected="true"]')), true);
    collect(Array.from(document.querySelectorAll('body *')));
    return pickBestPddShopName(candidates);
  }

  function resolveCurrentShopName(user) {
    return normalizeShopLabel(
      resolveTopShopNameFromDom()
      || user?.mall?.mall_name
      || user?.mall_name
      || ''
    );
  }

  let pendingCurrentCsrTimer = null;
  let lastCurrentCsrSignature = '';

  function emitCurrentCsr(reason) {
    const user = getCurrentUserInfo();
    if (!user) return;
    const shopName = resolveCurrentShopName(user);
    const shopId = String(user?.mall_id || user?.mall?.mall_id || user?.mall?.id || '').trim();
    const username = String(user?.username || '').trim();
    const targetId = String(user?.cs_id || '').trim();
    const nick = shopName && username ? shopName + ':' + username : username;
    const signature = [shopName, shopId, username, targetId].join('|');
    if (reason !== 'command' && signature && signature === lastCurrentCsrSignature) return;
    lastCurrentCsrSignature = signature;
    sendDiagnostic('current-shop-detected', { reason, shopName, shopId, username, targetId });
    sendBridgeEvent('currentCsr', {
      nick,
      display: username,
      targetId,
      shopName,
      shopId,
      mallId: shopId,
      platform: 'pdd'
    });
  }

  function scheduleCurrentCsr(reason, delay = 120) {
    if (pendingCurrentCsrTimer) return;
    pendingCurrentCsrTimer = setTimeout(() => {
      pendingCurrentCsrTimer = null;
      emitCurrentCsr(reason);
    }, delay);
  }

  function installShopObserver() {
    if (window.__pddFukeShopObserverInstalled) return;
    window.__pddFukeShopObserverInstalled = true;
    const root = document.body || document.documentElement;
    if (!root || typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(() => scheduleCurrentCsr('shop-tab-change'));
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-selected']
    });
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('focus', () => scheduleCurrentCsr('window-focus', 0));
    }
    scheduleCurrentCsr('observer-installed', 0);
  }

  function getCurrentConversation() {
    try {
      const app = document.getElementById('app');
      return app?.__vue__?.$store?.state?.currentUserInfo || window.currentUserInfo || null;
    } catch {
      return null;
    }
  }

  function getConversationId(message, fallback) {
    return String(
      fallback ||
      message?.from?.role === 'user' && message?.from?.uid ||
      message?.to?.role === 'user' && message?.to?.uid ||
      message?.from?.uid ||
      message?.to?.uid ||
      getCurrentConversation()?.UIDSwitchInfo ||
      ''
    );
  }

  // --- 消息去重 ---
  const MSG_DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 分钟内同 ID 消息视为重复
  const msgDedupeCache = new Map(); // ccode -> Map<msgId, timestamp>
  const msgDedupeSets = new Map();   // ccode -> Set<msgId> (per-ccode, 用于 UIDSwitchInfo="" 时清理)

  function extractMessageId(message) {
    if (!message) return '';
    return String(
      message.msg_id || message.message_id || message.messageId || message.id || ''
    );
  }

  function isDuplicateMessage(ccode, message) {
    const msgId = extractMessageId(message);
    if (!msgId) return false;

    // per-ccode Set 检查（已确认发送过的）
    const ccodeSet = msgDedupeSets.get(ccode);
    if (ccodeSet && ccodeSet.has(msgId)) return true;

    // TTL 缓存检查
    const ccodeCache = msgDedupeCache.get(ccode);
    if (ccodeCache) {
      const ts = ccodeCache.get(msgId);
      if (ts && Date.now() - ts < MSG_DEDUPE_TTL_MS) {
        console.log('[pdd-bridge] dedupe skip', ccode, msgId);
        return true;
      }
    }
    return false;
  }

  function markMessageSeen(ccode, message) {
    const msgId = extractMessageId(message);
    if (!msgId) return;

    // TTL 缓存
    let ccodeCache = msgDedupeCache.get(ccode);
    if (!ccodeCache) {
      ccodeCache = new Map();
      msgDedupeCache.set(ccode, ccodeCache);
    }
    ccodeCache.set(msgId, Date.now());

    // per-ccode Set
    let ccodeSet = msgDedupeSets.get(ccode);
    if (!ccodeSet) {
      ccodeSet = new Set();
      msgDedupeSets.set(ccode, ccodeSet);
    }
    ccodeSet.add(msgId);
  }

  function clearDedupeForConversation(ccode) {
    msgDedupeCache.delete(ccode);
    msgDedupeSets.delete(ccode);
  }

  // 定期清理过期 TTL 条目
  setInterval(() => {
    const now = Date.now();
    for (const [ccode, cache] of msgDedupeCache) {
      for (const [msgId, ts] of cache) {
        if (now - ts >= MSG_DEDUPE_TTL_MS) cache.delete(msgId);
      }
      if (cache.size === 0) msgDedupeCache.delete(ccode);
    }
  }, 60 * 1000);
  // --- 消息去重 end ---

  // --- 订单号/物流号自动提取 ---
  // 拼多多订单号特征：① 日期-数字格式（如 260611-572543547733884）② 18-30位纯数字
  const ORDER_SN_RE = /\b(\d{6}-\d{15,30}|\d{18,30})\b/g;
  // 物流单号常见前缀模式
  const EXPRESS_NO_RE = /\b((?:JD|SF|YT|YTO|STO|ZTO|DBL|HTKY|YD|EMS|UPS|DHL|FEDEX|TNT|BEST|TTK|ANE|UC|QFKD|JDKY|JTSD|DBKD|ZJS|YCG|GTO|AJ|SX|JTSD|DSK|DTW|GTSD|CITY)[A-Z0-9]{8,30}|(?:JDV?C?|SF|YT|YTO|STO|ZTO|DBL|HTKY|YD|EMS)[A-Z0-9]{8,30}|[A-Z]{2}[0-9]{9,20}[A-Z]{2}|[A-Z0-9]{10,30})\b/gi;

  function extractOrderSnsFromText(text) {
    if (!text) return [];
    const sns = [];
    const re = new RegExp(ORDER_SN_RE.source, 'g');
    let match;
    while ((match = re.exec(text)) !== null) {
      const sn = match[1];
      // 过滤掉明显不是订单号的（如纯0、时间戳等）
      if (/^0+$/.test(sn)) continue;
      if (!sns.includes(sn)) sns.push(sn);
    }
    return sns.slice(0, 5); // 最多提取5个
  }

  function extractExpressNosFromText(text) {
    if (!text) return [];
    const nos = [];
    const re = new RegExp(EXPRESS_NO_RE.source, 'gi');
    let match;
    while ((match = re.exec(text)) !== null) {
      const no = match[1];
      if (/^0+$/.test(no)) continue;
      if (!nos.includes(no)) nos.push(no);
    }
    return nos.slice(0, 5);
  }

  // 递归从消息对象中提取文本内容
  function extractAllTextsFromMessage(message, depth = 0) {
    if (!message || depth > 5) return '';
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map((item) => extractAllTextsFromMessage(item, depth + 1)).join(' ');
    if (typeof message === 'object') {
      const parts = [];
      // 优先提取已知的文本字段
      const textKeys = ['content', 'text', 'msg', 'body', 'title', 'goodsName', 'goods_name', 'orderSn', 'order_sn', 'trackingNumber', 'expressNo', 'express_no'];
      for (const key of textKeys) {
        if (message[key] !== undefined && message[key] !== null) {
          parts.push(String(message[key]));
        }
      }
      // 递归其他字段
      for (const [key, value] of Object.entries(message)) {
        if (textKeys.includes(key)) continue;
        if (key === 'from' || key === 'to' || key === 'raw' || key === 'userinfo') continue;
        if (typeof value === 'string') parts.push(value);
        else if (typeof value === 'object') parts.push(extractAllTextsFromMessage(value, depth + 1));
      }
      return parts.join(' ');
    }
    return String(message || '');
  }

  // 从消息中提取订单号和物流号并实时上报
  function extractAndReportOrderInfo(source, message, ccode) {
    const fullText = extractAllTextsFromMessage(message);
    const orderSns = extractOrderSnsFromText(fullText);
    const expressNos = extractExpressNosFromText(fullText);

    if (orderSns.length > 0 || expressNos.length > 0) {
      sendDiagnostic('order-extracted-from-message', {
        source,
        ccode,
        order_sns: orderSns,
        express_nos: expressNos,
        text_sample: fullText.slice(0, 200)
      });
      // 也通过 bridge event 上报，方便服务端实时处理
      sendBridgeEvent('orderExtracted', {
        source,
        ccode,
        order_sns: orderSns,
        express_nos: expressNos
      });
    }
  }

  function sendPddMessage(source, message, fallbackCcode) {
    const activeSocket = getActiveSocket();
    if (!message || !activeSocket || activeSocket.readyState !== BridgeWebSocket.OPEN) return;
    const ccode = getConversationId(message, fallbackCcode);
    if (isDuplicateMessage(ccode, message)) return;
    markMessageSeen(ccode, message);
    // 自动提取订单号/物流号
    extractAndReportOrderInfo(source, message, ccode);
    activeSocket.send(JSON.stringify({
      type: 'message',
      source,
      msg: [message],
      param: { ccode },
      saveMessages: [message]
    }));
  }

  function installPddNativeHooks() {
    if (window.__pddFukeNativeHooksInstalled) return;
    window.__pddFukeNativeHooksInstalled = true;

    const installPinnotificationHook = () => {
      if (!window.pinnotification?.message || window.__pddFukePinnotificationHooked) return;
      window.__pddFukePinnotificationHooked = true;
      const nativeMessage = window.pinnotification.message;
      window.__pddFukeOriginalPinnotificationMessage = nativeMessage;
      window.pinnotification.message = function pddFukePinnotificationMessage(name, payload) {
        const parsed = safeParse(payload) || {};
        if ((name && /popup|transfer|conversation|notify|robot/i.test(String(name))) || isTransferRelevantPayload(parsed)) {
          sendDiagnostic('transfer-native-event', {
            target: 'pinnotification.message',
            name: String(name || ''),
            sample: sample(parsed)
          });
        }
        if (name === 'MMSSocketReceiveMessage' && parsed.message) {
          sendPddMessage('pinnotification.MMSSocketReceiveMessage', parsed.message);
        }
        if (name === 'UIDSwitchInfo') {
          const uid = parsed.UIDSwitchInfo;
          if (uid === '') {
            // 会话关闭：清理当前会话的去重缓存
            const conversation = getCurrentConversation();
            const prevCcode = conversation?.UIDSwitchInfo || '';
            if (prevCcode) clearDedupeForConversation(prevCcode);
            sendDiagnostic('close-conv', { ccode: prevCcode });
          }
          // 切换用户时自动拉取订单列表
          if (uid) {
            handleGetUserOrders({ uid }).catch(() => {});
          }
          const activeSocket = getActiveSocket();
          if (activeSocket?.readyState === BridgeWebSocket.OPEN) {
            activeSocket.send(JSON.stringify({
              type: 'session',
              sessionId: uid || '',
              payload: parsed
            }));
          }
        }
        return nativeMessage.apply(this, arguments);
      };
      sendDiagnostic('pdd-native-hooked', { target: 'pinnotification.message' });
    };

    installPinnotificationHook();
    const hookTimer = setInterval(() => {
      installPinnotificationHook();
      if (window.__pddFukePinnotificationHooked) clearInterval(hookTimer);
    }, 1000);

    if (!window.__pddFukeOriginalOnNativeEvent) {
      window.__pddFukeOriginalOnNativeEvent = window.OnNativeEvent;
      window.OnNativeEvent = function pddFukeOnNativeEvent(name, payload) {
        const parsed = safeParse(payload) || {};
        if ((name && /popup|transfer|conversation|notify|robot/i.test(String(name))) || isTransferRelevantPayload(parsed)) {
          sendDiagnostic('transfer-native-event', {
            target: 'window.OnNativeEvent',
            name: String(name || ''),
            sample: sample(parsed)
          });
        }
        if ((name === 'recv_message' || name === 'send_message') && parsed.message) {
          sendPddMessage(name, parsed.message);
        }
        if (name === 'account_select') {
          sendDiagnostic('pdd-account-select', { sample: sample(parsed) });
        }
        if (typeof window.__pddFukeOriginalOnNativeEvent === 'function') {
          return window.__pddFukeOriginalOnNativeEvent.apply(this, arguments);
        }
        return undefined;
      };
      sendDiagnostic('pdd-native-hooked', { target: 'window.OnNativeEvent' });
    }
  }

  function normalizeSendCommand(command) {
    if (command?.act === 'sendMsg') return command;
    if (command?.act === 'switchConversation') return command;
    if (command?.act === 'transferConversation') return command;
    if (command?.act === 'getCurrentCsr') return command;
    if (command?.act === 'getCurrentConv') return command;
    if (command?.act === 'getRemoteHisMsg') return command;
    if (command?.act === 'queryOrderRemark') return command;
    if (command?.act === 'setOrderRemark') return command;
    if (command?.act === 'autoOrderMessage') return command;
    if (command?.act === 'getUserOrders') return command;
    if (command?.act === 'getOrderInfo') return command;
    if (command?.act === 'getOrderLogistics') return command;
    if (command?.act === 'sendtext') {
      return { act: 'sendMsg', content: command.text, uid: command.id, csid: command.csid };
    }
    if (command?.type === 'message' && command?.act === 'send') {
      return {
        act: 'sendMsg',
        content: command.param?.content,
        uid: command.param?.targetId,
        csid: command.param?.csid
      };
    }
    return command;
  }

  function hashText(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function inferSendCallbackOk(result) {
    if (result == null || result === '') return true;
    if (typeof result === 'boolean') return result;
    if (typeof result === 'number') return result >= 0;
    if (typeof result === 'string') {
      const text = result.trim().toLowerCase();
      if (!text) return true;
      if (/(fail|error|false|失败|错误)/i.test(text)) return false;
      return true;
    }
    if (typeof result === 'object') {
      if (result.ok === false || result.success === false) return false;
      if (result.error || result.errorMsg || result.message === '操作失败') return false;
      return true;
    }
    return true;
  }

  async function requestPddJson(endpoint, payload) {
    const response = await window.fetch('https://mms.pinduoduo.com' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ' ' + endpoint);
    }
    return response.json();
  }

  async function requestPddGetJson(endpoint, params) {
    const query = new URLSearchParams(params || {}).toString();
    const url = 'https://mms.pinduoduo.com' + endpoint + (query ? '?' + query : '');
    const response = await window.fetch(url, { method: 'GET' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ' ' + endpoint);
    }
    return response.json();
  }

  function normalizeTransferAccounts(rawAccounts, user) {
    const shopName = resolveCurrentShopName(user);
    const list = [];
    if (Array.isArray(rawAccounts)) {
      for (const item of rawAccounts) list.push(item);
    } else if (rawAccounts && typeof rawAccounts === 'object') {
      for (const [key, item] of Object.entries(rawAccounts)) {
        if (item && typeof item === 'object') list.push({ accountId: key, ...item });
      }
    }
    return list.map((item) => {
      const accountId = String(item.accountId || item.csid || item.id || '');
      const username = String(item.username || item.name || '').trim();
      const nick = String(item.nick || item.nickname || '').trim();
      const display = nick || (shopName && username ? shopName + ':' + username : username || accountId);
      return { accountId, username, nick: display, raw: item };
    }).filter((item) => item.accountId);
  }

  function resolveTransferTarget(accounts, command) {
    const requestedId = String(command?.toId || command?.accountId || '').trim();
    const requestedName = String(command?.csrName || '').trim();
    if (requestedId) return accounts.find((item) => item.accountId === requestedId) || null;
    if (requestedName) return accounts.find((item) => item.nick === requestedName || item.username === requestedName) || null;
    const masterAccounts = accounts.filter((item) => item.username === '主账号' || item.nick === '主账号' || /:主账号$/.test(item.nick));
    if (masterAccounts.length === 1) return masterAccounts[0];
    if (accounts.length === 1) return accounts[0];
    return null;
  }

  function sendBridgeEvent(type, msg, param) {
    const activeSocket = getActiveSocket();
    if (!activeSocket || activeSocket.readyState !== BridgeWebSocket.OPEN) return false;
    const payload = { type, msg };
    if (param && typeof param === 'object') payload.param = param;
    activeSocket.send(JSON.stringify(payload));
    return true;
  }

  async function handleTransferCommand(command) {
    const conversationId = String(command?.id || getCurrentConversation()?.UIDSwitchInfo || '').trim();
    if (!conversationId) {
      sendDiagnostic('transfer-result', {
        ok: false,
        reason: String(command?.reason || ''),
        error: 'missing-conversation-id'
      });
      return;
    }

    const user = getCurrentUserInfo();
    const assignResponse = await requestPddJson('/latitude/assign/getAssignCsList', { wechatCheck: false });
    const accounts = normalizeTransferAccounts(assignResponse?.result?.csList || assignResponse?.csList || assignResponse?.result, user);
    const target = resolveTransferTarget(accounts, command);

    sendDiagnostic('transfer-accounts', {
      conversationId,
      count: accounts.length,
      accounts: accounts.map((item) => ({
        accountId: item.accountId,
        username: item.username,
        nick: item.nick
      }))
    });

    if (!target) {
      sendDiagnostic('transfer-result', {
        ok: false,
        conversationId,
        reason: String(command?.reason || ''),
        error: accounts.length > 1 ? 'ambiguous-target' : 'target-not-found'
      });
      return;
    }

    const movePayload = {
      targetCsid: target.accountId,
      uid: conversationId,
      reason: String(command?.reason || ''),
      bizType: 0
    };
    const moveResponse = await requestPddJson('/plateau/chat/move_conversation', movePayload);
    sendDiagnostic('transfer-result', {
      ok: Boolean(moveResponse?.success),
      conversationId,
      target: {
        accountId: target.accountId,
        username: target.username,
        nick: target.nick
      },
      reason: String(command?.reason || ''),
      response: moveResponse
    });
  }

  async function handleSwitchConversation(command) {
    const targetId = String(command?.id || '').trim();
    if (!targetId) {
      sendDiagnostic('switch-conversation-result', { ok: false, error: 'missing-target-id' });
      return;
    }
    const app = document.getElementById('app');
    const store = app?.__vue__?.$store;
    const current = getCurrentConversation();
    if (current?.UIDSwitchInfo === targetId) {
      sendDiagnostic('switch-conversation-result', { ok: true, targetId, skipped: 'already-active' });
      return;
    }
    try {
      if (store?.dispatch) {
        await store.dispatch('switchConversation', { uid: targetId });
        sendDiagnostic('switch-conversation-result', { ok: true, targetId, route: 'store.dispatch' });
        return;
      }
    } catch (error) {
      sendDiagnostic('switch-conversation-result', {
        ok: false,
        targetId,
        route: 'store.dispatch',
        error: String(error?.message || error)
      });
    }
    sendDiagnostic('switch-conversation-result', { ok: false, targetId, error: 'no-switch-handler' });
  }

  async function handleGetCurrentCsr() {
    const user = getCurrentUserInfo();
    if (!user) {
      sendBridgeEvent('currentCsr', { nick: '', display: '', targetId: '', platform: 'pdd' });
      return;
    }
    emitCurrentCsr('command');
  }

  async function handleGetCurrentConv() {
    const conversation = getCurrentConversation();
    if (!conversation) {
      sendBridgeEvent('currentConv', { nick: '', display: '', ccode: '' });
      return;
    }
    const nickname = String(conversation?.userinfo?.nickname || conversation?.nickname || '');
    sendBridgeEvent('currentConv', {
      nick: nickname,
      display: nickname,
      ccode: String(conversation?.UIDSwitchInfo || '')
    });
  }

  async function handleGetRemoteHisMsg(command) {
    const conversation = getCurrentConversation();
    const ccode = String(command?.id || command?.ccode || conversation?.UIDSwitchInfo || '').trim();
    if (!ccode) {
      sendBridgeEvent('remote_his_message', [], { ccode: '', error: 'missing-ccode' });
      return;
    }

    const requestId = String(Date.now()) + Math.random().toString(16).slice(2, 6);
    const response = await requestPddJson('/plateau/chat/list', {
      data: {
        cmd: 'list',
        request_id: 100000000 + Number(requestId.slice(-8) || 0),
        list: {
          with: { role: 'user', id: ccode },
          start_msg_id: '99999999999999',
          begin_msg_id: '99999999999999',
          start_index: 0,
          size: Number(command?.limit || 20)
        }
      }
    });
    const messages = Array.isArray(response?.messages) ? response.messages.slice().reverse() : [];
    sendBridgeEvent('remote_his_message', messages, { ccode });
  }

  async function handleQueryOrderRemark(command) {
    const params = command?.params && typeof command.params === 'object' ? command.params : {};
    const requestId = String(params.requestId || '');
    const orderId = String(params.orderId || '').trim();
    if (!orderId) {
      sendBridgeEvent('queryOrderRemarkResult', {
        requestId,
        success: false,
        result: null,
        errorMsg: 'missing-order-id'
      });
      return;
    }

    try {
      const response = await requestPddJson('/pizza/order/noteTag/query', {
        source: 3,
        orderSn: orderId
      });
      sendBridgeEvent('queryOrderRemarkResult', {
        requestId,
        success: Boolean(response?.success),
        result: {
          remark: response?.result?.note,
          tagColor: response?.result?.tag,
          tagName: response?.result?.tagName
        },
        errorMsg: response?.errorMsg || ''
      });
    } catch (error) {
      sendBridgeEvent('queryOrderRemarkResult', {
        requestId,
        success: false,
        result: null,
        errorMsg: String(error?.message || error || 'timeout')
      });
    }
  }

  async function handleSetOrderRemark(command) {
    const params = command?.params && typeof command.params === 'object' ? command.params : {};
    const requestId = String(params.requestId || '');
    const orderId = String(params.orderId || '').trim();
    if (!orderId) {
      sendBridgeEvent('setOrderRemarkResult', {
        requestId,
        success: false,
        result: null,
        errorMsg: 'missing-order-id'
      });
      return;
    }

    const defaultTagNames = {
      RED: '红色',
      YELLOW: '黄色',
      GREEN: '绿色',
      BLUE: '蓝色',
      PURPLE: '紫色'
    };

    try {
      const response = await requestPddJson('/pizza/order/noteTag/update', {
        remark: String(params.remark || ''),
        source: 3,
        orderSn: orderId,
        remarkTag: params.tagColor,
        remarkTagName: params.tagName || defaultTagNames[String(params.tagColor || '').toUpperCase()] || ''
      });
      sendBridgeEvent('setOrderRemarkResult', {
        requestId,
        ...response
      });
    } catch (error) {
      sendBridgeEvent('setOrderRemarkResult', {
        requestId,
        success: false,
        result: null,
        errorMsg: String(error?.message || error || 'timeout')
      });
    }
  }

  async function resolveBuyerByOrderSn(orderId) {
    const response = await requestPddGetJson('/chats/getUserByOrderSn', { order_sn: orderId });
    return String(response?.uid || '');
  }

  async function handleAutoOrderMessage(command) {
    const params = command?.params && typeof command.params === 'object' ? command.params : {};
    const requestId = String(params.requestId || '');
    const orderId = String(params.orderId || '').trim();
    const text = String(params.text || '').trim();
    if (!orderId || !text) {
      sendBridgeEvent('autoOrderMessageResult', {
        requestId,
        success: false,
        errorMsg: 'missing-orderId-or-text'
      });
      return;
    }

    try {
      const buyerUid = await resolveBuyerByOrderSn(orderId);
      if (!buyerUid) {
        sendBridgeEvent('autoOrderMessageResult', {
          requestId,
          success: false,
          errorMsg: 'buyer-not-found'
        });
        return;
      }

      const csid = String(window.global_uid || localStorage.currentUid || '').trim();
      const result = await new Promise((resolve) => {
        window.socketUtil.sendMsg({
          content: text,
          uid: buyerUid,
          csid: csid,
          type: 0,
          cb: resolve
        });
      });
      sendBridgeEvent('autoOrderMessageResult', {
        requestId,
        success: true,
        buyerUid,
        result
      });
    } catch (error) {
      sendBridgeEvent('autoOrderMessageResult', {
        requestId,
        success: false,
        errorMsg: String(error?.message || error)
      });
    }
  }

  // ==================== 订单查询逻辑（从 fuke-pdd-hh-4.3.js 移植） ====================

  // 订单状态分类枚举（与 fuke-pdd-hh-4.3.js 保持一致）
  const ORDER_STAGE_MAP = {
    PRE_SALE: { name: '售前', value: 1, statuses: [
      { status: '付款前关闭订单', value: 1 },
      { status: '未下单', value: 15 },
      { status: '未付款', value: 2 },
      { status: '待付尾款', value: 3 }
    ]},
    PRE_SHIPMENT: { name: '发货前', value: 2, statuses: [
      { status: '待发货', value: 4 },
      { status: '待成团', value: 22 }
    ]},
    POST_SHIPMENT: { name: '发货后', value: 3, statuses: [
      { status: '部分发货', value: 5 },
      { status: '待签收', value: 6 }
    ]},
    AFTER_SALE: { name: '售后', value: 4, statuses: [
      { status: '已评价', value: 7 },
      { status: '货到付款已签收', value: 8 },
      { status: '已签收', value: 9 },
      { status: '买家申请退款', value: 10 },
      { status: '买家申请换货', value: 16 },
      { status: '卖家同意退款', value: 11 },
      { status: '卖家同意退货，等待买家退货', value: 20 },
      { status: '卖家拒绝退款', value: 13 },
      { status: '退款关闭', value: 17 },
      { status: '退款成功', value: 12 },
      { status: '换货中，等待买家确认收货', value: 18 },
      { status: '交易关闭', value: 19 },
      { status: '买家已退货，等待卖家确认收货', value: 14 },
      { status: '买家修改退款协议', value: 21 }
    ]}
  };

  function classifyOrderStatus(statusText, fallback = { name: '售前', value: 1 }) {
    for (const stage of Object.values(ORDER_STAGE_MAP)) {
      const found = stage.statuses.find((s) => s.status === statusText);
      if (found) return { name: stage.name, value: stage.value, status: found.status, status_value: found.value };
    }
    return { name: fallback.name, value: fallback.value, status: '未分类', status_value: 0 };
  }

  function classifyAfterSaleStatus(statusCode) {
    const map = {
      1: '买家申请退款', 5: '退款成功', 9: '卖家拒绝退款',
      10: '卖家同意退货，等待买家退货', 11: '买家已退货，等待卖家确认收货',
      13: '卖家拒绝退款', 31: '卖家拒绝退款', 16: '交易成功'
    };
    const text = map[statusCode];
    return text ? classifyOrderStatus(text, { name: '售后', value: 4 }) : { name: '售后', value: 4, status: '未分类', status_value: 0 };
  }

  function classifyOrderByState(orderStatus, payStatus, shippingStatus, groupStatus, groupTime) {
    if (payStatus === 0 && orderStatus === 2) return classifyOrderStatus('付款前关闭订单');
    if (payStatus === 0) return classifyOrderStatus('未付款');
    if (payStatus === 2) {
      if (shippingStatus === 0) return classifyOrderStatus(groupStatus === 0 || !groupTime ? '待成团' : '待发货');
      if (shippingStatus === 1) return classifyOrderStatus('待签收');
      if (shippingStatus === 2) return classifyOrderStatus('已签收');
    }
    return null;
  }

  function classifySingleOrder(order) {
    const { orderStatus, payStatus, shippingStatus, afterSalesInfo, orderStatusStr, groupStatus, groupTime } = order || {};
    if (afterSalesInfo?.afterSalesStatus) {
      const result = classifyAfterSaleStatus(afterSalesInfo.afterSalesStatus);
      return { order_id: order.id || order.order_id, original_status: orderStatus, original_desc: orderStatusStr, ...result };
    }
    const result = classifyOrderByState(orderStatus, payStatus, shippingStatus, groupStatus, groupTime);
    if (result) {
      return { order_id: order.id || order.order_id, original_status: orderStatus, original_desc: orderStatusStr, ...result };
    }
    return { order_id: order.id || order.order_id, original_status: orderStatus, original_desc: orderStatusStr, category: '售前', name: '售前', value: 1, status: '未分类', status_value: 0 };
  }

  function deepGet(obj, path) {
    return path.split('.').reduce((cur, key) => cur && Array.isArray(cur) && !isNaN(key) ? cur[parseInt(key)] : cur && cur[key] !== undefined ? cur[key] : null, obj);
  }

  function getOrderTime(order) {
    if (!order || typeof order !== 'object') return null;
    const fields = [
      { field: 'afterSalesInfo.apply_time', type: 'after_sale' },
      { field: 'afterSalesInfo.refund_time', type: 'after_sale' },
      { field: 'afterSalesInfo.exchange_time', type: 'after_sale' },
      { field: 'afterSalesInfo.return_time', type: 'after_sale' },
      { field: 'receiveTime', type: 'receive' },
      { field: 'shippingTime', type: 'shipping' },
      { field: 'confirmTime', type: 'confirm' },
      { field: 'payTime', type: 'payment' },
      { field: 'orderTime', type: 'order' },
      { field: 'createdAt', type: 'created' }
    ];
    let bestValue = null;
    let bestTime = 0;
    for (const { field, type } of fields) {
      const raw = deepGet(order, field);
      if (!raw || raw === 0 || raw === '') continue;
      const ts = parseInt(raw) * 1000;
      if (ts && ts > bestTime) {
        bestTime = ts;
        bestValue = raw;
      }
    }
    return bestTime || null;
  }

  function formatTimestamp(value) {
    if (!value || value === 0 || value === '') return '';
    try {
      const ts = parseInt(value);
      if (!Number.isFinite(ts) || ts <= 0) return '';
      const date = new Date(ts * 1000);
      return date.toISOString();
    } catch {
      return '';
    }
  }

  function extractOrderTimes(order) {
    if (!order || typeof order !== 'object') return { platform_created_time: '', platform_pay_time: '', platform_shipping_time: '', platform_refund_time: '' };
    return {
      platform_created_time: formatTimestamp(order.orderTime || order.createdAt),
      platform_pay_time: formatTimestamp(order.payTime),
      platform_shipping_time: formatTimestamp(order.shippingTime),
      platform_refund_time: formatTimestamp(null)
    };
  }

  function extractLogistics(order) {
    if (!order || typeof order !== 'object') return { shipping_name: '', express_no: '' };
    const trackingNumber = order.trackingNumber || '';
    let shippingName = '';
    if (Array.isArray(order.traceInfoList) && order.traceInfoList.length > 0) {
      shippingName = order.traceInfoList[0].shippingName || '';
    }
    return { shipping_name: shippingName, express_no: trackingNumber };
  }

  function extractGoodsList(order) {
    if (!order) return [];
    return [{
      payment: Number(order.goodsPrice || 0),
      num: order.goodsNumber || 0,
      title: order.goodsName || '',
      good_id: order.goodsId ? String(order.goodsId) : '',
      sku_id: order.skuId ? String(order.skuId) : '',
      sku_name: order.spec || '',
      ext: ''
    }];
  }

  function normalizeOrders(rawOrders) {
    if (!rawOrders || !Array.isArray(rawOrders) || rawOrders.length === 0) return [];
    const result = [];
    for (const order of rawOrders) {
      const classified = classifySingleOrder(order);
      if (classified.value && classified.status_value) {
        const times = extractOrderTimes(order);
        result.push({
          order_id: String(order.orderSn),
          hh_status: classified.value,
          sub_status_num: classified.status_value,
          step_order_status: 1,
          status_name: '',
          status_num: 0,
          order_time: getOrderTime(order),
          buyer_id: String(order.uid || ''),
          buyer_nick: '',
          order_amount: Number(order.orderAmount || 0),
          goods_list: extractGoodsList(order.orderGoodsList),
          ...extractLogistics(order),
          ...times
        });
      }
    }
    return result;
  }

  // 按买家 UID 获取订单列表（对应 fuke-pdd-hh-4.3.js 的 Rt 函数）
  async function handleGetUserOrders(command) {
    const uid = String(command?.uid || command?.params?.uid || '').trim();
    if (!uid) {
      sendBridgeEvent('userOrders', { orders: [], uid: '', error: 'missing-uid' });
      return;
    }

    try {
      const response = await requestPddJson('/latitude/order/userAllOrder', {
        uid: uid,
        pageNo: 1,
        pageSize: 20
      });
      const rawOrders = response?.orders || response?.result?.orders || [];
      const orders = normalizeOrders(rawOrders);
      sendBridgeEvent('userOrders', { orders, uid });
    } catch (error) {
      sendBridgeEvent('userOrders', { orders: [], uid, error: String(error?.message || error) });
    }
  }

  // 按订单号反查买家 UID + 物流详情（对应 fuke-pdd-hh-4.3.js 的 lt 函数，增强版）
  async function handleGetOrderInfo(command) {
    const orderSn = String(command?.orderSn || command?.params?.orderSn || '').trim();
    if (!orderSn) {
      sendBridgeEvent('orderInfo', { order_sn: '', buyer_uid: '', error: 'missing-order-sn' });
      return;
    }

    try {
      const userResponse = await requestPddGetJson('/chats/getUserByOrderSn', { order_sn: orderSn });
      const buyerUid = String(userResponse?.uid || '');
      // 同时尝试获取物流信息
      let logistics = { shipping_name: '', express_no: '' };
      try {
        const orderResponse = await requestPddJson('/latitude/order/userAllOrder', {
          uid: buyerUid,
          pageNo: 1,
          pageSize: 20
        });
        const rawOrders = orderResponse?.orders || orderResponse?.result?.orders || [];
        const targetOrder = rawOrders.find((o) => String(o.orderSn) === orderSn);
        if (targetOrder) {
          logistics = extractLogistics(targetOrder);
        }
      } catch {
        // 物流查询失败不影响主流程
      }
      sendBridgeEvent('orderInfo', {
        order_sn: orderSn,
        buyer_uid: buyerUid,
        shipping_name: logistics.shipping_name,
        express_no: logistics.express_no
      });
    } catch (error) {
      sendBridgeEvent('orderInfo', {
        order_sn: orderSn,
        buyer_uid: '',
        error: String(error?.message || error)
      });
    }
  }

  // 按订单号查物流详情（独立接口）
  async function handleGetOrderLogistics(command) {
    const orderSn = String(command?.orderSn || command?.params?.orderSn || '').trim();
    if (!orderSn) {
      sendBridgeEvent('orderLogistics', { order_sn: '', shipping_name: '', express_no: '', error: 'missing-order-sn' });
      return;
    }

    try {
      // 先反查买家UID
      const userResponse = await requestPddGetJson('/chats/getUserByOrderSn', { order_sn: orderSn });
      const buyerUid = String(userResponse?.uid || '');
      if (!buyerUid) {
        sendBridgeEvent('orderLogistics', { order_sn: orderSn, shipping_name: '', express_no: '', error: 'buyer-not-found' });
        return;
      }

      // 再查订单详情获取物流
      const orderResponse = await requestPddJson('/latitude/order/userAllOrder', {
        uid: buyerUid,
        pageNo: 1,
        pageSize: 20
      });
      const rawOrders = orderResponse?.orders || orderResponse?.result?.orders || [];
      const targetOrder = rawOrders.find((o) => String(o.orderSn) === orderSn);
      const logistics = extractLogistics(targetOrder || {});
      sendBridgeEvent('orderLogistics', {
        order_sn: orderSn,
        buyer_uid: buyerUid,
        shipping_name: logistics.shipping_name,
        express_no: logistics.express_no
      });
    } catch (error) {
      sendBridgeEvent('orderLogistics', {
        order_sn: orderSn,
        shipping_name: '',
        express_no: '',
        error: String(error?.message || error)
      });
    }
  }

  async function handleServerCommand(rawCommand) {
    const command = safeParse(rawCommand) || {};
    if (!command || typeof command !== 'object') return;
    // 心跳：收到服务端 pong 时重置心跳定时器
    if (command.type === 'heartbeat' && command.act === 'pong') {
      scheduleHeartbeat();
      return;
    }
    // normalizeSendCommand 需要完整 command，但 heartbeat 不走后续逻辑
    const normalized = normalizeSendCommand(command);
    if (!normalized || typeof normalized !== 'object') return;
    if (normalized.act === 'getCurrentCsr') {
      await handleGetCurrentCsr();
      return;
    }
    if (normalized.act === 'getCurrentConv') {
      await handleGetCurrentConv();
      return;
    }
    if (normalized.act === 'getRemoteHisMsg') {
      await handleGetRemoteHisMsg(normalized);
      return;
    }
    if (normalized.act === 'queryOrderRemark') {
      await handleQueryOrderRemark(normalized);
      return;
    }
    if (normalized.act === 'setOrderRemark') {
      await handleSetOrderRemark(normalized);
      return;
    }
    if (normalized.act === 'autoOrderMessage') {
      await handleAutoOrderMessage(normalized);
      return;
    }
    if (normalized.act === 'getUserOrders') {
      await handleGetUserOrders(normalized);
      return;
    }
    if (normalized.act === 'getOrderInfo') {
      await handleGetOrderInfo(normalized);
      return;
    }
    if (normalized.act === 'getOrderLogistics') {
      await handleGetOrderLogistics(normalized);
      return;
    }
    if (normalized.act === 'transferConversation') {
      await handleTransferCommand(normalized);
      return;
    }
    if (normalized.act === 'switchConversation') {
      await handleSwitchConversation(normalized);
      return;
    }
    if (!window.socketUtil?.sendMsg || normalized.act !== 'sendMsg') {
      sendDiagnostic('command-ignored', { sample: sample(normalized) });
      return;
    }

    const uid = String(normalized.uid || normalized.id || '').trim();
    const content = String(normalized.content || normalized.text || '').trim();
    const csid = String(normalized.csid || window.global_uid || localStorage.currentUid || '').trim();
    if (!uid || !content) {
      sendDiagnostic('command-invalid', { uid, contentLength: content.length });
      return;
    }

    const callback = (result) => {
      sendDiagnostic('pdd-send-callback', {
        uid,
        contentHash: hashText(content),
        contentLength: content.length,
        ok: inferSendCallbackOk(result),
        error: inferSendCallbackOk(result) ? '' : String(result?.error || result?.errorMsg || result?.message || result || ''),
        sample: sample(result)
      });
    };
    window.socketUtil.sendMsg({
      content: content,
      uid: uid,
      csid: csid,
      type: 0,
      cb: callback
    });
  }

  function installProbe() {
    if (window.__pddFukeProbeInstalled) return;
    window.__pddFukeProbeInstalled = true;
    sendDiagnostic('bridge-js-install-probe', {
      href: location.href,
      readyState: document.readyState
    });

    sendDiagnostic('iframe-scan', {
      href: location.href,
      frames: Array.from(window.frames || []).map((frame, index) => {
        try {
          return {
            index,
            href: String(frame.location?.href || ''),
            title: String(frame.document?.title || '')
          };
        } catch {
          return { index, href: '', title: '' };
        }
      })
    });
    sendDiagnostic('page-ready', {
      href: location.href,
      userAgent: navigator.userAgent,
      keys: Object.keys(window).filter((key) => /socket|message|im|chat|bridge/i.test(key)).slice(0, 40)
    });

    if (window.fetch) {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const request = args[0];
        const init = args[1] || {};
        const method = String(init.method || request?.method || 'GET').toUpperCase();
        const fetchUrl = String(request?.url || request || '');
        sendDiagnostic('fetch-request', { method, url: fetchUrl });
        if (isTransferRelevantUrl(fetchUrl) || isTransferRelevantPayload(init?.body)) {
          sendDiagnostic('transfer-fetch-request', {
            method,
            url: fetchUrl,
            body: sample(init?.body)
          });
        }
        const response = await nativeFetch(...args);
        try {
          const clone = response.clone();
          const text = await clone.text();
          sendDiagnostic('fetch-response', {
            url: fetchUrl,
            status: response.status,
            sample: sample(text)
          });
          if (isTransferRelevantUrl(fetchUrl) || isTransferRelevantPayload(text)) {
            sendDiagnostic('transfer-fetch-response', {
              url: fetchUrl,
              status: response.status,
              sample: sample(text)
            });
          }
        } catch {}
        return response;
      };
    }

    if (window.XMLHttpRequest) {
      const NativeXhr = window.XMLHttpRequest;
      window.XMLHttpRequest = function PddFukeXMLHttpRequest() {
        const xhr = new NativeXhr();
        let requestMethod = 'GET';
        let requestUrl = '';
        const nativeOpen = xhr.open.bind(xhr);
        xhr.open = function open(method, urlValue) {
          requestMethod = String(method || 'GET').toUpperCase();
          requestUrl = String(urlValue || '');
          sendDiagnostic('xhr-open', { method: requestMethod, url: requestUrl });
          return nativeOpen.apply(this, arguments);
        };
        const nativeSend = xhr.send.bind(xhr);
        xhr.send = function send(body) {
          if (isTransferRelevantUrl(requestUrl) || isTransferRelevantPayload(body)) {
            sendDiagnostic('transfer-xhr-send', {
              method: requestMethod,
              url: requestUrl,
              body: sample(body)
            });
          }
          return nativeSend.apply(this, arguments);
        };
        xhr.addEventListener('load', () => {
          sendDiagnostic('xhr-load', {
            url: requestUrl,
            status: xhr.status,
            sample: sample(xhr.responseText)
          });
          if (isTransferRelevantUrl(requestUrl) || isTransferRelevantPayload(xhr.responseText)) {
            sendDiagnostic('transfer-xhr-load', {
              method: requestMethod,
              url: requestUrl,
              status: xhr.status,
              sample: sample(xhr.responseText)
            });
          }
        });
        return xhr;
      };
      window.XMLHttpRequest.prototype = NativeXhr.prototype;
      Object.setPrototypeOf(window.XMLHttpRequest, NativeXhr);
    }

    document.addEventListener('click', (event) => {
      sendDiagnostic('document-click-capture', {
        conversationId: String(getCurrentConversation()?.UIDSwitchInfo || ''),
        target: getElementSummary(event.target?.closest?.('button,a,[role="button"],li,div,span') || event.target)
      });
      const target = event.target?.closest?.('button,a,[role="button"],li,div,span');
      if (!target || !isTransferRelevantElement(target)) return;
      sendDiagnostic('transfer-click', {
        conversationId: String(getCurrentConversation()?.UIDSwitchInfo || ''),
        target: getElementSummary(target)
      });
      setTimeout(() => emitTransferUiSnapshot('after-click-80ms'), 80);
      setTimeout(() => emitTransferUiSnapshot('after-click-300ms'), 300);
    }, true);

    window.addEventListener('message', (event) => {
      if (event.data?.__pddFukeBridgeSend === true) return;
      sendDiagnostic('window-message', {
        origin: event.origin,
        sample: sample(event.data)
      });
      if (isTransferRelevantPayload(event.data)) {
        sendDiagnostic('transfer-window-message', {
          origin: event.origin,
          sample: sample(event.data)
        });
      }
    }, true);

    const nativePostMessage = window.postMessage?.bind(window);
    if (nativePostMessage) {
      window.postMessage = (message, targetOrigin, transfer) => {
        if (message?.__pddFukeBridgeSend !== true) {
          sendDiagnostic('window-post-message', {
            targetOrigin: String(targetOrigin || ''),
            sample: sample(message)
          });
          if (isTransferRelevantPayload(message)) {
            sendDiagnostic('transfer-window-post-message', {
              targetOrigin: String(targetOrigin || ''),
              sample: sample(message)
            });
          }
        }
        return transfer === undefined
          ? nativePostMessage(message, targetOrigin)
          : nativePostMessage(message, targetOrigin, transfer);
      };
    }

    const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function dispatchEventProbe(event) {
      const type = String(event?.type || '');
      if (type && !type.startsWith('pdd-fuke')) {
        const detail = event && 'detail' in event ? event.detail : '';
        if (/pdd|chat|socket|message|im|mall|customer|session|conversation/i.test(type) || detail) {
          sendDiagnostic('dom-dispatch-event', {
            type,
            sample: sample(detail)
          });
        }
      }
      return nativeDispatchEvent.call(this, event);
    };

    if (window.MutationObserver && document.body) {
      const observer = new MutationObserver((mutationList) => {
        for (const mutation of mutationList) {
          if (mutation.type === 'childList' || mutation.type === 'characterData') {
            emitTransferUiSnapshot('mutation');
            break;
          }
        }
      });
      observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true
      });
      emitTransferUiSnapshot('probe-installed');
    }

    function patchStorage(storage, storageName) {
      if (!storage?.setItem) return;
      const nativeSetItem = storage.setItem.bind(storage);
      storage.setItem = (key, value) => {
        sendDiagnostic('storage-set-item', {
          storage: storageName,
          key: String(key || ''),
          sample: sample(value)
        });
        return nativeSetItem(key, value);
      };
    }
    patchStorage(window.localStorage, 'localStorage');
    patchStorage(window.sessionStorage, 'sessionStorage');

    if (window.indexedDB?.open) {
      const nativeIndexedDbOpen = window.indexedDB.open.bind(window.indexedDB);
      window.indexedDB.open = (name, version) => {
        sendDiagnostic('indexeddb-open', {
          name: String(name || ''),
          version: version ?? ''
        });
        return version === undefined ? nativeIndexedDbOpen(name) : nativeIndexedDbOpen(name, version);
      };
    }

    const NativeEventSource = window.EventSource;
    if (NativeEventSource) {
      window.EventSource = function pddFukeEventSource(eventSourceUrl, config) {
        const source = config === undefined ? new NativeEventSource(eventSourceUrl) : new NativeEventSource(eventSourceUrl, config);
        const sourceUrl = String(eventSourceUrl || '');
        sendDiagnostic('eventsource-created', { url: sourceUrl });
        source.addEventListener('message', (event) => {
          sendDiagnostic('eventsource-message', {
            url: sourceUrl,
            sample: sample(event.data)
          });
        });
        return source;
      };
      window.EventSource.prototype = NativeEventSource.prototype;
      Object.setPrototypeOf(window.EventSource, NativeEventSource);
    }
  }

  sendDiagnostic('bridge-script-start', {
    href: location.href,
    hasExistingSocket: Boolean(window.__pddFukeBridgeSocket),
    port
  });
  sendDiagnostic('bridge-script-entered', {
    href: location.href,
    readyState: document.readyState
  });
  sendDiagnostic('bridge-script-port-resolved', {
    port,
    rawDataType: typeof rawData
  });
  bridgeHttpBeacon('bridge-js-loaded', {
    href: location.href,
    readyState: document.readyState,
    top: window.top === window ? '1' : '0'
  });
  bridgeHttpBeacon('bridge-js-port-resolved', {
    href: location.href,
    port,
    rawDataType: typeof rawData
  });
  const url = buildHandshakeUrl();
  try {
    socket = new BridgeWebSocket(url);
  } catch (error) {
    bridgeHttpBeacon('bridge-js-websocket-construct-failed', {
      href: location.href,
      wsUrl: url,
      message: String(error?.message || error)
    });
    sendDiagnostic('bridge-ws-construct-failed', {
      url,
      message: String(error?.message || error)
    });
    throw error;
  }
  window.__pddFukeBridgeSocket = socket;
  sendDiagnostic('bridge-ws-construct', { url });
  bridgeHttpBeacon('bridge-js-after-websocket-construct', {
    href: location.href,
    wsUrl: url
  });

  // --- WebSocket 心跳 ---
  const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60 秒无消息则发 ping
  let heartbeatTimer = null;

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      const activeSocket = getActiveSocket();
      if (activeSocket?.readyState === BridgeWebSocket.OPEN) {
        activeSocket.send(JSON.stringify({ type: 'heartbeat', act: 'ping' }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
  // --- 心跳 end ---

  socket.addEventListener('open', () => {
    console.log('[pdd-bridge] websocket connected', url);
    emitDiagnostic('bridge-ws-open', { url });
    flushPendingDiagnostics();
    installProbe();
    installShopObserver();
    installPddNativeHooks();
    scheduleCurrentCsr('ws-open', 0);
    scheduleHeartbeat();
  });
  socket.addEventListener('close', (event) => {
    console.log('[pdd-bridge] websocket closed');
    clearHeartbeat();
    sendDiagnostic('bridge-ws-close', {
      url,
      code: event?.code,
      reason: String(event?.reason || '')
    });
  });
  socket.addEventListener('error', (event) => {
    console.log('[pdd-bridge] websocket error', event);
    sendDiagnostic('bridge-ws-error', {
      url,
      message: String(event?.message || event?.type || 'error')
    });
  });
  socket.addEventListener('message', (event) => {
    console.log('[pdd-bridge] websocket message', event.data);
    sendDiagnostic('page-websocket-message', {
      url,
      sample: sample(event.data)
    });
    Promise.resolve(handleServerCommand(event.data)).catch((error) => {
      sendDiagnostic('command-error', { error: String(error?.message || error) });
    });
    window.dispatchEvent(new CustomEvent('pdd-lg:message', { detail: event.data }));
  });

  window.addEventListener('error', (event) => {
    sendDiagnostic('window-error', {
      message: String(event?.message || ''),
      filename: String(event?.filename || ''),
      lineno: event?.lineno || 0,
      colno: event?.colno || 0
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    sendDiagnostic('unhandled-rejection', {
      reason: sample(event?.reason)
    });
  });

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__pddFukeBridgeSend !== true || socket.readyState !== WebSocket.OPEN) return;
    socket.send(typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload));
  });
})();`;
}

function readQnBridgeScript(bridgeModeOption) {
  const bridgeMode = String(bridgeModeOption || process.env.PDD_FUKE_QN_BRIDGE || process.env.PDD_LG_QN_BRIDGE || 'fuke').trim().toLowerCase();
  const scriptPath = bridgeMode === 'lite'
    ? path.join(__dirname, '..', 'bridges', 'qn-bridge-lite.js')
    : path.join(__dirname, '..', 'bridges', 'fuke-qn-hh-4.3.js');
  try {
    return fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return '';
  }
}

async function startPddBridgeServer({ wsPort, host = '127.0.0.1', port = 0, qnBridgeMode = '', logger: serverLogger = noopLogger } = {}) {
  const qnScript = readQnBridgeScript(qnBridgeMode);

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, `http://${host}`).pathname;
    serverLogger.log('[pdd-bridge:http-request]', { method: request.method, pathname });
    if (request.method === 'GET' && pathname === '/pdd-bridge-beacon') {
      const params = new URL(request.url, `http://${host}`).searchParams;
      const payload = Object.fromEntries(params.entries());
      serverLogger.log('[pdd-bridge:beacon]', payload);
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'GET' || !['/pdd-bridge.js', '/qn-hh-4.3.js'].includes(pathname)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    if (pathname === '/qn-hh-4.3.js' && !qnScript) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('QN bridge script not found');
      return;
    }

    response.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(pathname === '/qn-hh-4.3.js' ? qnScript : createPddBridgeScript(wsPort));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const url = `http://${host}:${address.port}/pdd-bridge.js`;
  const qnUrl = `http://${host}:${address.port}/qn-hh-4.3.js`;
  serverLogger.log('[pdd-bridge:http-start]', { host, port: address.port, url, qnUrl, qnScriptReady: Boolean(qnScript) });

  return {
    server,
    url,
    qnUrl,
    address,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else {
          serverLogger.log('[pdd-bridge:http-stop]');
          resolve();
        }
      });
    })
  };
}

module.exports = {
  isPddBridgeClient,
  pickBestPddShopName,
  looksLikePddShopName,
  createPddBridgeScript,
  startPddBridgeServer
};
