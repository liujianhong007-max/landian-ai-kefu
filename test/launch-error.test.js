const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  createPddLaunchHandler,
  createSendMessageHandler,
  createPddCommandHandler,
  createAutoReplyHandler,
  createConversationHandoffStore,
  createBridgeObservationState,
  getBridgeObservationSnapshot,
  noteBridgeHttpStarted,
  noteBridgeClientConnected,
  noteBridgeClientDisconnected,
  noteBridgeDiagnostic,
  bindPddStatusEvents,
  startPddBridgeServer,
  createWbChatChangeHandler,
  computeFloatingBounds
} = require('../main/index');

test('pdd launch handler logs and rejects launch failures', async () => {
  const messages = [];
  const error = new Error('launch exploded');
  const handler = createPddLaunchHandler({
    getPddManager: () => ({
      async launch() {
        throw error;
      }
    }),
    logger: {
      log: (...args) => messages.push(['log', ...args]),
      error: (...args) => messages.push(['error', ...args])
    }
  });

  await assert.rejects(handler(), /launch exploded/);
  assert.deepEqual(messages[0], ['log', '[pdd:launch] launch requested']);
  assert.equal(messages[1][0], 'error');
  assert.equal(messages[1][1], '[pdd:launch] launch failed');
  assert.equal(messages[1][2], error);
});

test('pdd launch handler logs returned launch error status', async () => {
  const messages = [];
  const status = { running: false, lastError: 'PddWorkbench.exe was not found.' };
  const handler = createPddLaunchHandler({
    getPddManager: () => ({
      async launch() {
        return status;
      }
    }),
    logger: {
      log: (...args) => messages.push(['log', ...args]),
      error: (...args) => messages.push(['error', ...args])
    }
  });

  assert.equal(await handler(), status);
  assert.deepEqual(messages[1], ['error', '[pdd:launch] launch returned error status', status.lastError]);
});

test('main process forwards bridge and CDP statuses to renderer channels and pdd status', () => {
  const manager = new EventEmitter();
  manager.status = { running: true, pid: 4321 };
  const sent = [];

  bindPddStatusEvents(manager, (channel, payload) => sent.push([channel, payload]));

  manager.emit('bridge:injected', { pid: 4321, dllPath: 'C:\\hook.dll' });
  manager.emit('bridge:inject-error', new Error('inject failed'));
  manager.emit('cdp-ready', { connected: true, url: 'ws://127.0.0.1:19999' });
  manager.emit('cdp-error', new Error('cdp failed'));

  assert.deepEqual(sent, [
    ['bridge:status', { injected: true, pid: 4321, dllPath: 'C:\\hook.dll' }],
    ['pdd:status', { running: true, pid: 4321, bridgeInjected: true, bridgeError: null }],
    ['bridge:status', { injected: false, error: 'inject failed' }],
    ['pdd:status', { running: true, pid: 4321, bridgeInjected: false, bridgeError: 'inject failed' }],
    ['cdp:status', { connected: true, url: 'ws://127.0.0.1:19999' }],
    ['pdd:status', { running: true, pid: 4321, cdpConnected: true, cdpError: null }],
    ['cdp:status', { connected: false, error: 'cdp failed' }],
    ['pdd:status', { running: true, pid: 4321, cdpConnected: false, cdpError: 'cdp failed' }]
  ]);
});

test('bridge observation gate requires http, websocket, and page-ready before transfer trace starts', () => {
  const state = createBridgeObservationState();

  noteBridgeHttpStarted(state, { url: 'http://127.0.0.1:65495/pdd-bridge.js', port: 65495 });
  noteBridgeClientConnected(state, { id: 'pdd-1', platform: 'pdd', path: '/publicplatform' });

  assert.deepEqual(getBridgeObservationSnapshot(state), {
    httpStarted: true,
    bridgeUrl: 'http://127.0.0.1:65495/pdd-bridge.js',
    wsConnected: true,
    pageReady: false,
    pageReadyAt: null,
    lastClientId: 'pdd-1',
    activeTraceId: null,
    ready: false
  });

  noteBridgeDiagnostic(state, {
    diagnostic: {
      name: 'page-ready',
      time: 123,
      payload: { href: 'https://mms.pinduoduo.com/chat' }
    }
  });

  assert.deepEqual(getBridgeObservationSnapshot(state), {
    httpStarted: true,
    bridgeUrl: 'http://127.0.0.1:65495/pdd-bridge.js',
    wsConnected: true,
    pageReady: true,
    pageReadyAt: 123,
    lastClientId: 'pdd-1',
    activeTraceId: null,
    ready: true
  });

  noteBridgeClientDisconnected(state, { id: 'pdd-1' });

  assert.deepEqual(getBridgeObservationSnapshot(state), {
    httpStarted: true,
    bridgeUrl: 'http://127.0.0.1:65495/pdd-bridge.js',
    wsConnected: false,
    pageReady: false,
    pageReadyAt: null,
    lastClientId: null,
    activeTraceId: null,
    ready: false
  });
});

test('bridge observation tags transfer diagnostics with a trace id only after bridge is ready', () => {
  const state = createBridgeObservationState();

  const skipped = noteBridgeDiagnostic(state, {
    client: { id: 'pdd-1', platform: 'pdd', path: '/publicplatform' },
    diagnostic: {
      name: 'transfer-click',
      time: 200,
      payload: { text: '转移会话' }
    }
  }, { now: () => 5000 });

  assert.equal(skipped.diagnostic.payload.traceId, undefined);
  assert.equal(skipped.diagnostic.payload.bridgeReady, false);

  noteBridgeHttpStarted(state, { url: 'http://127.0.0.1:65495/pdd-bridge.js', port: 65495 });
  noteBridgeClientConnected(state, { id: 'pdd-1', platform: 'pdd', path: '/publicplatform' });
  noteBridgeDiagnostic(state, {
    diagnostic: {
      name: 'page-ready',
      time: 300,
      payload: { href: 'https://mms.pinduoduo.com/chat' }
    }
  });

  const tracedClick = noteBridgeDiagnostic(state, {
    client: { id: 'pdd-1', platform: 'pdd', path: '/publicplatform' },
    diagnostic: {
      name: 'transfer-click',
      time: 301,
      payload: { text: '转移会话' }
    }
  }, { now: () => 6000 });
  const tracedReason = noteBridgeDiagnostic(state, {
    client: { id: 'pdd-1', platform: 'pdd', path: '/publicplatform' },
    diagnostic: {
      name: 'transfer-ui',
      time: 302,
      payload: { reason: 'mutation', text: '无原因直接转移' }
    }
  }, { now: () => 6001 });

  assert.equal(tracedClick.diagnostic.payload.bridgeReady, true);
  assert.match(tracedClick.diagnostic.payload.traceId, /^transfer-6000$/);
  assert.equal(tracedReason.diagnostic.payload.traceId, tracedClick.diagnostic.payload.traceId);
  assert.equal(getBridgeObservationSnapshot(state).activeTraceId, tracedClick.diagnostic.payload.traceId);
});

test('floating plugin bounds follow the right side of the PDD window and clamp to screen', () => {
  assert.deepEqual(computeFloatingBounds({
    targetBounds: { x: 100, y: 80, width: 900, height: 700 },
    displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
    pluginSize: { width: 320, height: 640 },
    gap: 8
  }), {
    x: 1008,
    y: 80,
    width: 320,
    height: 640
  });

  assert.deepEqual(computeFloatingBounds({
    targetBounds: { x: 1180, y: 20, width: 300, height: 900 },
    displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
    pluginSize: { width: 320, height: 640 },
    gap: 8
  }), {
    x: 852,
    y: 20,
    width: 320,
    height: 640
  });
});

