'use strict';

const DEFAULT_BASE_URL = 'https://xingqiao.taluo.club';
const DEFAULT_API_KEY = 'sk-HXYPG9O5PuDuzZJsz1lA3Rgud41C5w-KnsOTQXyiDf4';

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizePlatform(value) {
  const platform = String(value || '').toLowerCase();
  if (!platform || platform === 'publicplatform' || platform === 'pdd') return 'pdd';
  if (platform === 'qn' || platform === 'qianniu') return 'qianniu';
  return platform;
}

function defaultMessageType(kind) {
  if (kind === 'goods') return 'product_card';
  if (kind === 'order') return 'order_card';
  if (kind === 'image') return 'image';
  return 'text';
}

function defaultOrderFacts() {
  return {
    hasOrder: false,
    orderStage: 'no_recent_order',
    // 注意：非ISV/服务商无权限调用拼多多订单API，无法从后台拉取买家历史订单列表。
    // 仅当买家主动发送订单卡片消息时，才能从卡片中解析出订单号/状态/金额。
    orderSummary: '无相关订单',
    customerStage: 'pre_sale',
    customerStageSource: 'no_order'
  };
}

/**
 * 订单缓存：按 buyer_key 索引，存储 right_panel 探针抓取到的最近订单信息。
 * 用于在 buildTmagentChatPayload 时，即使买家发的是文本消息，
 * 也能把已抓取到的订单数据填充到 has_order / order_stage / order_summary 中。
 *
 * 由于 right_panel 探针抓取时可能不知道 buyer_id，
 * 还维护一个按 shop_id 索引的"最近无主订单"池，当买家发消息时自动关联。
 */
