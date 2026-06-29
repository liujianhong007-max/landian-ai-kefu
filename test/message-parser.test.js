const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePddMessage, parsePddMessages, parseProtocolMessage, parseQnMessages } = require('../main/message-parser');

test('parses PDD text messages with default tmagent metadata', () => {
  const parsed = parsePddMessage({
    type: 'msg',
    act: 'push',
    param: {
      msgId: 'm1',
      targetId: 'buyer-1',
      senderId: 'buyer-1',
      direction: 1,
      msgType: 0,
      content: 'hello'
    }
  });

  assert.equal(parsed.kind, 'text');
  assert.equal(parsed.direction, 'user');
  assert.equal(parsed.content.text, 'hello');
  assert.equal(parsed.conversationId, 'buyer-1');
  assert.equal(parsed.senderId, 'buyer-1');
  assert.equal(parsed.messageType, 'text');
  assert.deepEqual(parsed.card, {});
  assert.deepEqual(parsed.orderFacts, {
    hasOrder: false,
    orderStage: 'no_recent_order',
    orderSummary: '无相关订单',
    customerStage: 'pre_sale',
    customerStageSource: 'no_order'
  });
});

test('parses PDD buyer senderId from nested from uid', () => {
  const [parsed] = parsePddMessages({
    type: 'message',
    source: 'recv_message',
    msg: [{
      client_msg_id: 'client-1',
      content: 'hello',
      from: { role: 'user', uid: 'buyer-from-uid' },
      to: { role: 'mall_cs', uid: 'mall-cs-1' },
      msg_id: 'server-msg-1',
      nickname: '买家昵称',
      ts: 1710000000
    }]
  });

  assert.equal(parsed.senderId, 'buyer-from-uid');
  assert.equal(parsed.conversationId, 'buyer-from-uid');
});

test('parses PDD goods card messages with structured card fields', () => {
  const parsed = parsePddMessage({
    param: JSON.stringify({
      id: 'm2',
      uid: 'buyer-2',
      senderId: 'buyer-2',
      direction: 2,
      type: 4,
      content: JSON.stringify({
        goodsId: '123',
        goodsName: 'Sample product',
        price: '19.90',
        url: 'https://mobile.yangkeduo.com/goods.html?goods_id=123',
        pic: 'https://example.test/p.png'
      })
    })
  });

  assert.equal(parsed.kind, 'goods');
  assert.equal(parsed.messageType, 'product_card');
  assert.deepEqual(parsed.card, {
    type: 'product',
    goods_id: '123',
    title: 'Sample product',
    price: '19.90',
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=123',
    image: 'https://example.test/p.png'
  });
  assert.equal(parsed.orderFacts.hasOrder, false);
});

test('parses PDD order card messages with normalized order facts', () => {
  const parsed = parsePddMessage({
    param: {
      msgId: 'm3',
      targetId: 'buyer-3',
      senderId: 'buyer-3',
      direction: 1,
      msgType: 5,
      content: {
        orderId: 'order-123',
        title: 'Tarot deck',
        status: '已发货',
        amount: '49.90',
        url: 'https://example.test/order/123',
        pic: 'https://example.test/order.png'
      }
    }
  });

  assert.equal(parsed.kind, 'order');
  assert.equal(parsed.messageType, 'order_card');
  assert.deepEqual(parsed.card, {
    type: 'order',
    order_id: 'order-123',
    order_sn: '',
    title: 'Tarot deck',
    status: '已发货',
    amount: '49.90',
    url: 'https://example.test/order/123',
    image: 'https://example.test/order.png'
  });
  assert.deepEqual(parsed.orderFacts, {
    hasOrder: true,
    orderStage: 'shipped',
    orderSummary: 'Tarot deck | 已发货 | 金额 49.90 | 订单 order-123',
    customerStage: 'in_sale',
    customerStageSource: 'order_card'
  });
});