test('pdd bridge server serves bridge javascript that connects to the websocket port', async () => {
  const server = await startPddBridgeServer({ wsPort: 4567 });

  try {
    const script = await new Promise((resolve, reject) => {
      http.get(server.url, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ statusCode: response.statusCode, contentType: response.headers['content-type'], body }));
      }).on('error', reject);
    });

    assert.equal(script.statusCode, 200);
    assert.match(script.contentType, /^application\/javascript/);
    assert.match(script.body, /\[pdd-bridge\] loaded/);
    assert.match(script.body, /window\.js_data/);
    assert.match(script.body, /ws:\/\/127\.0\.0\.1:\$\{port\}\/publicplatform/);
    assert.match(script.body, /type: 'diagnostic'/);
    assert.match(script.body, /page-websocket-message/);
    assert.match(script.body, /fetch-response/);
    assert.match(script.body, /xhr-load/);
    assert.match(script.body, /window-message/);
    assert.match(script.body, /window-post-message/);
    assert.match(script.body, /dom-dispatch-event/);
    assert.match(script.body, /transfer-click/);
    assert.match(script.body, /transfer-ui/);
    assert.match(script.body, /transfer-xhr-send/);
    assert.match(script.body, /transfer-fetch-request/);
    assert.match(script.body, /transfer-native-event/);
    assert.match(script.body, /bridge-script-start/);
    assert.match(script.body, /bridge-script-entered/);
    assert.match(script.body, /bridge-script-port-resolved/);
    assert.match(script.body, /bridge-ws-construct/);
    assert.match(script.body, /bridge-ws-construct-failed/);
    assert.match(script.body, /bridge-ws-open/);
    assert.match(script.body, /bridge-ws-error/);
    assert.match(script.body, /bridge-ws-close/);
    assert.match(script.body, /window-error/);
    assert.match(script.body, /unhandled-rejection/);
    assert.match(script.body, /document-click-capture/);
    assert.match(script.body, /iframe-scan/);
    assert.match(script.body, /storage-set-item/);
    assert.match(script.body, /indexeddb-open/);
    assert.match(script.body, /eventsource-message/);
    assert.match(script.body, /pinnotification\.message/);
    assert.match(script.body, /window\.OnNativeEvent/);
    assert.match(script.body, /window\.__pddFukeBridgeSocket \|\| socket/);
    assert.match(script.body, /recv_message/);
    assert.match(script.body, /MMSSocketReceiveMessage/);
    assert.match(script.body, /socketUtil\.sendMsg/);
    assert.match(script.body, /transferConversation/);
    assert.match(script.body, /getAssignCsList/);
    assert.match(script.body, /move_conversation/);
    assert.match(script.body, /transfer-result/);
    assert.match(script.body, /pdd-bridge-beacon/);
    assert.match(script.body, /bridgeHttpBeacon/);
    assert.match(script.body, /bridge-js-loaded/);
    assert.match(script.body, /bridge-js-entered/);
    assert.match(script.body, /bridge-js-port-resolved/);
    assert.match(script.body, /bridge-js-after-websocket-construct/);
    assert.match(script.body, /bridge-js-websocket-construct-failed/);
    assert.match(script.body, /bridge-js-install-probe/);
    assert.match(script.body, /current-shop-detected/);
    assert.match(script.body, /shop-tab-change/);
    assert.match(script.body, /getCurrentCsr/);
    assert.match(script.body, /getCurrentConv/);
    assert.match(script.body, /getRemoteHisMsg/);
    assert.match(script.body, /queryOrderRemark/);
    assert.match(script.body, /setOrderRemark/);
    assert.match(script.body, /autoOrderMessage/);
    assert.match(script.body, /currentCsr/);
    assert.match(script.body, /currentConv/);
    assert.match(script.body, /remote_his_message/);
    assert.match(script.body, /plateau\/chat\/list/);
    assert.match(script.body, /pizza\/order\/noteTag\/query/);
    assert.match(script.body, /pizza\/order\/noteTag\/update/);
    assert.match(script.body, /chats\/getUserByOrderSn/);
    assert.match(script.body, /queryOrderRemarkResult/);
    assert.match(script.body, /setOrderRemarkResult/);
    assert.match(script.body, /autoOrderMessageResult/);

    const qnScript = await new Promise((resolve, reject) => {
      http.get(server.qnUrl, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ statusCode: response.statusCode, contentType: response.headers['content-type'], body }));
      }).on('error', reject);
    });

    assert.equal(qnScript.statusCode, 200);
    assert.match(qnScript.contentType, /^application\/javascript/);
    assert.match(qnScript.body, /platform=qn/);
    assert.match(qnScript.body, /window\.js_data/);
  } finally {
    await server.close();
  }
});

test('pdd bridge server accepts http beacon diagnostics without websocket', async () => {
  const logs = [];
  const server = await startPddBridgeServer({
    wsPort: 4567,
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  try {
    const response = await new Promise((resolve, reject) => {
      http.get(
        `${server.url.replace('/pdd-bridge.js', '/pdd-bridge-beacon')}?name=bridge-js-loaded&href=${encodeURIComponent('https://mms.pinduoduo.com/chat')}&top=1`,
        (res) => {
          res.resume();
          res.on('end', () => resolve({ statusCode: res.statusCode, contentType: res.headers['content-type'] }));
        }
      ).on('error', reject);
    });

    assert.equal(response.statusCode, 204);
    assert.equal(logs.some((entry) => entry[1] === '[pdd-bridge:beacon]'), true);
    const beaconEntry = logs.find((entry) => entry[1] === '[pdd-bridge:beacon]');
    assert.equal(beaconEntry[2].name, 'bridge-js-loaded');
    assert.equal(beaconEntry[2].href, 'https://mms.pinduoduo.com/chat');
  } finally {
    await server.close();
  }
});

test('pdd bridge server can serve qn lite bridge by env flag', async () => {
  const originalMode = process.env.PDD_FUKE_QN_BRIDGE;
  process.env.PDD_FUKE_QN_BRIDGE = 'lite';
  const server = await startPddBridgeServer({ wsPort: 4567 });

  try {
    const qnScript = await new Promise((resolve, reject) => {
      http.get(server.qnUrl, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ statusCode: response.statusCode, contentType: response.headers['content-type'], body }));
      }).on('error', reject);
    });

    assert.equal(qnScript.statusCode, 200);
    assert.match(qnScript.contentType, /^application\/javascript/);
    assert.match(qnScript.body, /qn-bridge-lite/);
    assert.match(qnScript.body, /platform=qn&bridge=lite/);
    assert.match(qnScript.body, /NativeCall\('send_text_message'/);
    assert.match(qnScript.body, /im\.singlemsg\.onReceiveNewMsg/);
    assert.match(qnScript.body, /im\.singlemsg\.onMsgSendUpdate/);
  } finally {
    if (originalMode === undefined) delete process.env.PDD_FUKE_QN_BRIDGE;
    else process.env.PDD_FUKE_QN_BRIDGE = originalMode;
    await server.close();
  }
});

test('send message handler logs payload and send result diagnostics', async () => {
  const logs = [];
  const sentPayloads = [];
  const handler = createSendMessageHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sentPayloads.push({ targetId, message });
        return 2;
      }
    }),
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  const result = await handler(null, { targetId: 'buyer-1', text: 'hello' });

  assert.deepEqual(result, { sent: 2 });
  assert.equal(sentPayloads[0].targetId, 'buyer-1');
  assert.equal(sentPayloads[0].message.act, 'sendtext');
  assert.equal(sentPayloads[0].message.id, 'buyer-1');
  assert.equal(sentPayloads[0].message.text, 'hello');
  assert.equal(logs.some((entry) => entry[1] === '[chat:send-message]'), true);
  assert.equal(logs.some((entry) => entry[1] === '[chat:send-result]' && entry[2].sent === 2), true);
});

