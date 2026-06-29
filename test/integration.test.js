const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const msgpack = require('@msgpack/msgpack');
const { InternalWebSocketServer } = require('../main/websocket');

function once(emitter, eventName) {
  return new Promise((resolve) => emitter.once(eventName, resolve));
}

function onceWithTimeout(emitter, eventName, timeoutMs = 250) {
  return Promise.race([
    once(emitter, eventName),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
    })
  ]);
}

function waitForSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (buffer) => {
      try {
        resolve(JSON.parse(buffer.toString()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function waitForMsgpackSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (buffer) => {
      try {
        resolve(msgpack.decode(new Uint8Array(buffer)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test('publicplatform websocket receives PDD messages and sends commands back to the DLL client', async () => {
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0 });

  try {
    const address = await server.start();
    const connected = once(server, 'client-connected');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/publicplatform`);
    const initialCommand = waitForSocketMessage(socket);

    await once(socket, 'open');
    const client = await connected;

    assert.equal(client.platform, 'publicplatform');
    assert.deepEqual(await initialCommand, { act: 'getCurrentCsr' });

    const textReceived = once(server, 'pdd-message');
    socket.send(JSON.stringify({
      type: 'message',
      act: 'push',
      param: {
        msgId: 'text-1',
        targetId: 'buyer-1',
        direction: 1,
        msgType: 0,
        content: 'hello from buyer'
      }
    }));

    const textPayload = await textReceived;
    assert.equal(textPayload.message.kind, 'text');
    assert.equal(textPayload.message.conversationId, 'buyer-1');
    assert.equal(textPayload.message.content.text, 'hello from buyer');

    const goodsReceived = once(server, 'pdd-message');
    socket.send(JSON.stringify({
      type: 'message',
      act: 'push',
      param: {
        msgId: 'goods-1',
        targetId: 'buyer-1',
        direction: 1,
        msgType: 4,
        content: {
          goodsId: '123',
          goodsName: 'Sample product',
          price: '19.90',
          url: 'https://mobile.yangkeduo.com/goods.html?goods_id=123',
          pic: 'https://example.test/p.png'
        }
      }
    }));

    const goodsPayload = await goodsReceived;
    assert.equal(goodsPayload.message.kind, 'goods');
    assert.equal(goodsPayload.message.content.goodsId, '123');
    assert.equal(goodsPayload.message.content.goodsName, 'Sample product');

    const commandReceived = waitForSocketMessage(socket);
    const sent = server.sendToTarget('buyer-1', {
      type: 'message',
      act: 'send',
      param: {
        targetId: 'buyer-1',
        content: 'reply from operator',
        msgType: 0,
        direction: 2
      }
    });

    assert.equal(sent, 1);
    assert.deepEqual(await commandReceived, {
      type: 'message',
      act: 'send',
      param: {
        targetId: 'buyer-1',
        content: 'reply from operator',
        msgType: 0,
        direction: 2
      }
    });

    socket.close();
  } finally {
    server.close();
  }
});

test('websocket emits ack, error, login, and session protocol events', async () => {
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0 });

  try {
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/publicplatform`);
    await once(socket, 'open');

    for (const type of ['ack', 'error', 'login', 'session']) {
      const event = onceWithTimeout(server, `${type}-message`);
      socket.send(JSON.stringify({ type, requestId: `${type}-1`, sessionId: 'buyer-1', message: 'failed' }));
      const payload = await event;

      assert.equal(payload.protocol.type, type);
      assert.equal(payload.client.platform, 'publicplatform');
    }

    socket.close();
  } finally {
    server.close();
  }
});

test('websocket server logs start, stop, client connect, and client disconnect', async () => {
  const logs = [];
  const logger = {
    log: (...args) => logs.push(['log', ...args]),
    error: (...args) => logs.push(['error', ...args])
  };
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0, logger });

  try {
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/publicplatform`);
    await once(socket, 'open');

    const disconnected = once(server, 'client-disconnected');
    socket.close();
    await disconnected;
  } finally {
    server.close();
  }

  assert.equal(logs[0][1], '[ws:start]');
  assert.equal(logs.some((entry) => entry[1] === '[ws:client-connected]'), true);
  assert.equal(logs.some((entry) => entry[1] === '[ws:client-disconnected]'), true);
  assert.equal(logs.some((entry) => entry[1] === '[ws:stop]'), true);
});

test('websocket server logs parsed and unparsed message diagnostics', async () => {
  const logs = [];
  const logger = {
    log: (...args) => logs.push(['log', ...args]),
    error: (...args) => logs.push(['error', ...args])
  };
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0, logger });

  try {
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/publicplatform`);
    await once(socket, 'open');

    const parsed = once(server, 'pdd-message');
    socket.send(JSON.stringify({
      type: 'message',
      act: 'push',
      param: {
        msgId: 'text-1',
        targetId: 'buyer-1',
        direction: 1,
        msgType: 0,
        content: 'hello from buyer'
      }
    }));
    await parsed;

    const raw = once(server, 'raw-message');
    socket.send('not-json-diagnostic');
    await raw;

    socket.close();
  } finally {
    server.close();
  }

  assert.equal(logs.some((entry) => entry[1] === '[ws:message-received]'), true);
  assert.equal(logs.some((entry) => entry[1] === '[ws:pdd-message-parsed]'), true);
  assert.equal(logs.some((entry) => entry[1] === '[ws:raw-message-unparsed]'), true);
});

test('websocket client diagnostics include request URL, remote address, and user agent', async () => {
  const logs = [];
  const logger = {
    log: (...args) => logs.push(['log', ...args]),
    error: (...args) => logs.push(['error', ...args])
  };
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0, logger });

  try {
    const address = await server.start();
    const connected = once(server, 'client-connected');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/publicplatform?source=diagnostic`, {
      headers: { 'user-agent': 'diagnostic-client/1.0' }
    });

    await once(socket, 'open');
    const client = await connected;

    assert.equal(client.url, '/publicplatform?source=diagnostic');
    assert.match(client.remoteAddress, /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
    assert.equal(client.userAgent, 'diagnostic-client/1.0');
    assert.equal(logs.some((entry) => (
      entry[1] === '[ws:client-connected]' &&
      entry[2].url === '/publicplatform?source=diagnostic' &&
      entry[2].userAgent === 'diagnostic-client/1.0'
    )), true);

    socket.close();
  } finally {
    server.close();
  }
});

test('websocket exposes current public clients for status hydration', async () => {
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0 });

  try {
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/publicplatform?platform=pdd&csrName=%E6%8B%BC%E5%A4%9A%E5%A4%9A%E5%BA%97&targetId=shop-1`);
    await once(socket, 'open');

    assert.deepEqual(server.publicClients().map((client) => ({
      platform: client.platform,
      csrName: client.csrName,
      targetId: client.targetId
    })), [{
      platform: 'publicplatform',
      csrName: '拼多多店',
      targetId: 'shop-1'
    }]);

    socket.close();
  } finally {
    server.close();
  }
});

