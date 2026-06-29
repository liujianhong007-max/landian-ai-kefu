'use strict';

const MESSAGE_TYPES = {
  0: 'text',
  1: 'image',
  2: 'voice',
  3: 'video',
  4: 'goods',
  5: 'order',
  16: 'emotion',
  17: 'recall',
  28: 'link',
  999: 'system'
};

const DIRECTIONS = {
  1: 'user',
  2: 'assistant',
  3: 'system',
  4: 'system'
};

const PROTOCOL_TYPES = new Set([
  'ack',
  'error',
  'login',
  'session',
  'currentcsr',
  'currentconv',
  'remote_his_message',
  'queryorderremarkresult',
  'setorderremarkresult',
  'autoordermessageresult',
  'userorders',
  'orderinfo',
  'orderlogistics',
  'orderextracted'
]);

function safeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  if (!text.startsWith('{') && !text.startsWith('[')) return value;

  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Date.now();
  return timestamp < 1000000000000 ? timestamp * 1000 : timestamp;
}

function normalizeEnvelope(raw) {
  const envelope = safeJson(raw);
  if (!envelope || typeof envelope !== 'object') return null;

  const envelopeType = String(envelope.type || envelope.act || '').toLowerCase();
  if (envelopeType === 'heartbeat' || envelopeType === 'ping' || envelope.act === 'pong') {
    return null;
  }

  const param = safeJson(firstDefined(envelope.param, envelope.data, envelope.message, envelope));
  if (!param || typeof param !== 'object') return null;

  return { envelope, param };
}

function normalizeContent(param) {
  const content = safeJson(firstDefined(param.content, param.msgContent, param.body, param.data, {}));
  return content && typeof content === 'object' ? content : { text: String(content || '') };
}

function roleToDirectionCode(value) {
  const role = typeof value === 'object' ? value?.role : value;
  if (role === 'user' || role === 'platform') return 1;
  if (role === 'mall_cs' || role === 'cs') return 2;
  return value;
}

function resolvePddSenderId(param, direction) {
  if (direction === 'user') {
    return firstDefined(
      param.senderId,
      param.fromId,
      param.from?.uid,
      param.uid,
      param.buyerId
    );
  }

  if (direction === 'assistant') {
    return firstDefined(
      param.senderId,
      param.fromId,
      param.from?.uid,
      param.to?.uid
    );
  }

  return firstDefined(
    param.senderId,
    param.fromId,
    param.from?.uid,
    param.to?.uid,
    param.uid,
    param.buyerId
  );
}

function normalizeFukePddItem(item, envelope = {}) {
  const param = envelope.param && typeof envelope.param === 'object' ? envelope.param : {};
  return {
    ...item,
    msgId: firstDefined(item.msgId, item.msg_id, item.message_id),
    targetId: firstDefined(param.ccode, item.targetId, item.uid, item.from?.role === 'user' ? item.from?.uid : item.to?.uid),
    direction: roleToDirectionCode(firstDefined(item.direction, item.from)),
    timestamp: firstDefined(item.timestamp, item.ts, item.time),
    nickname: firstDefined(item.nickname, item.user_nickname)
  };
}

function parseCardContent(content, aliases) {
  const result = {};
  for (const [target, keys] of Object.entries(aliases)) {
    result[target] = firstDefined(...keys.map((key) => content[key]));
  }
  return result;
}

function buildDefaultOrderFacts() {
  return {
    hasOrder: false,
    orderStage: 'no_recent_order',
    // 非ISV无权限调拼多多订单API，仅能解析买家发送的订单卡片
    orderSummary: '无相关订单',
    customerStage: 'pre_sale',
    customerStageSource: 'no_order'
  };
}

function normalizeOrderStage(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'unknown_order_state';
  if (/(退款|售后|after[-_ ]?sale|refund|return)/i.test(text)) return 'after_sale';
  if (/(已签收|完成|success|finished|done|completed)/i.test(text)) return 'completed';
  if (/(已发货|待收货|运输|物流|shipping|shipped|delivery)/i.test(text)) return 'shipped';
  if (/(待发货|待配送|配货|processing|packed)/i.test(text)) return 'paid_pending_shipment';
  if (/(待付款|未付款|unpaid|pending payment)/i.test(text)) return 'pending_payment';
  return 'unknown_order_state';
}

function buildOrderSummary(content) {
  const segments = [
    firstDefined(content.title, content.goodsName, content.name),
    firstDefined(content.status),
    firstDefined(content.amount) !== undefined && firstDefined(content.amount) !== null && firstDefined(content.amount) !== ''
      ? `金额 ${firstDefined(content.amount)}`
      : null,
    firstDefined(content.orderId, content.orderSn) ? `订单 ${firstDefined(content.orderId, content.orderSn)}` : null
  ].filter(Boolean);
  return segments.length ? segments.join(' | ') : '检测到订单卡片';
}