test('send message handler prefers PDD native socket bridge when available', async () => {
  const logs = [];
  const handler = createSendMessageHandler({
    getPddManager: () => ({
      async sendCurrentChatMessage(text) {
        return { ok: true, text, uid: 'buyer-1', csid: '125934914' };
      }
    }),
    getWsServer: () => {
      throw new Error('legacy websocket send should not run');
    },
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  const result = await handler(null, { targetId: 'buyer-1', text: 'hello native' });

  assert.deepEqual(result, {
    sent: true,
    native: true,
    result: { ok: true, text: 'hello native', uid: 'buyer-1', csid: '125934914' }
  });
  assert.equal(logs.some((entry) => entry[1] === '[chat:send-native-result]' && entry[2].ok === true), true);
});

test('pdd command handler sends bridge commands to matching target or broadcast', async () => {
  const logs = [];
  const sentPayloads = [];
  const handler = createPddCommandHandler({
    commandAct: 'getCurrentConv',
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sentPayloads.push({ targetId, message });
        return 1;
      }
    }),
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  const result = await handler(null, { conversationId: 'buyer-1', limit: 15 });

  assert.deepEqual(result, { sent: 1 });
  assert.deepEqual(sentPayloads[0], {
    targetId: 'buyer-1',
    message: {
      act: 'getCurrentConv',
      id: 'buyer-1',
      limit: 15
    }
  });
  assert.equal(logs.some((entry) => entry[1] === '[pdd:command]' && entry[2].act === 'getCurrentConv'), true);
});

test('pdd command handler forwards params payload for bridge order commands', async () => {
  const sentPayloads = [];
  const handler = createPddCommandHandler({
    commandAct: 'setOrderRemark',
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sentPayloads.push({ targetId, message });
        return 1;
      }
    }),
    logger: { log() {}, error() {} }
  });

  const result = await handler(null, {
    conversationId: 'buyer-2',
    params: {
      requestId: 'req-order-set',
      orderId: '240001',
      remark: '已电话联系',
      tagColor: 'RED'
    }
  });

  assert.deepEqual(result, { sent: 1 });
  assert.deepEqual(sentPayloads[0], {
    targetId: 'buyer-2',
    message: {
      act: 'setOrderRemark',
      id: 'buyer-2',
      params: {
        requestId: 'req-order-set',
        orderId: '240001',
        remark: '已电话联系',
        tagColor: 'RED'
      }
    }
  });
});

test('auto reply handler sends a test reply only for buyer text messages', async () => {
  const logs = [];
  const sent = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    replyText: '收到0806，自动回复测试',
    useTmagent: false,
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  await handler({
    message: {
      conversationId: 'buyer-1',
      direction: 'user',
      kind: 'text',
      content: { text: '0806' }
    }
  });
  await handler({
    message: {
      conversationId: 'buyer-1',
      direction: 'assistant',
      kind: 'text',
      content: { text: '客服消息' }
    }
  });
  await handler({
    message: {
      conversationId: 'buyer-1',
      direction: 'system',
      kind: 'unknown',
      content: {}
    }
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetId, 'buyer-1');
  assert.equal(sent[0].message.act, 'sendtext');
  assert.equal(sent[0].message.id, 'buyer-1');
  assert.equal(sent[0].message.text, '收到0806，自动回复测试');
  assert.equal(logs.some((entry) => entry[1] === '[auto-reply:sent]' && entry[2].sent === 1), true);
});

test('auto reply handler skips duplicate buyer messages by message id', async () => {
  const sent = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    replyText: '收到0806，自动回复测试',
    useTmagent: false,
    logger: { log() {}, error() {} }
  });
  const payload = {
    message: {
      id: 'msg-0806',
      conversationId: 'buyer-1',
      direction: 'user',
      kind: 'text',
      content: { text: '0806' }
    }
  };

  const first = await handler(payload);
  const second = await handler(payload);

  assert.equal(first.sent, 1);
  assert.deepEqual(second, { skipped: true, reason: 'duplicate' });
  assert.equal(sent.length, 1);
});

test('auto reply handler deduplicates concurrent duplicate buyer messages by message id', async () => {
  const sent = [];
  let releaseFetch;
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    tmagent: {
      baseUrl: 'http://tmagent.local',
      apiKey: 'sk-test',
      fetchImpl: async () => {
        await new Promise((resolve) => {
          releaseFetch = resolve;
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return { reply: '并发去重回复', action: null };
          }
        };
      }
    },
    logger: { log() {}, error() {} }
  });
  const payload = {
    message: {
      id: 'msg-race-1',
      conversationId: 'buyer-race',
      senderId: 'buyer-race',
      senderName: '买家',
      direction: 'user',
      kind: 'text',
      content: { text: '并发测试' }
    }
  };

  const firstPromise = handler(payload);
  const secondPromise = handler(payload);
  await new Promise((resolve) => setImmediate(resolve));
  releaseFetch();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.sent, 1);
  assert.deepEqual(second, { skipped: true, reason: 'duplicate-inflight' });
  assert.equal(sent.length, 1);
});

test('auto reply handler skips stale replayed messages', async () => {
  const sent = [];
  const logs = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    useTmagent: false,
    maxAutoReplyAgeMs: 1000,
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error() {}
    }
  });

  const result = await handler({
    message: {
      id: 'old-msg',
      conversationId: 'buyer-1',
      direction: 'user',
      kind: 'text',
      content: { text: 'old' },
      timestamp: Date.now() - 5000
    }
  });

  assert.deepEqual(result, { skipped: true, reason: 'stale-message' });
  assert.equal(sent.length, 0);
  assert.equal(logs.some((entry) => entry[1] === '[auto-reply:skip]' && entry[2].reason === 'stale-message'), true);
});

test('auto reply handler sends tmagent reply when API key is configured', async () => {
  const logs = [];
  const sent = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    tmagent: {
      baseUrl: 'http://tmagent.local',
      apiKey: 'sk-test',
      shopId: 'shop-001',
      shopName: '拼多多店铺',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { reply: '您好，我看一下。', action: null };
        }
      })
    },
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  const result = await handler({
    message: {
      id: 'msg-1',
      conversationId: 'buyer-1',
      senderName: '买家',
      direction: 'user',
      kind: 'text',
      content: { text: '什么时候发货？' }
    }
  });

  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.act, 'sendtext');
  assert.equal(sent[0].message.id, 'buyer-1');
  assert.equal(sent[0].message.text, '您好，我看一下。');
  assert.equal(logs.some((entry) => entry[1] === '[auto-reply:sent]' && entry[2].textSource === 'tmagent'), true);
});

test('auto reply handler treats bridge window error after sendtext as send failure', async () => {
  const { EventEmitter } = require('node:events');
  const sent = [];
  const logs = [];
  const server = new EventEmitter();
  server.sendToTarget = (targetId, message) => {
    sent.push({ targetId, message });
    setTimeout(() => {
      server.emit('bridge-diagnostic', {
        client: { id: 'client-1', platform: 'publicplatform', targetId },
        diagnostic: {
          name: 'window-error',
          payload: {
            message: 'Uncaught TypeError: m is not a function',
            filename: 'https://mms.pinduoduo.com/common.js'
          },
          time: Date.now()
        }
      });
    }, 0);
    return 1;
  };

  const handler = createAutoReplyHandler({
    getWsServer: () => server,
    tmagent: {
      baseUrl: 'http://tmagent.local',
      apiKey: 'sk-test',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { reply: '您好，我看一下。', action: null };
        }
      })
    },
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  const result = await handler({
    client: { id: 'client-1', platform: 'publicplatform', shopId: '174006696' },
    message: {
      id: 'msg-send-fail-1',
      conversationId: 'buyer-1',
      senderId: 'buyer-1',
      senderName: '买家',
      direction: 'user',
      kind: 'text',
      content: { text: '什么时候发货？' }
    }
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(result, {
    skipped: true,
    reason: 'send-failed',
    error: 'Uncaught TypeError: m is not a function'
  });
  assert.equal(logs.some((entry) => entry[1] === '[auto-reply:send-failed]' && entry[2].targetId === 'buyer-1'), true);
});

test('auto reply handler opens qn conversation before sending text', async () => {
  const sent = [];
  const logs = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    replyText: '收到，稍等一下',
    useTmagent: false,
    qnSwitchDelayMs: 0,
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  const result = await handler({
    client: { platform: 'qn' },
    message: {
      id: 'qn-msg-1',
      conversationId: '2222657198225.1-1723106647.1#11001@cntaobao',
      senderName: 'tb087884122396',
      direction: 'user',
      kind: 'text',
      content: { text: '在吗' }
    }
  });

  assert.equal(result.sent, 1);
  assert.equal(result.switchSent, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].message, {
    act: 'switchConversation',
    id: '2222657198225.1-1723106647.1#11001@cntaobao',
    customerName: 'tb087884122396'
  });
  assert.deepEqual(sent[1].message, {
    act: 'sendMsg',
    param: {
      userid: 'tb087884122396',
      ccode: '2222657198225.1-1723106647.1#11001@cntaobao',
      msg: '收到，稍等一下'
    }
  });
  assert.equal(logs.some((entry) => entry[1] === '[auto-reply:qn-switch]' && entry[2].sent === 1), true);
});