function createOrderCache(options = {}) {
  const maxAgeMs = options.maxAgeMs || 10 * 60 * 1000; // 10分钟过期
  const maxSize = options.maxSize || 50;                // 最多缓存50个买家
  const store = new Map(); // key: buyer_key -> { orders, updatedAt }
  // 无主订单池：key: shop_key -> [{ orders, capturedAt }]
  const orphanPool = new Map();

  function makeBuyerKey(platform, shopId, buyerId) {
    return `${platform}:${shopId}:${buyerId}`;
  }

  function makeShopKey(platform, shopId) {
    return `${platform}:${shopId}`;
  }

  function normalizeOrderStatus(status) {
    const text = String(status || '').trim().toLowerCase();
    if (!text) return 'unknown_order_state';
    if (/(退款|售后|after[-_ ]?sale|refund|return)/i.test(text)) return 'after_sale';
    if (/(已签收|完成|success|finished|done|completed)/i.test(text)) return 'completed';
    if (/(已发货|待收货|运输|物流|shipping|shipped|delivery)/i.test(text)) return 'shipped';
    if (/(待发货|待配送|配货|processing|packed)/i.test(text)) return 'paid_pending_shipment';
    if (/(待付款|未付款|unpaid|pending payment)/i.test(text)) return 'pending_payment';
    return 'unknown_order_state';
  }

  function buildOrderSummaryFromCache(order) {
    const segments = [
      order.goods_name || '',
      order.order_status || '',
      order.amount ? `金额 ${order.amount}` : null,
      order.order_sn ? `订单 ${order.order_sn}` : null
    ].filter(Boolean);
    return segments.length ? segments.join(' | ') : '';
  }

  /**
   * 缓存带 buyer_id 的订单（来自 order_info_update 或手动关联）
   */
  function cacheOrders(platform, shopId, orders, buyerId) {
    if (!Array.isArray(orders) || !orders.length) return;

    const now = Date.now();
    // 清理过期条目
    for (const [key, entry] of store) {
      if (now - entry.updatedAt > maxAgeMs) {
        store.delete(key);
      }
    }

    const bid = buyerId || '';
    if (!bid) {
      // 没有 buyerId，放入无主订单池
      cacheOrphanOrders(platform, shopId, orders);
      return;
    }

    const key = makeBuyerKey(platform, shopId, bid);
    const existing = store.get(key) || { orders: [], updatedAt: 0 };
    const existingSns = new Set(existing.orders.map((o) => o.order_sn));
    const newOrders = orders.filter((o) => o.order_sn && !existingSns.has(o.order_sn));
    existing.orders = [...existing.orders, ...newOrders];
    existing.updatedAt = now;
    store.set(key, existing);

    pruneStore();
  }

  /**
   * 缓存无主订单（right_panel 抓取时还不知道 buyer_id）
   */
  function cacheOrphanOrders(platform, shopId, orders) {
    if (!Array.isArray(orders) || !orders.length) return;
    const now = Date.now();
    const shopKey = makeShopKey(platform, shopId);
    let pool = orphanPool.get(shopKey);
    if (!pool) {
      pool = [];
      orphanPool.set(shopKey, pool);
    }
    pool.push({ orders, capturedAt: now });

    // 清理过期无主订单
    const pruned = pool.filter((entry) => now - entry.capturedAt <= maxAgeMs);
    if (pruned.length !== pool.length) {
      if (pruned.length === 0) orphanPool.delete(shopKey);
      else orphanPool.set(shopKey, pruned);
    }
    // 限制无主池大小
    if (pruned.length > 20) {
      orphanPool.set(shopKey, pruned.slice(-20));
    }
  }

  /**
   * 从隐藏的买家昵称中提取可匹配的部分。
   * 拼多多显示如 "t********8"、"张***三" 等格式，
   * 提取 * 前后的可见字符用于模糊匹配。
   */
  function extractNameHint(buyerName) {
    const text = String(buyerName || '').trim();
    if (!text) return { prefix: '', suffix: '' };
    // 找到第一个 * 和最后一个 * 的位置
    const firstStar = text.indexOf('*');
    if (firstStar === -1) {
      // 没有星号，整个名称直接匹配
      return { prefix: text, suffix: '' };
    }
    const lastStar = text.lastIndexOf('*');
    const prefix = text.slice(0, firstStar);
    const suffix = text.slice(lastStar + 1);
    return { prefix, suffix };
  }

  /**
   * 尝试将无主订单的 buyer_name 与消息的 senderName 做模糊匹配。
   * 匹配规则：
   *  - 提取无主订单 buyer_name 中 * 前后的可见字符
   *  - 如果 senderName 包含该前缀且以该后缀结尾，认为匹配
   *  - 例如：无主订单 "t********8" 匹配消息 "t********8" 或 "test*******8"
   */
  function matchBuyerName(orphanName, senderName) {
    const orphanHint = extractNameHint(orphanName);
    const senderHint = extractNameHint(senderName);
    // 双方都没有隐藏部分 → 直接比较
    if (!orphanHint.suffix && !senderHint.suffix && orphanHint.prefix && senderHint.prefix) {
      return orphanHint.prefix === senderHint.prefix;
    }
    // 前缀匹配 + 后缀匹配
    const prefixMatch = !orphanHint.prefix || !senderHint.prefix
      ? true
      : senderHint.prefix.startsWith(orphanHint.prefix) || orphanHint.prefix.startsWith(senderHint.prefix);
    const suffixMatch = !orphanHint.suffix || !senderHint.suffix
      ? true
      : senderHint.suffix.endsWith(orphanHint.suffix) || orphanHint.suffix.endsWith(senderHint.suffix);
    return prefixMatch && suffixMatch;
  }

  /**
   * 当买家发消息时，尝试将无主订单关联到该买家。
   * 关联策略：
   *  1. 同店铺下，按 buyer_name 前缀+后缀模糊匹配
   *  2. 如果 buyer_name 匹配不上，降级为按店铺最近订单认领（兜底）
   */
  function claimOrphanOrders(platform, shopId, buyerId, buyerName) {
    if (!buyerId) return;
    const shopKey = makeShopKey(platform, shopId);
    const pool = orphanPool.get(shopKey);
    if (!pool || !pool.length) return;

    const now = Date.now();
    const recent = pool.filter((entry) => now - entry.capturedAt <= maxAgeMs);
    if (!recent.length) {
      orphanPool.delete(shopKey);
      return;
    }

    // 策略1：按 buyer_name 前缀/后缀匹配
    if (buyerName) {
      const matched = [];
      const unmatched = [];
      for (const entry of recent) {
        const orphanBuyerName = (entry.orders && entry.orders.length)
          ? String(entry.orders[0].buyer_name || '')
          : '';
        if (orphanBuyerName && matchBuyerName(orphanBuyerName, buyerName)) {
          matched.push(entry);
        } else {
          unmatched.push(entry);
        }
      }
      if (matched.length) {
        for (const entry of matched) {
          cacheOrders(platform, shopId, entry.orders, buyerId);
        }
        // 保留未匹配的订单在无主池中
        if (unmatched.length) {
          orphanPool.set(shopKey, unmatched);
        } else {
          orphanPool.delete(shopKey);
        }
        return;
      }
      // 没有名称匹配的 → 继续执行策略2
    }

    // 策略2（兜底）：取最近的无主订单，关联到当前买家
    for (const entry of recent) {
      cacheOrders(platform, shopId, entry.orders, buyerId);
    }
    orphanPool.delete(shopKey);
  }

  function pruneStore() {
    if (store.size > maxSize) {
      const oldest = [...store.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        .slice(0, store.size - maxSize);
      for (const [key] of oldest) store.delete(key);
    }
  }

  /**
   * 查询某个买家的缓存订单，返回 orderFacts 增量
   * @returns {object|null} 可合并到 orderFacts 的字段，或 null 表示无缓存
   */
  function queryOrderFacts(platform, shopId, buyerId, buyerName) {
    // 先尝试认领无主订单（按 buyer_name 前缀/后缀匹配优先）
    claimOrphanOrders(platform, shopId, buyerId, buyerName);

    const key = makeBuyerKey(platform, shopId, buyerId);
    const entry = store.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now - entry.updatedAt > maxAgeMs) {
      store.delete(key);
      return null;
    }
    if (!entry.orders.length) return null;

    const orders = entry.orders;
    // 按优先级找售后/进行中订单的状态
    let resolvedStage = 'unknown_order_state';
    for (const o of orders) {
      const s = normalizeOrderStatus(o.order_status || '');
      if (s === 'after_sale') { resolvedStage = 'after_sale'; break; }
      if (s === 'shipped' && resolvedStage !== 'after_sale') resolvedStage = 'shipped';
      if (s === 'completed' && resolvedStage !== 'after_sale' && resolvedStage !== 'shipped') resolvedStage = 'completed';
      if (s === 'paid_pending_shipment' && resolvedStage === 'unknown_order_state') resolvedStage = 'paid_pending_shipment';
      if (s === 'pending_payment' && resolvedStage === 'unknown_order_state') resolvedStage = 'pending_payment';
    }

    const customerStage = resolvedStage === 'after_sale'
      ? 'after_sale'
      : resolvedStage === 'completed'
        ? 'post_sale'
        : 'in_sale';

    const summaries = orders.map(buildOrderSummaryFromCache).filter(Boolean);
    const orderSummary = summaries.length
      ? summaries.join('；')
      : `从侧边栏抓取到 ${orders.length} 条订单`;

    return {
      hasOrder: true,
      orderStage: resolvedStage,
      orderSummary,
      customerStage,
      customerStageSource: 'right_panel_cache'
    };
  }

  return { cacheOrders, queryOrderFacts, makeBuyerKey };
}