function buildStructuredMessageMeta(kind, content) {
  if (kind === 'goods') {
    return {
      messageType: 'product_card',
      card: {
        type: 'product',
        goods_id: String(firstDefined(content.goodsId, '') || ''),
        title: String(firstDefined(content.goodsName, '') || ''),
        price: firstDefined(content.price, null),
        url: firstDefined(content.url, null),
        image: firstDefined(content.pic, null)
      },
      orderFacts: buildDefaultOrderFacts()
    };
  }

  if (kind === 'order') {
    const orderStage = normalizeOrderStage(content.status);
    const customerStage = orderStage === 'after_sale'
      ? 'after_sale'
      : orderStage === 'completed'
        ? 'post_sale'
        : 'in_sale';
    return {
      messageType: 'order_card',
      card: {
        type: 'order',
        order_id: String(firstDefined(content.orderId, content.orderSn, '') || ''),
        order_sn: String(firstDefined(content.orderSn, '') || ''),
        title: String(firstDefined(content.title, '') || ''),
        status: String(firstDefined(content.status, '') || ''),
        amount: firstDefined(content.amount, null),
        url: firstDefined(content.url, null),
        image: firstDefined(content.pic, null)
      },
      orderFacts: {
        hasOrder: true,
        orderStage,
        orderSummary: buildOrderSummary(content),
        customerStage,
        customerStageSource: 'order_card'
      }
    };
  }

  return {
    messageType: 'text',
    card: {},
    orderFacts: buildDefaultOrderFacts()
  };
}

function parseContentByType(typeCode, param) {
  const content = normalizeContent(param);
  const rawText = firstDefined(content.text, content.content, content.msg, param.text, param.message);

  switch (typeCode) {
    case 0:
      return { text: String(rawText || '') };
    case 1:
      return {
        url: firstDefined(content.url, content.imageUrl, content.picUrl, content.pic, param.url),
        thumb: firstDefined(content.thumb, content.thumbnail, content.thumbUrl)
      };
    case 2:
      return {
        url: firstDefined(content.url, content.voiceUrl, param.url),
        duration: firstDefined(content.duration, content.time, content.voiceTime)
      };
    case 3:
      return {
        url: firstDefined(content.url, content.videoUrl, param.url),
        cover: firstDefined(content.cover, content.coverUrl, content.pic)
      };
    case 4:
      return parseCardContent(content, {
        goodsId: ['goodsId', 'goods_id', 'id'],
        goodsName: ['goodsName', 'goods_name', 'title', 'name'],
        price: ['price', 'goodsPrice', 'goods_price'],
        url: ['url', 'link', 'goodsUrl', 'goods_url'],
        pic: ['pic', 'image', 'imageUrl', 'picUrl', 'thumbUrl']
      });
    case 5:
      return parseCardContent(content, {
        orderId: ['orderId', 'order_id', 'id'],
        orderSn: ['orderSn', 'order_sn', 'sn'],
        title: ['title', 'goodsName', 'goods_name', 'name'],
        status: ['status', 'orderStatus', 'order_status'],
        amount: ['amount', 'price', 'payAmount', 'pay_amount'],
        url: ['url', 'link', 'orderUrl', 'order_url'],
        pic: ['pic', 'image', 'imageUrl', 'picUrl']
      });
    case 16:
      return {
        id: firstDefined(content.id, content.emotionId, content.emojiId),
        url: firstDefined(content.url, content.pic, content.imageUrl),
        text: firstDefined(content.text, content.name, rawText)
      };
    case 17:
      return {
        recalledMsgId: firstDefined(content.msgId, content.recallMsgId, param.recallMsgId),
        text: firstDefined(rawText, 'Message recalled')
      };
    case 28:
      return {
        title: firstDefined(content.title, rawText),
        url: firstDefined(content.url, content.link, param.url),
        desc: firstDefined(content.desc, content.description),
        pic: firstDefined(content.pic, content.imageUrl)
      };
    case 999:
      return { text: String(firstDefined(rawText, content.title, param.title, '') || '') };
    default:
      return content;
  }
}

function parsePddMessage(raw) {
  const normalized = normalizeEnvelope(raw);
  if (!normalized) return null;

  const { envelope, param } = normalized;
  const typeCode = Number(firstDefined(param.msgType, param.messageType, param.type, envelope.msgType, 999));
  const kind = MESSAGE_TYPES[typeCode] || 'unknown';
  const directionCode = Number(firstDefined(param.direction, param.from, param.role, 3));
  const direction = DIRECTIONS[directionCode] || 'system';
  const conversationId = String(firstDefined(param.targetId, param.uid, param.buyerId, param.sessionId, param.mallId, 'unknown'));
  const msgId = String(firstDefined(param.msgId, param.messageId, param.id, `${conversationId}-${Date.now()}`));
  const timestamp = normalizeTimestamp(firstDefined(param.timestamp, param.ts, param.time, param.createdAt, Date.now()));
  const content = parseContentByType(typeCode, param);
  const meta = buildStructuredMessageMeta(kind, content);

  return {
    id: msgId,
    conversationId,
    senderId: String(firstDefined(resolvePddSenderId(param, direction), '')),
    senderName: String(firstDefined(param.senderName, param.nickname, param.name, '')),
    direction,
    kind,
    typeCode,
    messageType: meta.messageType,
    card: meta.card,
    orderFacts: meta.orderFacts,
    content,
    raw: param,
    timestamp
  };
}