test('auto reply handler uses bundled tmagent key by default', async () => {
  const sent = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    tmagent: {
      baseUrl: 'http://tmagent.local',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { reply: 'AI reply', action: null };
        }
      })
    },
    logger: { log() {}, error() {} }
  });

  const result = await handler({
    message: {
      id: 'msg-default-key',
      conversationId: 'buyer-1',
      direction: 'user',
      kind: 'text',
      content: { text: 'hi' }
    }
  });

  assert.equal(result.sent, 1);
  assert.equal(sent[0].message.text, 'AI reply');
});

test('auto reply handler uses saved ai settings when explicit tmagent config is absent', async () => {
  const sent = [];
  const calls = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    getAiSettings: () => ({
      enabled: true,
      baseUrl: 'http://tenant.tmagent.local',
      merchantName: '疾风ai客服',
      tenantId: '9901d2b1-6abc-41d7-a41e-91501b794735',
      apiKey: 'sk-tenant'
    }),
    tmagent: {
      fetchImpl: async (url, options) => {
        calls.push({ url, options: JSON.parse(options.body), headers: options.headers });
        return {
          ok: true,
          status: 200,
          async json() {
            return { reply: '租户回复', action: null };
          }
        };
      }
    },
    logger: { log() {}, error() {} }
  });

  const result = await handler({
    message: {
      id: 'msg-tenant',
      conversationId: 'buyer-tenant',
      senderName: '买家',
      direction: 'user',
      kind: 'text',
      content: { text: '什么时候发货？' }
    }
  });

  assert.equal(result.sent, 1);
  assert.equal(sent[0].message.text, '租户回复');
  assert.equal(calls[0].url, 'http://tenant.tmagent.local/api/orchestrate/chat');
  assert.equal(calls[0].headers['X-API-Key'], 'sk-tenant');
  assert.equal(calls[0].options.shop_id, '9901d2b1-6abc-41d7-a41e-91501b794735');
  assert.equal(calls[0].options.shop_name, '疾风ai客服');
});

test('auto reply handler does not send a message when tmagent requests human takeover', async () => {
  const sent = [];
  const logs = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    tmagent: {
      baseUrl: 'http://tmagent.local',
      apiKey: 'sk-test',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            reply: '',
            action: 'human_takeover',
            handoff: { reason: '用户要求人工客服' }
          };
        }
      })
    },
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  const result = await handler({
    message: {
      id: 'msg-human',
      conversationId: 'buyer-1',
      direction: 'user',
      kind: 'text',
      content: { text: '人工客服' }
    }
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'human-takeover');
  assert.equal(sent.length, 0);
  assert.equal(logs.some((entry) => entry[1] === '[auto-reply:tmagent-request]' && entry[2].apiKey === 'sk***t'), true);
  assert.equal(logs.some((entry) => entry[1] === '[auto-reply:handoff]' && entry[2].targetId === 'buyer-1'), true);
});

test('auto reply handler mutes the conversation after human takeover', async () => {
  const sent = [];
  const logs = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    tmagent: {
      baseUrl: 'http://tmagent.local',
      apiKey: 'sk-test',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            reply: '',
            action: 'human_takeover',
            handoff: { reason: '用户要求人工客服' }
          };
        }
      })
    },
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  const first = await handler({
    message: {
      id: 'msg-human-1',
      conversationId: 'buyer-1',
      direction: 'user',
      kind: 'text',
      content: { text: '人工客服' }
    }
  });
  const second = await handler({
    message: {
      id: 'msg-human-2',
      conversationId: 'buyer-1',
      direction: 'user',
      kind: 'text',
      content: { text: '还在吗' }
    }
  });

  assert.equal(first.reason, 'human-takeover');
  assert.deepEqual(second, { skipped: true, reason: 'human-takeover-muted' });
  assert.equal(sent.length, 0);
  assert.equal(logs.some((entry) => entry[1] === '[auto-reply:skip]' && entry[2].reason === 'human-takeover-muted'), true);
});

test('auto reply handler can resume a handed-off conversation through shared handoff store', async () => {
  const sent = [];
  const store = createConversationHandoffStore();
  let fetchCount = 0;
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    handoffStore: store,
    maxAutoReplyAgeMs: 0,
    tmagent: {
      baseUrl: 'http://tmagent.local',
      apiKey: 'sk-test',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          fetchCount += 1;
          if (fetchCount === 1) {
            return {
              reply: '',
              action: 'human_takeover',
              handoff: { reason: '客户要求人工' }
            };
          }
          return { reply: '恢复自动接待', action: null };
        }
      })
    },
    logger: { log() {}, error() {} }
  });

  const first = await handler({
    client: { platform: 'pdd' },
    message: {
      id: 'msg-human-1',
      conversationId: 'buyer-1',
      senderName: '买家甲',
      direction: 'user',
      kind: 'text',
      content: { text: '转人工' },
      timestamp: 1719200000000
    }
  });
  const muted = await handler({
    client: { platform: 'pdd' },
    message: {
      id: 'msg-human-2',
      conversationId: 'buyer-1',
      senderName: '买家甲',
      direction: 'user',
      kind: 'text',
      content: { text: '还在吗' },
      timestamp: 1719200060000
    }
  });

  assert.equal(first.reason, 'human-takeover');
  assert.equal(store.isMuted('buyer-1'), true);
  assert.match(store.snapshot().manual[0].customerName, /买家甲/);
  assert.equal(store.snapshot().manual[0].pendingSince, 1719200000000);
  assert.deepEqual(muted, { skipped: true, reason: 'human-takeover-muted' });

  store.resumeConversation('buyer-1');

  const resumed = await handler({
    client: { platform: 'pdd' },
    message: {
      id: 'msg-human-3',
      conversationId: 'buyer-1',
      senderName: '买家甲',
      direction: 'user',
      kind: 'text',
      content: { text: '可以继续吗' },
      timestamp: 1719200120000
    }
  });

  assert.equal(store.isMuted('buyer-1'), false);
  assert.equal(resumed.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.text, '恢复自动接待');
});

test('auto reply handler sends reply then requests PDD transfer when tmagent asks for transfer_conversation_2', async () => {
  const sent = [];
  const logs = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    tmagent: {
      baseUrl: 'http://tmagent.local',
      apiKey: 'sk-test',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            reply: '亲，您这个问题我给您转更专业的客服，马上就来',
            action: 'transfer_conversation_2',
            handoff: { scope: 'shop', reason: '客户要求人工' }
          };
        }
      })
    },
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  const result = await handler({
    client: { platform: 'publicplatform' },
    message: {
      id: 'msg-transfer',
      conversationId: 'buyer-1',
      direction: 'user',
      kind: 'text',
      content: { text: '转人工' }
    }
  });

  assert.equal(result.sent, 1);
  assert.equal(result.transferSent, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], {
    targetId: 'buyer-1',
    message: {
      act: 'sendtext',
      id: 'buyer-1',
      text: '亲，您这个问题我给您转更专业的客服，马上就来'
    }
  });
  assert.deepEqual(sent[1], {
    targetId: 'buyer-1',
    message: {
      act: 'transferConversation',
      id: 'buyer-1',
      transferType: 'transfer_conversation_2',
      reason: '客户要求人工',
      scope: 'shop'
    }
  });
  assert.equal(logs.some((entry) => entry[1] === '[auto-reply:transfer]' && entry[2].targetId === 'buyer-1'), true);
});