function truncate(str, maxLen) {
  const text = String(str || '');
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function cardSummary(card) {
  if (!card || typeof card !== 'object') return '';
  if (card.type === 'product') {
    return `[商品卡片] ${card.title || ''} (goods_id: ${card.goods_id || ''})${card.price ? ' 价格: ' + card.price : ''}`;
  }
  if (card.type === 'order') {
    return `[订单卡片] ${card.title || ''} 状态: ${card.status || ''}${card.amount ? ' 金额: ' + card.amount : ''} (订单号: ${card.order_id || card.order_sn || ''})`;
  }
  return '';
}

/**
 * 构建订单/物流信息上报 payload
 * 用于 right_panel 侧边栏抓取到的订单详情/物流变更事件
 */
function buildOrderInfoPayload(options = {}) {
  const platform = normalizePlatform(options.platform || 'pdd');
  const shopId = String(options.shopId || process.env.PDD_FUKE_TMAGENT_SHOP_ID || 'default');
  const shopName = String(options.shopName || process.env.PDD_FUKE_TMAGENT_SHOP_NAME || '');
  const orders = Array.isArray(options.orders) ? options.orders : [];

  return {
    platform,
    shop_id: shopId,
    shop_name: shopName,
    event: 'order_info_update',
    orders: orders.map((info) => ({
      order_sn: String(info.order_sn || ''),
      order_status: String(info.order_status || ''),
      goods_name: String(info.goods_name || ''),
      amount: String(info.amount || ''),
      buyer_name: String(info.buyer_name || ''),
      create_time: String(info.create_time || ''),
      after_sale_status: String(info.after_sale_status || ''),
      logistics_company: String(info.logistics_company || ''),
      logistics_no: String(info.logistics_no || ''),
      logistics_status: String(info.logistics_status || '')
    })),
    debug: false
  };
}

function buildTmagentChatPayload(payload, options = {}) {
  const message = payload?.message || {};
  const platform = normalizePlatform(options.platform || payload?.client?.platform || payload?.platform);
  const buyerId = String(message.senderId || message.conversationId || '');
  const shopId = String(options.shopId || process.env.PDD_FUKE_TMAGENT_SHOP_ID || 'default');
  const shopName = String(options.shopName || process.env.PDD_FUKE_TMAGENT_SHOP_NAME || '');
  const buyerName = String(message.senderName || '');
  const text = String(message.content?.text || cardSummary(message.card) || '');
  const messageType = String(message.messageType || defaultMessageType(message.kind));

  // 优先使用消息本身解析出的 orderFacts（如订单卡片）
  let orderFacts = { ...defaultOrderFacts(), ...(message.orderFacts || {}) };

  // 如果消息本身没有有效订单信息，尝试从 right_panel 订单缓存中查询
  if (!orderFacts.hasOrder && options.orderCache && typeof options.orderCache.queryOrderFacts === 'function') {
    const cachedFacts = options.orderCache.queryOrderFacts(platform, shopId, buyerId, buyerName);
    if (cachedFacts) {
      orderFacts = { ...orderFacts, ...cachedFacts };
    }
  }

  return {
    conversation_id: `${platform}:${shopId}:${buyerId}`,
    platform,
    shop_id: shopId,
    shop_name: shopName,
    buyer_id: buyerId,
    buyer_name: buyerName,
    message_type: messageType,
    message: truncate(text, 2000),
    card: message.card || {},
    has_order: Boolean(orderFacts.hasOrder),
    order_stage: String(orderFacts.orderStage || 'no_recent_order'),
    order_summary: String(orderFacts.orderSummary || '无相关订单'),
    customer_stage: String(orderFacts.customerStage || 'pre_sale'),
    customer_stage_source: String(orderFacts.customerStageSource || 'no_order'),
    image_source: message.kind === 'image' ? String(message.content?.url || '') : null,
    shop_rules: {},
    context: {},
    debug: false
  };
}

function nativeHttpsRequest(urlStr, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const http = require('node:http');
    const url = new URL(urlStr);
    const payload = body || null;
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['Content-Length'] = String(Buffer.byteLength(payload));
    }

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: reqHeaders,
      rejectUnauthorized: false,
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* ignore */ }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(parsed?.detail || `HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsed ?? { ok: true });
      });
    });

    req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function requestTmagentChat(options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl || process.env.PDD_LG_TMAGENT_BASE_URL || DEFAULT_BASE_URL);
  const apiKey = options.apiKey || process.env.PDD_LG_TMAGENT_API_KEY || DEFAULT_API_KEY;

  if (!apiKey) throw new Error('Missing PDD_LG_TMAGENT_API_KEY');

  // 如果传了自定义 fetchImpl，优先使用；否则用原生 https（支持自签名证书）
  const fetchImpl = options.fetchImpl;
  if (typeof fetchImpl === 'function') {
    const response = await fetchImpl(`${baseUrl}/api/orchestrate/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(options.payload || {})
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.detail || `tmagent request failed: ${response.status}`);
    }
    return body;
  }

  // 默认使用原生 https 请求，自动处理 HTTP→HTTPS 升级
  const finalUrl = baseUrl.startsWith('http://')
    ? baseUrl.replace(/^http:\/\//, 'https://') + '/api/orchestrate/chat'
    : `${baseUrl}/api/orchestrate/chat`;

  return nativeHttpsRequest(finalUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify(options.payload || {})
  });
}