test('normalizes PDD second timestamps to milliseconds', () => {
  const parsed = parsePddMessage({
    param: {
      msgId: 'm-seconds',
      targetId: 'buyer-seconds',
      direction: 1,
      msgType: 0,
      content: 'fresh message',
      ts: 1710000000
    }
  });

  assert.equal(parsed.timestamp, 1710000000000);
});

test('returns null for heartbeat envelopes', () => {
  assert.equal(parsePddMessage({ type: 'heartbeat' }), null);
});

test('parses ack protocol messages', () => {
  assert.deepEqual(parseProtocolMessage({
    type: 'ack',
    requestId: 'req-1',
    param: { ok: true }
  }), {
    type: 'ack',
    requestId: 'req-1',
    payload: { ok: true },
    raw: {
      type: 'ack',
      requestId: 'req-1',
      param: { ok: true }
    }
  });
});

test('parses error protocol messages', () => {
  const parsed = parseProtocolMessage({
    type: 'error',
    requestId: 'req-2',
    message: 'failed'
  });

  assert.equal(parsed.type, 'error');
  assert.equal(parsed.requestId, 'req-2');
  assert.equal(parsed.error.message, 'failed');
});

test('parses login and session protocol messages', () => {
  assert.deepEqual(parseProtocolMessage({
    type: 'login',
    token: 'token-1',
    userId: 'csr-1'
  }), {
    type: 'login',
    payload: {
      token: 'token-1',
      userId: 'csr-1'
    },
    raw: {
      type: 'login',
      token: 'token-1',
      userId: 'csr-1'
    }
  });

  assert.deepEqual(parseProtocolMessage({
    type: 'session',
    sessionId: 'buyer-1',
    status: 'active'
  }), {
    type: 'session',
    sessionId: 'buyer-1',
    payload: {
      sessionId: 'buyer-1',
      status: 'active'
    },
    raw: {
      type: 'session',
      sessionId: 'buyer-1',
      status: 'active'
    }
  });
});

test('parses currentCsr, currentConv, and remote_his_message protocol messages', () => {
  assert.deepEqual(parseProtocolMessage({
    type: 'currentCsr',
    nick: '主账号',
    platform: 'pdd'
  }), {
    type: 'currentcsr',
    payload: {
      nick: '主账号',
      platform: 'pdd'
    },
    raw: {
      type: 'currentCsr',
      nick: '主账号',
      platform: 'pdd'
    }
  });

  assert.deepEqual(parseProtocolMessage({
    type: 'currentConv',
    ccode: 'buyer-1',
    nick: '买家甲'
  }), {
    type: 'currentconv',
    payload: {
      ccode: 'buyer-1',
      nick: '买家甲'
    },
    raw: {
      type: 'currentConv',
      ccode: 'buyer-1',
      nick: '买家甲'
    }
  });

  assert.deepEqual(parseProtocolMessage({
    type: 'remote_his_message',
    param: { ccode: 'buyer-1' },
    msg: [{ msgId: 'm1', content: 'hello' }]
  }), {
    type: 'remote_his_message',
    payload: {
      ccode: 'buyer-1'
    },
    raw: {
      type: 'remote_his_message',
      param: { ccode: 'buyer-1' },
      msg: [{ msgId: 'm1', content: 'hello' }]
    }
  });

  assert.deepEqual(parseProtocolMessage({
    type: 'queryOrderRemarkResult',
    requestId: 'req-order-query',
    success: true,
    result: { remark: '已备注', tagColor: 'RED', tagName: '红色' }
  }), {
    type: 'queryorderremarkresult',
    requestId: 'req-order-query',
    payload: {
      success: true,
      result: { remark: '已备注', tagColor: 'RED', tagName: '红色' }
    },
    raw: {
      type: 'queryOrderRemarkResult',
      requestId: 'req-order-query',
      success: true,
      result: { remark: '已备注', tagColor: 'RED', tagName: '红色' }
    }
  });

  assert.deepEqual(parseProtocolMessage({
    type: 'setOrderRemarkResult',
    requestId: 'req-order-set',
    success: false,
    errorMsg: 'timeout'
  }), {
    type: 'setorderremarkresult',
    requestId: 'req-order-set',
    payload: {
      success: false,
      errorMsg: 'timeout'
    },
    raw: {
      type: 'setOrderRemarkResult',
      requestId: 'req-order-set',
      success: false,
      errorMsg: 'timeout'
    }
  });

  assert.deepEqual(parseProtocolMessage({
    type: 'autoOrderMessageResult',
    requestId: 'req-order-send',
    success: true,
    errorMsg: '成功'
  }), {
    type: 'autoordermessageresult',
    requestId: 'req-order-send',
    payload: {
      success: true,
      errorMsg: '成功'
    },
    raw: {
      type: 'autoOrderMessageResult',
      requestId: 'req-order-send',
      success: true,
      errorMsg: '成功'
    }
  });
});