test('auto reply handler mutes the conversation after transfer_conversation_2 request', async () => {
  const sent = [];
  const logs = [];
  const handler = createAutoReplyHandler({
    getWsServer: () => ({
      sendToTarget(targetId, message) {
        sent.push({ targetId, message });
        return 1;
      }
    }),
    tmagent: {
      baseUrl: 'http://tmagent.local',
      apiKey: 'sk-test',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            reply: '亲，马上给您转接',
            action: 'transfer_conversation_2',
            handoff: { scope: 'shop', reason: '客户要求人工' }
          };
        }
      })
    },
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  const first = await handler({
    client: { platform: 'publicplatform' },
    message: {
      id: 'msg-transfer-1',
      conversationId: 'buyer-1',
      direction: 'user',
      kind: 'text',
      content: { text: '转人工' }
    }
  });
  const second = await handler({
    client: { platform: 'publicplatform' },
    message: {
      id: 'msg-transfer-2',
      conversationId: 'buyer-1',
      direction: 'user',
      kind: 'text',
      content: { text: '还在吗' }
    }
  });

  assert.equal(first.transferSent, 1);
  assert.deepEqual(second, { skipped: true, reason: 'human-takeover-muted' });
  assert.equal(sent.length, 2);
  assert.equal(logs.some((entry) => entry[1] === '[auto-reply:skip]' && entry[2].reason === 'human-takeover-muted'), true);
});

test('wbchat change handler reads chat DOM snapshots only for message WAL changes', async () => {
  const sent = [];
  const logs = [];
  const manager = {
    async readCurrentChatDom() {
      return {
        href: 'https://mms.pinduoduo.com/win-plugin/web/web_19.5.0/view/middle_panel/index.html',
        title: '鑱婂ぉ璇︽儏',
        messages: [{ text: '涔板娑堟伅', className: 'msg-li' }]
      };
    }
  };
  const handler = createWbChatChangeHandler({
    getPddManager: () => manager,
    send: (channel, payload) => sent.push([channel, payload]),
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });

  await handler({ sourceId: 'source-1', name: 'session.db-wal', size: 10, mtime: 1 });
  await handler({ sourceId: 'source-1', name: 'message.db-wal', size: 20, mtime: 2 });

  assert.deepEqual(sent.map((entry) => entry[0]), [
    'wbchat:file-change',
    'wbchat:file-change',
    'pdd:dom-chat'
  ]);
  assert.equal(sent[2][1].chat.messages[0].text, '涔板娑堟伅');
  assert.equal(logs.some((entry) => entry[1] === '[pdd:dom-chat]'), true);
});

test('renderer launch click displays launch failure in PDD status text', async () => {
  const listeners = new Map();
  const pddStateText = { textContent: 'Not detected' };
  const pddState = {
    lastChild: pddStateText,
    querySelector() {
      return { classList: { toggle() {} } };
    }
  };
  const launchPdd = {
    disabled: false,
    addEventListener(eventName, listener) {
      listeners.set(eventName, listener);
    }
  };

  const document = {
    getElementById(id) {
      if (id === 'pddState') return pddState;
      if (id === 'launchPdd') return launchPdd;
      return {
        addEventListener() {},
        replaceChildren() {},
        querySelector() {
          return { classList: { toggle() {} } };
        }
      };
    },
    createElement() {
      return {
        append() {},
        addEventListener() {},
        classList: { toggle() {} }
      };
    }
  };
  const context = {
    console: { error() {} },
    document,
    window: {
      pddFuke: {
        launchPdd: async () => {
          throw new Error('PDD launch failed');
        },
        sendMessage: async () => ({}),
        onServerStatus() {},
        onPddStatus() {},
        onPddError() {},
        onClientConnected() {},
        onClientDisconnected() {},
        onMessage() {},
        getStatus: async () => ({ server: null, pdd: null })
      }
    },
    Map,
    Date,
    String,
    Boolean,
    Array
  };

  const script = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  vm.runInNewContext(script, context);

  await listeners.get('click')();

  assert.equal(pddStateText.textContent, 'PDD launch failed');
  assert.equal(launchPdd.disabled, false);
});

test('renderer bridge diagnostic event shows response sample in diagnostics', async () => {
  const listeners = new Map();
  const lastBridgeProbe = { textContent: 'None' };
  const diagnosticEvents = {
    items: [],
    replaceChildren(...items) {
      this.items = items;
    }
  };

  const document = {
    getElementById(id) {
      if (id === 'lastBridgeProbe') return lastBridgeProbe;
      if (id === 'diagnosticEvents') return diagnosticEvents;
      if (id === 'pddState') {
        return {
          lastChild: { textContent: 'Not detected' },
          querySelector() {
            return { classList: { toggle() {} } };
          }
        };
      }
      return {
        addEventListener() {},
        replaceChildren() {},
        querySelector() {
          return { classList: { toggle() {} } };
        }
      };
    },
    createElement() {
      return {
        className: '',
        textContent: '',
        append() {},
        addEventListener() {},
        classList: { toggle() {} }
      };
    }
  };
  const context = {
    console: { error() {} },
    document,
    window: {
      pddFuke: {
        launchPdd: async () => ({}),
        sendMessage: async () => ({}),
        onServerStatus() {},
        onPddStatus() {},
        onPddError() {},
        onBridgeStatus() {},
        onBridgeDiagnostic(callback) {
          listeners.set('bridge-diagnostic', callback);
        },
        onCdpStatus() {},
        onClientConnected() {},
        onClientDisconnected() {},
        onProtocolMessage() {},
        onRawMessage() {},
        onWsError() {},
        onMessage() {},
        getStatus: async () => ({ server: null, pdd: null })
      }
    },
    Map,
    Date,
    String,
    Boolean,
    Array,
    JSON
  };

  const script = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  vm.runInNewContext(script, context);

  listeners.get('bridge-diagnostic')({
    diagnostic: {
      name: 'fetch-response',
      time: 123,
      payload: {
        url: 'https://example.test/api',
        status: 200,
        sample: '{"msgId":"m1","content":"hello buyer"}'
      }
    }
  });

  assert.match(lastBridgeProbe.textContent, /fetch-response/);
  assert.match(diagnosticEvents.items[0].textContent, /msgId/);
  assert.match(diagnosticEvents.items[0].textContent, /hello buyer/);
});

test('renderer DOM chat event shows latest chat message in diagnostics', async () => {
  const listeners = new Map();
  const lastDomChat = { textContent: 'None' };
  const diagnosticEvents = {
    items: [],
    replaceChildren(...items) {
      this.items = items;
    }
  };

  const document = {
    getElementById(id) {
      if (id === 'lastDomChat') return lastDomChat;
      if (id === 'diagnosticEvents') return diagnosticEvents;
      if (id === 'pddState') {
        return {
          lastChild: { textContent: 'Not detected' },
          querySelector() {
            return { classList: { toggle() {} } };
          }
        };
      }
      return {
        addEventListener() {},
        replaceChildren() {},
        querySelector() {
          return { classList: { toggle() {} } };
        }
      };
    },
    createElement() {
      return {
        className: '',
        textContent: '',
        append() {},
        addEventListener() {},
        classList: { toggle() {} }
      };
    }
  };
  const context = {
    console: { error() {} },
    document,
    window: {
      pddFuke: {
        launchPdd: async () => ({}),
        sendMessage: async () => ({}),
        onServerStatus() {},
        onPddStatus() {},
        onPddError() {},
        onBridgeStatus() {},
        onBridgeDiagnostic() {},
        onCdpStatus() {},
        onClientConnected() {},
        onClientDisconnected() {},
        onProtocolMessage() {},
        onRawMessage() {},
        onWsError() {},
        onWbChatFileChange() {},
        onDomChat(callback) {
          listeners.set('dom-chat', callback);
        },
        onMessage() {},
        getStatus: async () => ({ server: null, pdd: null })
      }
    },
    Map,
    Date,
    String,
    Boolean,
    Array,
    JSON
  };

  const script = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  vm.runInNewContext(script, context);

  listeners.get('dom-chat')({
    time: 123,
    chat: {
      title: '聊天详情',
      messages: [
        { text: '旧消息', className: 'msg-li' },
        { text: '新的买家消息', className: 'msg-li' }
      ]
    }
  });

  assert.match(lastDomChat.textContent, /新的买家消息/);
  assert.match(diagnosticEvents.items[0].textContent, /dom chat/);
});