function mergeBufferedPayloads(payloads) {
  if (!payloads || !payloads.length) return null;
  if (payloads.length === 1) return payloads[0];

  const first = payloads[0];
  const last = payloads[payloads.length - 1];

  const texts = payloads
    .map((p) => String(p?.message || ''))
    .filter((t) => t.length > 0);
  const mergedText = texts.join('\n---\n');

  return {
    ...first,
    message: truncate(mergedText, 2000),
    message_type: last.message_type === 'image' ? 'image' : first.message_type,
    image_source: last.image_source || first.image_source || null,
    card: last.card || first.card || null,
    has_order: last.has_order || first.has_order || null,
    order_stage: last.order_stage || first.order_stage,
    order_summary: last.order_summary || first.order_summary,
    customer_stage: last.customer_stage || first.customer_stage,
    customer_stage_source: last.customer_stage_source || first.customer_stage_source
  };
}

function createMessageBuffer(options = {}) {
  const bufferMs = Number(options.bufferMs) || 2000;
  const onFlush = typeof options.onFlush === 'function' ? options.onFlush : null;
  const logger = options.logger || console;
  /** @type {Map<string, {payloads: any[], rawMessages: any[], timer: ReturnType<typeof setTimeout>|null}>} */
  const slots = new Map();

  function cancel(targetId) {
    const slot = slots.get(targetId);
    if (!slot) return;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    slots.delete(targetId);
    logger.log('[buffer:cancel]', { targetId });
  }

  async function flush(targetId) {
    const slot = slots.get(targetId);
    if (!slot) return;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    slots.delete(targetId);

    const merged = mergeBufferedPayloads(slot.payloads);
    if (!merged) return;

    logger.log('[buffer:flush]', {
      targetId,
      count: slot.payloads.length,
      mergedLength: String(merged.message || '').length
    });

    if (onFlush) return onFlush(targetId, merged, slot.rawMessages || []);
    return undefined;
  }

  function add(targetId, payload, rawMessage) {
    if (!targetId) return { merged: false };

    let slot = slots.get(targetId);
    if (slot) {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      slot.payloads.push(payload);
      if (rawMessage) slot.rawMessages.push(rawMessage);
      slot.timer = setTimeout(() => flush(targetId), bufferMs);
      logger.log('[buffer:append]', { targetId, count: slot.payloads.length });
      return { merged: false, count: slot.payloads.length };
    }

    slot = {
      payloads: [payload],
      rawMessages: rawMessage ? [rawMessage] : [],
      timer: setTimeout(() => flush(targetId), bufferMs)
    };
    slots.set(targetId, slot);
    logger.log('[buffer:start]', { targetId });
    return { merged: false, count: 1 };
  }

  function pending() {
    return slots.size;
  }

  return { add, cancel, flush, pending };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_API_KEY,
  truncate,
  buildTmagentChatPayload,
  buildOrderInfoPayload,
  mergeBufferedPayloads,
  createMessageBuffer,
  createOrderCache,
  normalizePlatform,
  requestTmagentChat
};
