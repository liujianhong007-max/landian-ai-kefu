const test = require('node:test');
const assert = require('node:assert/strict');

const { createAutoReplyHandler } = require('../main/chat-handlers');

test('auto reply handler skips messages when current shop AI override is disabled', async () => {
  const sent = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, payload) {
        sent.push([targetId, payload]);
        return 1;
      }
    }),
    getAiSettings: () => ({
      enabled: true,
      baseUrl: 'http://tmagent.local',
      merchantName: '疾风AI客服',
      tenantId: 'tenant-1',
      apiKey: 'sk-test',
      shopOverrides: {
        'pdd::440745': {
          platform: 'pdd',
          shopId: '440745',
          shopName: '霸派运动户外旗舰店',
          enabled: false,
          updatedAt: Date.now()
        }
      }
    }),
    logger: { log() {}, error() {} }
  });

  const result = await handler({
    client: {
      platform: 'publicplatform',
      shopId: '440745',
      shopName: '霸派运动户外旗舰店'
    },
    message: {
      id: 'msg-1',
      conversationId: 'cs_440745_186839495',
      direction: 'user',
      kind: 'text',
      senderName: '买家A',
      senderId: 'buyer-a',
      timestamp: Date.now(),
      content: { text: '你好' }
    }
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'shop-ai-disabled');
  assert.equal(sent.length, 0);
});