test('renderer workspace opens product library window and switches to AI settings tab', async () => {
  const listeners = new Map();
  const calls = [];

  function createClassList(owner) {
    return {
      toggle(name, force) {
        const classes = new Set(String(owner.className || '').split(/\s+/).filter(Boolean));
        const shouldHave = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldHave) classes.add(name);
        else classes.delete(name);
        owner.className = Array.from(classes).join(' ');
      }
    };
  }

  function createNode(initial = {}) {
    const node = {
      className: initial.className || '',
      textContent: initial.textContent || '',
      value: initial.value || '',
      checked: Boolean(initial.checked),
      disabled: false,
      children: [],
      dataset: initial.dataset || {},
      replaceChildren(...items) {
        this.children = items;
      },
      append(...items) {
        this.children.push(...items);
      },
      addEventListener(eventName, listener) {
        listeners.set(this, listeners.get(this) || new Map());
        listeners.get(this).set(eventName, listener);
      },
      querySelector() {
        return null;
      }
    };
    node.classList = createClassList(node);
    return node;
  }

  const tabSessionTools = createNode({ className: 'workspace-tab active' });
  const tabAiSettings = createNode({ className: 'workspace-tab' });
  const tabQuickReplies = createNode({ className: 'workspace-tab' });
  const tabWorkspaceLogs = createNode({ className: 'workspace-tab' });
  const productLibraryPane = createNode({ className: 'workspace-pane' });
  const sessionToolsPane = createNode({ className: 'workspace-pane' });
  const aiSettingsPane = createNode({ className: 'workspace-pane' });
  const quickRepliesPane = createNode({ className: 'workspace-pane' });
  const toolsDrawer = createNode({ className: 'tools-drawer' });
  const toggleToolsPanel = createNode();
  const workspaceLogList = createNode();
  const workspaceLogsPane = createNode({ className: 'workspace-pane' });
  workspaceLogsPane.querySelector = (selector) => (selector === '.workspace-log-list' ? workspaceLogList : null);
  const productLibrarySummary = createNode();
  const productLibraryGrid = createNode();
  const productLibraryPagination = createNode();
  const productDetailPanel = createNode();
  const productDrawerTitle = createNode();
  const productScopePlatformSelect = createNode({ value: 'pdd' });
  const productScopeShopIdInput = createNode();
  const productScopeShopNameInput = createNode();
  const productStatusFilterSelect = createNode({ value: 'active' });
  const productSortBySelect = createNode({ value: 'updated_at' });
  const productSortOrderSelect = createNode({ value: 'desc' });
  const productImportModal = createNode({ className: 'product-import-modal' });
  const productImportTextarea = createNode();
  const productImportResult = createNode();
  const productIdInput = createNode();
  const productNameInput = createNode();
  const productCategoryInput = createNode();
  const productPriceInput = createNode();
  const productStockInput = createNode();
  const productImageUrlInput = createNode();
  const productStatusSelect = createNode({ value: 'active' });
  const productSourceSelect = createNode({ value: 'manual' });
  const productAttributesEditor = createNode();
  const productSyncStatusDisplay = createNode();
  const productSyncErrorDisplay = createNode();
  const productLastSyncAtDisplay = createNode();
  const platformChipAll = createNode({ className: 'platform-filter-chip active', dataset: { platformFilter: 'all' } });
  const platformChipPdd = createNode({ className: 'platform-filter-chip', dataset: { platformFilter: 'pdd' } });
  const nodes = {
    pddState: {
      lastChild: { textContent: 'Not detected' },
      querySelector() {
        return { classList: { toggle() {} } };
      }
    },
    qnState: {
      lastChild: { textContent: 'QN not detected' },
      querySelector() {
        return { classList: { toggle() {} } };
      }
    },
    serverStatus: createNode(),
    productLibrarySummary,
    productLibraryGrid,
    productLibraryPagination,
    productDetailPanel,
    productDrawerTitle,
    tabSessionTools,
    tabAiSettings,
    tabQuickReplies,
    tabWorkspaceLogs,
    toolsDrawer,
    toggleToolsPanel,
    productLibraryPane,
    sessionToolsPane,
    aiSettingsPane,
    quickRepliesPane,
    workspaceLogsPane,
    shopSearchInput: createNode(),
    goodsSearchInput: createNode(),
    productScopePlatformSelect,
    productScopeShopIdInput,
    productScopeShopNameInput,
    agentFilterSelect: createNode({ value: 'all' }),
    productScopeSelect: createNode({ value: 'all' }),
    productStatusFilterSelect,
    productSortBySelect,
    productSortOrderSelect,
    productSearchButton: createNode(),
    refreshProductsButton: createNode(),
    fetchProductsButton: createNode(),
    taskProgressButton: createNode(),
    selectAllProductsButton: createNode(),
    batchDeleteButton: createNode(),
    batchLearnButton: createNode(),
    productImportModal,
    productImportTextarea,
    productImportResult,
    productIdInput,
    productNameInput,
    productCategoryInput,
    productPriceInput,
    productStockInput,
    productImageUrlInput,
    productStatusSelect,
    productSourceSelect,
    productAttributesEditor,
    productSyncStatusDisplay,
    productSyncErrorDisplay,
    productLastSyncAtDisplay,
    closeProductImportButton: createNode(),
    runProductImportButton: createNode(),
    loadProductsButton: createNode(),
    addProductButton: createNode(),
    saveProductButton: createNode(),
    resetProductButton: createNode(),
    deleteProductButton: createNode(),
    rebuildProductSearchButton: createNode(),
    addAttributeRowButton: createNode(),
    loadCurrentCsrButton: createNode(),
    loadCurrentConvButton: createNode(),
    loadRemoteHistoryButton: createNode(),
    currentCsrDisplay: createNode(),
    currentConvDisplay: createNode(),
    sessionCcodeInput: createNode(),
    remoteHistoryLimitInput: createNode({ value: '20' }),
    remoteHistoryResult: createNode(),
    orderIdInput: createNode(),
    orderConversationInput: createNode(),
    queryOrderRemarkButton: createNode(),
    saveOrderRemarkButton: createNode(),
    sendOrderMessageButton: createNode(),
    orderRemarkInput: createNode(),
    orderTagColorSelect: createNode({ value: 'RED' }),
    orderTagNameInput: createNode(),
    orderMessageInput: createNode(),
    orderToolResult: createNode(),
    tmagentEnabledInput: createNode(),
    tmagentBaseUrlInput: createNode(),
    tmagentMerchantNameInput: createNode(),
    tmagentTenantIdInput: createNode(),
    tmagentApiKeyInput: createNode(),
    tmagentHeaderPreview: createNode(),
    tmagentShopIdPreview: createNode(),
    tmagentShopNamePreview: createNode(),
    tmagentEndpointPreview: createNode(),
    tmagentPayloadPreview: createNode(),
    testReplyInput: createNode(),
    testReplyOutput: createNode(),
    runTestReplyButton: createNode(),
    saveAiSettingsButton: createNode(),
    messages: createNode(),
    conversationList: createNode(),
    chatTitle: createNode(),
    chatSubtitle: createNode(),
    messageInput: createNode(),
    sendButton: createNode(),
    composer: createNode(),
    clientCount: createNode(),
    clientDetails: createNode(),
    pendingCount: createNode(),
    todayReception: createNode(),
    diagnosticEvents: createNode(),
    bridgeStatus: createNode(),
    cdpStatus: createNode(),
    lastRawMessage: createNode(),
    lastParsedMessage: createNode(),
    unparsedCount: createNode(),
    lastSendResult: createNode(),
    lastBridgeProbe: createNode(),
    bridgeHttpStatus: createNode(),
    bridgeWsStatus: createNode(),
    bridgeReadyStatus: createNode(),
    transferTraceStatus: createNode(),
    lastWbChatFile: createNode(),
    lastDomChat: createNode(),
    tmagentEnabledSummary: createNode(),
    tmagentBaseUrlSummary: createNode(),
    tmagentMerchantNameSummary: createNode(),
    tmagentTenantIdSummary: createNode(),
    tmagentApiKeySummary: createNode(),
    helperProcessSummary: createNode(),
    workbenchProcessSummary: createNode(),
    lastSendReceiptSummary: createNode(),
    sendReceiptList: createNode(),
    refreshDiagnostics: createNode(),
    copyDiagnostics: createNode(),
    diagnosticSnapshotTime: createNode(),
    platformList: createNode()
  };

  const document = {
    getElementById(id) {
      return nodes[id] || createNode();
    },
    querySelectorAll(selector) {
      if (selector === '.platform-filter-chip') return [platformChipAll, platformChipPdd];
      return [];
    },
    createElement() {
      return createNode();
    }
  };

  const context = {
    console: { error() {} },
    document,
    fetch: async (url, options = {}) => {
      calls.push(['fetch', url, options]);
      throw new Error(`unexpected fetch ${url}`);
    },
    window: {
      pddFuke: {
        getCurrentPddCsr: async () => {
          calls.push(['getCurrentPddCsr']);
          return { sent: 1 };
        },
        getCurrentPddConv: async (payload) => {
          calls.push(['getCurrentPddConv', payload]);
          return payload;
        },
        getPddRemoteHistory: async (payload) => {
          calls.push(['getPddRemoteHistory', payload]);
          return payload;
        },
        queryPddOrderRemark: async (payload) => {
          calls.push(['queryPddOrderRemark', payload]);
          return payload;
        },
        setPddOrderRemark: async (payload) => {
          calls.push(['setPddOrderRemark', payload]);
          return payload;
        },
        sendPddOrderMessage: async (payload) => {
          calls.push(['sendPddOrderMessage', payload]);
          return payload;
        },
        getStatus: async () => ({ server: null, pdd: null, qn: null }),
        getAiSettings: async () => ({
          enabled: true,
          baseUrl: 'http://xingqiao.taluo.club',
          merchantName: '疾风ai客服',
          tenantId: '9901d2b1-6abc-41d7-a41e-91501b794735',
          apiKey: 'sk-test'
        }),
        saveAiSettings: async (payload) => payload,
        getDiagnosticsSnapshot: async () => ({ time: 123, summary: {}, sendReceipts: [] }),
        launchPdd: async () => ({}),
        launchQn: async () => ({}),
        sendMessage: async () => ({}),
        onServerStatus() {},
        onPddStatus() {},
        onPddError() {},
        onQnStatus() {},
        onQnError() {},
        onBridgeStatus() {},
        onBridgeHealth(callback) {
          listeners.set('bridge-health', callback);
        },
        onBridgeDiagnostic() {},
        onCdpStatus() {},
        onClientConnected() {},
        onClientDisconnected() {},
        onProtocolMessage(callback) {
          listeners.set('protocol-message', callback);
        },
        onRawMessage() {},
        onWsError() {},
        onWbChatFileChange() {},
        onDomChat() {},
        onDomChatError() {},
        onMessage() {}
      }
    },
    Map,
    Set,
    Date,
    Promise,
    String,
    Boolean,
    Array,
    JSON,
    URLSearchParams,
    TextDecoder
  };

  const script = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.doesNotMatch(toolsDrawer.className, /\bactive\b/);

  await listeners.get(toggleToolsPanel).get('click')();

  assert.match(toolsDrawer.className, /\bactive\b/);

  await listeners.get(tabSessionTools).get('click')();

  assert.match(tabSessionTools.className, /\bactive\b/);
  assert.match(sessionToolsPane.className, /\bactive\b/);
  assert.match(productLibraryPane.className, /\bactive\b/);

  nodes.sessionCcodeInput.value = 'buyer-2';
  nodes.orderIdInput.value = '240001';
  nodes.orderRemarkInput.value = '已电话联系';
  nodes.orderTagColorSelect.value = 'RED';
  nodes.orderTagNameInput.value = '红色';
  nodes.orderMessageInput.value = '请核对订单信息';

  await listeners.get(nodes.loadCurrentCsrButton).get('click')();
  await listeners.get(nodes.loadCurrentConvButton).get('click')();
  await listeners.get(nodes.loadRemoteHistoryButton).get('click')();
  await listeners.get(nodes.queryOrderRemarkButton).get('click')();
  await listeners.get(nodes.saveOrderRemarkButton).get('click')();
  await listeners.get(nodes.sendOrderMessageButton).get('click')();

  listeners.get('protocol-message')({
    protocol: {
      type: 'currentcsr',
      payload: { nick: '正版桌游店:主账号', targetId: 'cs-1' }
    }
  });
  listeners.get('protocol-message')({
    protocol: {
      type: 'currentconv',
      payload: { nick: '买家一', ccode: 'buyer-2' }
    }
  });
  listeners.get('protocol-message')({
    protocol: {
      type: 'remote_his_message',
      payload: { ccode: 'buyer-2' },
      raw: { msg: [{ msgId: 'm1', content: '历史消息' }] }
    }
  });
  listeners.get('protocol-message')({
    protocol: {
      type: 'queryorderremarkresult',
      requestId: 'query-order-remark-1',
      payload: { success: true, result: { remark: '已备注', tagColor: 'BLUE', tagName: '蓝色' } }
    }
  });

  assert.match(nodes.currentCsrDisplay.value, /正版桌游店:主账号/);
  assert.match(nodes.currentConvDisplay.value, /买家一/);
  assert.match(nodes.remoteHistoryResult.textContent, /历史消息/);
  const getCurrentCsrCall = calls.find((entry) => entry[0] === 'getCurrentPddCsr');
  const getCurrentConvCall = calls.find((entry) => entry[0] === 'getCurrentPddConv');
  const getRemoteHistoryCall = calls.find((entry) => entry[0] === 'getPddRemoteHistory');
  const queryOrderRemarkCall = calls.find((entry) => entry[0] === 'queryPddOrderRemark');
  const saveOrderRemarkCall = calls.find((entry) => entry[0] === 'setPddOrderRemark');
  const sendOrderMessageCall = calls.find((entry) => entry[0] === 'sendPddOrderMessage');
  assert.equal(Boolean(getCurrentCsrCall), true);
  assert.equal(getCurrentConvCall[1].conversationId, 'buyer-2');
  assert.equal(getRemoteHistoryCall[1].conversationId, 'buyer-2');
  assert.equal(getRemoteHistoryCall[1].limit, 20);
  assert.equal(queryOrderRemarkCall[1].params.orderId, '240001');
  assert.equal(saveOrderRemarkCall[1].params.remark, '已电话联系');
  assert.equal(sendOrderMessageCall[1].params.text, '请核对订单信息');

  await listeners.get(tabAiSettings).get('click')();

  assert.match(tabAiSettings.className, /\bactive\b/);
  assert.match(aiSettingsPane.className, /\bactive\b/);
  assert.match(productLibraryPane.className, /\bactive\b/);
  assert.equal(nodes.tmagentEnabledSummary.textContent, '已启用');
  assert.equal(nodes.tmagentBaseUrlSummary.textContent, 'http://xingqiao.taluo.club');
  assert.equal(nodes.tmagentMerchantNameSummary.textContent, '疾风ai客服');
  assert.equal(nodes.tmagentTenantIdSummary.textContent, '9901d2b1-6abc-41d7-a41e-91501b794735');
  assert.equal(nodes.tmagentApiKeySummary.textContent, 'sk***st');
  assert.doesNotMatch(nodes.tmagentApiKeySummary.textContent, /^sk-test$/);

  listeners.get('bridge-health')({
    httpStarted: true,
    bridgeUrl: 'http://127.0.0.1:65495/pdd-bridge.js',
    wsConnected: true,
    pageReady: true,
    pageReadyAt: 1719200000000,
    activeTraceId: 'transfer-1719200000000'
  });

  assert.equal(nodes.bridgeHttpStatus.textContent, 'http://127.0.0.1:65495/pdd-bridge.js');
  assert.equal(nodes.bridgeWsStatus.textContent, 'Connected');
  assert.match(nodes.bridgeReadyStatus.textContent, /Ready/);
  assert.equal(nodes.transferTraceStatus.textContent, 'transfer-1719200000000');
});

