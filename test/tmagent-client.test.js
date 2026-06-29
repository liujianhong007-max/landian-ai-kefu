const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_API_KEY,
  buildTmagentChatPayload,
  normalizePlatform,
  requestTmagentChat
} = require('../main/tmagent-client');

test('bundled tmagent API key is the current provided x-api-key', () => {
  assert.equal(DEFAULT_API_KEY.startsWith('sk-HXYPG9O5'), true);
  assert.equal(DEFAULT_API_KEY.endsWith('OTQXyiDf4'), true);
  assert.equal(DEFAULT_API_KEY.length, 46);
});

test('builds tmagent chat payload from a PDD buyer text message', () => {
  const payload = buildTmagentChatPayload({
    message: {
      id: 'msg-1',
      conversationId: 'conv-1',
      senderId: 'buyer-1',
      senderName: '买家',
      direction: 'user',
      kind: 'text',
      content: { text: '什么时候发货？' },
      orderFacts: {
        hasOrder: false,
        orderStage: 'no_recent_order',
        orderSummary: '无相关订单',
        customerStage: 'pre_sale',
        customerStageSource: 'no_order'
      }
    }
  }, {
    shopId: 'shop-001',
    shopName: '拼多多店铺'
  });

  assert.deepEqual(payload, {
    conversation_id: 'pdd:shop-001:buyer-1',
    platform: 'pdd',
    shop_id: 'shop-001',
    shop_name: '拼多多店铺',
    buyer_id: 'buyer-1',
    buyer_name: '买家',
    message_type: 'text',
    message: '什么时候发货？',
    card: {},
    has_order: false,
    order_stage: 'no_recent_order',
    order_summary: '无相关订单',
    customer_stage: 'pre_sale',
    customer_stage_source: 'no_order',
    image_source: null,
    shop_rules: {},
    context: {},
    debug: false
  });
});

test('builds tmagent payload from a PDD order card message', () => {
  const payload = buildTmagentChatPayload({
    client: { platform: 'publicplatform' },
    message: {
      conversationId: 'conv-2',
      senderId: 'buyer-2',
      senderName: '买家2',
      kind: 'order',
      messageType: 'order_card',
      card: {
        type: 'order',
        order_id: 'order-123',
        order_sn: '',
        title: 'Tarot deck',
        status: '已发货',
        amount: '49.90',
        url: 'https://example.test/order/123',
        image: 'https://example.test/order.png'
      },
      orderFacts: {
        hasOrder: true,
        orderStage: 'shipped',
        orderSummary: 'Tarot deck | 已发货 | 金额 49.90 | 订单 order-123',
        customerStage: 'in_sale',
        customerStageSource: 'order_card'
      },
      content: { text: '' }
    }
  }, {
    shopId: 'shop-002',
    shopName: 'PDD Shop'
  });

  assert.equal(payload.conversation_id, 'pdd:shop-002:buyer-2');
  assert.equal(payload.message_type, 'order_card');
  assert.equal(payload.has_order, true);
  assert.equal(payload.order_stage, 'shipped');
  assert.equal(payload.order_summary, 'Tarot deck | 已发货 | 金额 49.90 | 订单 order-123');
  assert.deepEqual(payload.card, {
    type: 'order',
    order_id: 'order-123',
    order_sn: '',
    title: 'Tarot deck',
    status: '已发货',
    amount: '49.90',
    url: 'https://example.test/order/123',
    image: 'https://example.test/order.png'
  });
});

test('builds tmagent payload for QN with normalized platform name', () => {
  const payload = buildTmagentChatPayload({
    client: { platform: 'qn' },
    message: {
      conversationId: 'buyer-1.1-seller-1.1#11001@cntaobao',
      senderId: 'buyer-1',
      senderName: 'tb123',
      kind: 'text',
      content: { text: '你好' }
    }
  }, {
    shopId: 'shop-qn',
    shopName: '千牛店铺'
  });

  assert.equal(payload.platform, 'qianniu');
  assert.equal(payload.conversation_id, 'qianniu:shop-qn:buyer-1');
  assert.equal(payload.buyer_id, 'buyer-1');
});

test('normalizes platform aliases', () => {
  assert.equal(normalizePlatform('publicplatform'), 'pdd');
  assert.equal(normalizePlatform('pdd'), 'pdd');
  assert.equal(normalizePlatform('qn'), 'qianniu');
  assert.equal(normalizePlatform('qianniu'), 'qianniu');
});

test('request tmagent chat posts JSON with API key and returns parsed response', async () => {
  const calls = [];
  const response = await requestTmagentChat({
    baseUrl: 'http://tmagent.local/',
    apiKey: 'sk-test',
    payload: { message: 'hi' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return { reply: '您好', action: null };
        }
      };
    }
  });

  assert.deepEqual(response, { reply: '您好', action: null });
  assert.equal(calls[0].url, 'http://tmagent.local/api/orchestrate/chat');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers['X-API-Key'], 'sk-test');
  assert.deepEqual(JSON.parse(calls[0].options.body), { message: 'hi' });
});

test('request tmagent chat uses bundled default API key when no API key is provided', async () => {
  const calls = [];
  await requestTmagentChat({
    baseUrl: 'http://tmagent.local',
    payload: { message: 'hi' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return { reply: '您好' };
        }
      };
    }
  });

  assert.equal(calls[0].options.headers['X-API-Key'], DEFAULT_API_KEY);
});