test('websocket updates public client shop name from currentCsr protocol payload', async () => {
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0 });

  try {
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/publicplatform?platform=pdd&csrName=PDD%20Workbench&targetId=shop-1`);
    await once(socket, 'open');

    const currentCsr = onceWithTimeout(server, 'currentcsr-message', 500);
    socket.send(JSON.stringify({
      type: 'currentCsr',
      param: {
        shopId: 'shop_001',
        shopName: '拼多多旗舰店',
        csrName: '主账号'
      }
    }));

    await currentCsr;

    const [client] = server.publicClients();
    assert.equal(client.shopId, 'shop_001');
    assert.equal(client.shopName, '拼多多旗舰店');
    assert.equal(client.csrName, '主账号');

    socket.close();
  } finally {
    server.close();
  }
});

test('websocket updates public client shop identity from currentCsr msg payload', async () => {
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0 });

  try {
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/publicplatform?platform=pdd&csrName=PDD%20Workbench&targetId=shop-1`);
    await once(socket, 'open');

    const currentCsr = onceWithTimeout(server, 'currentcsr-message', 500);
    socket.send(JSON.stringify({
      type: 'currentCsr',
      msg: {
        shopId: '440745',
        mallId: '440745',
        shopName: '霸派运动户外旗舰店',
        nick: '霸派运动户外旗舰店:售前客服测试账号',
        display: '售前客服测试账号',
        targetId: 'cs_440745_186839495',
        platform: 'pdd'
      }
    }));

    await currentCsr;

    const [client] = server.publicClients();
    assert.equal(client.shopId, '440745');
    assert.equal(client.shopName, '霸派运动户外旗舰店');
    assert.equal(client.csrName, '霸派运动户外旗舰店:售前客服测试账号');

    socket.close();
  } finally {
    server.close();
  }
});