test('floating renderer shows manual handoff tab, badge count, wait timer, and actions', async () => {
  const listeners = new Map();
  const calls = [];

  function createClassList(owner) {
    return {
      toggle(name, force) {
        const classes = new Set(String(owner.className || '').split(/\s+/).filter(Boolean));
        const shouldHave = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldHave) classes.add(name);
        else classes.delete(name);
        owner.className = Array.from(classes).join(' ');
      },
      contains(name) {
        return new Set(String(owner.className || '').split(/\s+/).filter(Boolean)).has(name);
      }
    };
  }

  function createNode(initial = {}) {
    const node = {
      className: initial.className || '',
      textContent: initial.textContent || '',
      innerHTML: initial.innerHTML || '',
      disabled: false,
      children: [],
      dataset: initial.dataset || {},
      replaceChildren(...items) {
        this.children = items;
      },
      append(...items) {
        this.children.push(...items);
      },
      addEventListener(eventName, listener) {
        listeners.set(this, listeners.get(this) || new Map());
        listeners.get(this).set(eventName, listener);
      },
      querySelector() {
        return null;
      }
    };
    node.classList = createClassList(node);
    return node;
  }

  const nodes = {
    pluginConnectionDot: createNode(),
    pluginConnection: createNode(),
    pluginCdp: createNode(),
    pluginPlatform: createNode(),
    pluginPending: createNode(),
    pluginToday: createNode(),
    pluginSent: createNode(),
    pluginMessages: createNode(),
    pluginLastTime: createNode(),
    pluginClients: createNode(),
    pluginEvents: createNode(),
    pluginClose: createNode(),
    pluginMinimize: createNode(),
    pluginAutoReply: createNode(),
    pluginModeHint: createNode(),
    pluginSelection: createNode(),
    pluginEmptyState: createNode(),
    pluginPendingAction: createNode(),
    pluginManualAction: createNode(),
    pluginTabPending: createNode(),
    pluginTabManual: createNode(),
    pluginManualBadge: createNode()
  };

  const document = {
    getElementById(id) {
      return nodes[id] || createNode();
    },
    createElement() {
      return createNode();
    }
  };

  const api = {
    closeFloating: async () => ({ hidden: true }),
    minimizeFloating: async () => ({ minimized: true }),
    focusConversation: async (payload) => {
      calls.push(['focusConversation', payload]);
      return { focused: true };
    },
    resumeConversation: async (payload) => {
      calls.push(['resumeConversation', payload]);
      return { resumed: true };
    },
    getAiSettings: async () => ({
      enabled: true,
      merchantName: '疾风 AI'
    }),
    getStatus: async () => ({
      pdd: { running: true, pid: 4321, cdpConnected: true },
      qn: { running: false },
      handoff: {
        manual: [
          {
            conversationId: 'buyer-2',
            customerName: '买家乙',
            platform: 'pdd',
            pendingSince: 1719190060000,
            lastBuyerAt: 1719190060000
          }
        ]
      }
    }),
    onPddStatus(callback) {
      listeners.set('pdd-status', callback);
    },
    onQnStatus(callback) {
      listeners.set('qn-status', callback);
    },
    onClientConnected(callback) {
      listeners.set('client-connected', callback);
    },
    onClientDisconnected(callback) {
      listeners.set('client-disconnected', callback);
    },
    onMessage(callback) {
      listeners.set('message', callback);
    },
    onBridgeDiagnostic(callback) {
      listeners.set('bridge-diagnostic', callback);
    },
    onCdpStatus(callback) {
      listeners.set('cdp-status', callback);
    },
    onWsError(callback) {
      listeners.set('ws-error', callback);
    },
    onPddError(callback) {
      listeners.set('pdd-error', callback);
    },
    onManualState(callback) {
      listeners.set('manual-state', callback);
    }
  };

  const context = {
    console: { error() {} },
    document,
    window: { pddFuke: api },
    Map,
    Set,
    Date,
    Promise,
    String,
    Boolean,
    Array,
    JSON
  };

  const script = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'floating.js'), 'utf8');
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  listeners.get('client-connected')({ id: 'pdd-1', platform: 'publicplatform' });
  listeners.get('message')({
    message: {
      conversationId: 'buyer-1',
      senderName: '买家甲',
      direction: 'user',
      kind: 'text',
      content: { text: '什么时候发货？' },
      timestamp: 1719190000000
    }
  });
  listeners.get('message')({
    message: {
      conversationId: 'buyer-2',
      senderName: '买家乙',
      direction: 'user',
      kind: 'text',
      content: { text: '给我转人工' },
      timestamp: 1719190060000
    }
  });
  listeners.get('message')({
    message: {
      conversationId: 'buyer-1',
      senderName: '客服',
      direction: 'assistant',
      kind: 'text',
      content: { text: '今天发出' },
      timestamp: 1719190120000
    }
  });

  assert.match(nodes.pluginPlatform.textContent, /拼多多/);
  assert.match(nodes.pluginConnection.textContent, /运行中/);
  assert.equal(nodes.pluginPending.textContent, '1');
  assert.equal(nodes.pluginSent.textContent, '1');
  assert.match(nodes.pluginAutoReply.textContent, /AI/);
  assert.match(nodes.pluginManualBadge.textContent, /1/);
  assert.match(nodes.pluginMessages.children[0].textContent, /买家乙/);
  assert.match(nodes.pluginSelection.textContent, /买家乙/);

  await listeners.get(nodes.pluginTabManual).get('click')();
  assert.match(nodes.pluginMessages.children[0].textContent, /待人工/);
  assert.match(nodes.pluginMessages.children[0].textContent, /等待/);

  await listeners.get(nodes.pluginMessages.children[0]).get('click')();
  assert.equal(calls[0][0], 'focusConversation');
  assert.equal(calls[0][1].conversationId, 'buyer-2');
  assert.equal(calls[0][1].customerName, '买家乙');
  assert.equal(calls[0][1].platform, 'pdd');

  await listeners.get(nodes.pluginManualAction).get('click')();
  assert.equal(calls[1][0], 'resumeConversation');
  assert.equal(calls[1][1].conversationId, 'buyer-2');
  assert.equal(calls[1][1].platform, 'pdd');
  assert.equal(nodes.pluginManualBadge.textContent, '0');

  listeners.get('message')({
    message: {
      conversationId: 'buyer-3',
      senderName: '买家丙',
      direction: 'user',
      kind: 'text',
      content: { text: '还有货吗' },
      timestamp: 1719190180000
    }
  });

  await listeners.get(nodes.pluginTabPending).get('click')();
  await listeners.get(nodes.pluginPendingAction).get('click')();

  assert.match(nodes.pluginSelection.textContent, /买家丙/);
  assert.match(nodes.pluginModeHint.textContent, /AI 托管中/);
  assert.match(nodes.pluginMessages.children[0].textContent, /待回复/);
});