function parsePddMessages(raw) {
  const envelope = safeJson(raw);
  if (!envelope || typeof envelope !== 'object') return [];

  if (String(envelope.type || '').toLowerCase() === 'message' && Array.isArray(envelope.msg)) {
    return envelope.msg
      .map((item) => parsePddMessage(normalizeFukePddItem(item, envelope)))
      .filter(Boolean);
  }

  const parsed = parsePddMessage(envelope);
  return parsed ? [parsed] : [];
}

function normalizeQnContent(item) {
  const content = safeJson(firstDefined(item.msg, item.content, {}));
  if (content && typeof content === 'object') {
    return {
      text: String(firstDefined(content.text, content.content, content.title, content.url, '') || ''),
      raw: content
    };
  }
  return { text: String(content || '') };
}

function parseQnItem(item, envelope = {}) {
  if (!item || typeof item !== 'object') return null;
  const type = String(envelope.type || '');
  const param = envelope.param && typeof envelope.param === 'object' ? envelope.param : {};
  const content = normalizeQnContent(item);
  const conversationId = String(firstDefined(param.ccode, item.apiChatUri, item.ccode, item.fromidTargetId, item.toidTargetId, 'unknown'));
  const fromTargetId = String(firstDefined(item.fromidTargetId, ''));
  const loginTargetId = String(firstDefined(item.loginidTargetId, ''));
  const direction = fromTargetId && loginTargetId
    ? (fromTargetId === loginTargetId ? 'assistant' : 'user')
    : (type === 'newMsg' || Number(item.selfState) === 1 ? 'assistant' : 'user');
  const meta = buildStructuredMessageMeta(content.text ? 'text' : 'unknown', content);

  return {
    id: String(firstDefined(item.stableKey, item.msgid, item.messageId, `${conversationId}-${Date.now()}`)),
    conversationId,
    senderId: String(direction === 'assistant'
      ? firstDefined(item.loginidTargetId, item.fromidTargetId, '')
      : firstDefined(item.fromidTargetId, item.toidTargetId, '')),
    senderName: String(direction === 'assistant'
      ? firstDefined(item.loginid, item.fromid, '')
      : firstDefined(item.fromid, item.toid, '')),
    direction,
    kind: content.text ? 'text' : 'unknown',
    typeCode: Number(firstDefined(item.templateId, 0)),
    messageType: meta.messageType,
    card: meta.card,
    orderFacts: meta.orderFacts,
    content,
    raw: item,
    timestamp: Number(firstDefined(item.msgtime, item.svrtime, Date.now()))
  };
}

function parseQnMessages(raw) {
  const envelope = safeJson(raw);
  if (!envelope || typeof envelope !== 'object') return [];
  const type = String(envelope.type || '');
  if (!['message', 'newMsg'].includes(type) || !Array.isArray(envelope.msg)) return [];
  return envelope.msg.map((item) => parseQnItem(item, envelope)).filter(Boolean);
}

function parseProtocolMessage(raw) {
  const envelope = safeJson(raw);
  if (!envelope || typeof envelope !== 'object') return null;

  const type = String(envelope.type || envelope.act || '').toLowerCase();
  if (!PROTOCOL_TYPES.has(type)) return null;

  const payload = safeJson(firstDefined(envelope.param, envelope.data, envelope.payload, envelope.msg, {}));
  const normalizedPayload = payload && typeof payload === 'object' ? payload : { value: payload };
  const requestId = firstDefined(envelope.requestId, envelope.id, normalizedPayload.requestId);
  const sessionId = firstDefined(envelope.sessionId, normalizedPayload.sessionId, envelope.targetId, normalizedPayload.targetId);
  const parsed = {
    type,
    payload: Object.keys(normalizedPayload).length ? normalizedPayload : Object.fromEntries(
      Object.entries(envelope).filter(([key]) => !['type', 'act', 'requestId', 'id'].includes(key))
    ),
    raw: envelope
  };

  if (requestId !== undefined) parsed.requestId = String(requestId);
  if (sessionId !== undefined) parsed.sessionId = String(sessionId);

  if (type === 'error') {
    parsed.error = {
      code: firstDefined(envelope.code, normalizedPayload.code, 'ERROR'),
      message: String(firstDefined(envelope.message, normalizedPayload.message, envelope.error, 'Unknown error'))
    };
  }

  return parsed;
}

module.exports = {
  MESSAGE_TYPES,
  DIRECTIONS,
  PROTOCOL_TYPES,
  parsePddMessage,
  parsePddMessages,
  parseQnMessages,
  parseProtocolMessage,
  safeJson
};