test('parses QN buyer and assistant text messages with default order facts', () => {
  const buyerMessages = parseQnMessages({
    type: 'message',
    msg: [{
      stableKey: 'buyer-key-1',
      fromid: 'buyerNick',
      fromidTargetId: 'buyer-1',
      loginid: 'sellerNick',
      loginidTargetId: 'seller-1',
      toid: 'sellerNick',
      toidTargetId: 'seller-1',
      msg: { text: '你好' },
      selfState: 1,
      msgtime: 1710000000000,
      templateId: 0
    }],
    param: { ccode: 'buyer-1.1-seller-1.1#11001@cntaobao' }
  });
  const assistantMessages = parseQnMessages({
    type: 'newMsg',
    msg: [{
      stableKey: 'seller-key-1',
      fromid: 'sellerNick',
      fromidTargetId: 'seller-1',
      loginid: 'sellerNick',
      loginidTargetId: 'seller-1',
      toid: 'buyerNick',
      toidTargetId: 'buyer-1',
      msg: { text: '在的' },
      selfState: 1,
      msgtime: 1710000000001,
      templateId: 0
    }],
    param: { ccode: 'buyer-1.1-seller-1.1#11001@cntaobao' }
  });

  assert.equal(buyerMessages[0].id, 'buyer-key-1');
  assert.equal(buyerMessages[0].conversationId, 'buyer-1.1-seller-1.1#11001@cntaobao');
  assert.equal(buyerMessages[0].direction, 'user');
  assert.equal(buyerMessages[0].messageType, 'text');
  assert.equal(buyerMessages[0].content.text, '你好');
  assert.equal(buyerMessages[0].orderFacts.orderSummary, '无相关订单');
  assert.equal(assistantMessages[0].direction, 'assistant');
  assert.equal(assistantMessages[0].content.text, '在的');
});

test('does not parse QN non-chat events as messages', () => {
  assert.deepEqual(parseQnMessages({
    type: 'conv_change',
    msg: {
      ccode: '2222657198225.1-1723106647.1#11001@cntaobao',
      display: 'tb087884122396'
    },
    param: null
  }), []);
  assert.deepEqual(parseQnMessages({ type: 'userOrders', msg: [], param: null }), []);
});

test('parses currentCsr protocol payload from msg field', () => {
  assert.deepEqual(parseProtocolMessage({
    type: 'currentCsr',
    msg: {
      nick: '主账号',
      display: '主账号',
      targetId: 'cs_440745_186839495',
      shopName: '霸派运动户外旗舰店',
      shopId: '440745',
      mallId: '440745',
      platform: 'pdd'
    }
  }), {
    type: 'currentcsr',
    payload: {
      nick: '主账号',
      display: '主账号',
      targetId: 'cs_440745_186839495',
      shopName: '霸派运动户外旗舰店',
      shopId: '440745',
      mallId: '440745',
      platform: 'pdd'
    },
    raw: {
      type: 'currentCsr',
      msg: {
        nick: '主账号',
        display: '主账号',
        targetId: 'cs_440745_186839495',
        shopName: '霸派运动户外旗舰店',
        shopId: '440745',
        mallId: '440745',
        platform: 'pdd'
      }
    },
    sessionId: 'cs_440745_186839495'
  });
});