test('websocket emits bridge diagnostics without parsing them as PDD messages', async () => {
  const logs = [];
  const logger = {
    log: (...args) => logs.push(['log', ...args]),
    error: (...args) => logs.push(['error', ...args])
  };
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0, logger });

  try {
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/publicplatform`);
    await once(socket, 'open');

    const diagnostic = once(server, 'bridge-diagnostic');
    let parsed = false;
    server.once('pdd-message', () => { parsed = true; });

    socket.send(JSON.stringify({
      type: 'diagnostic',
      source: 'pdd-bridge',
      name: 'page-websocket-message',
      payload: { url: 'wss://example.test/im', sample: '{"hello":"world"}' },
      time: 123
    }));

    const payload = await diagnostic;
    assert.equal(payload.diagnostic.name, 'page-websocket-message');
    assert.equal(payload.diagnostic.payload.url, 'wss://example.test/im');
    assert.equal(parsed, false);
    assert.equal(logs.some((entry) => entry[1] === '[bridge:diagnostic]'), true);

    socket.close();
  } finally {
    server.close();
  }
});

test('publicplatform websocket decodes Fuke-style msgpack PDD messages and sends msgpack commands', async () => {
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0 });

  try {
    const address = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/publicplatform?platform=pdd&csrName=店铺:客服&targetId=cs_1`);
    await once(socket, 'open');

    const received = onceWithTimeout(server, 'pdd-message', 500);
    socket.send(msgpack.encode({
      type: 'message',
      msg: [{
        msg_id: 'pdd-msg-1',
        type: 0,
        content: '买家实时消息',
        nickname: '买家',
        from: { role: 'user', uid: 'buyer-1' },
        to: { role: 'mall_cs', uid: 'cs_1' },
        ts: 1710000000
      }],
      param: { ccode: 'buyer-1' },
      saveMessages: [{
        msg_id: 'pdd-msg-1',
        type: 0,
        content: '买家实时消息',
        nickname: '买家',
        from: { role: 'user', uid: 'buyer-1' },
        to: { role: 'mall_cs', uid: 'cs_1' },
        ts: 1710000000
      }]
    }));

    const payload = await received;
    assert.equal(payload.message.id, 'pdd-msg-1');
    assert.equal(payload.message.conversationId, 'buyer-1');
    assert.equal(payload.message.direction, 'user');
    assert.equal(payload.message.kind, 'text');
    assert.equal(payload.message.content.text, '买家实时消息');

    const commandReceived = waitForMsgpackSocketMessage(socket);
    const sent = server.sendToTarget('buyer-1', {
      act: 'sendMsg',
      content: '自动回复内容',
      uid: 'buyer-1',
      csid: 'cs_1'
    });

    assert.equal(sent, 1);
    assert.deepEqual(await commandReceived, {
      act: 'sendMsg',
      content: '自动回复内容',
      uid: 'buyer-1',
      csid: 'cs_1'
    });

    socket.close();
  } finally {
    server.close();
  }
});

test('websocket logs decoded samples for unparsed msgpack messages', async () => {
  const logs = [];
  const logger = {
    log: (...args) => logs.push(['log', ...args]),
    error: (...args) => logs.push(['error', ...args])
  };
  const server = new InternalWebSocketServer({ host: '127.0.0.1', port: 0, logger });
  const raw = onceWithTimeout(server, 'raw-message', 500);
  server.handleMessage({
    id: 'client-1',
    platform: 'qn',
    targetIds: new Set(),
    connectedAt: Date.now()
  }, Buffer.from(msgpack.encode({ foo: 'bar' })));
  await raw;

  const unparsed = logs.find((entry) => entry[1] === '[ws:raw-message-unparsed]');
  assert.ok(unparsed);
  assert.match(unparsed[2].sample, /foo/);
});
