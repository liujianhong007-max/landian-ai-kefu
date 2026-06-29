const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const { EventEmitter } = require('node:events');
const { createCdpManager, selectPddChatTarget } = require('../main/cdp-manager');

function once(emitter, eventName) {
  return new Promise((resolve) => emitter.once(eventName, resolve));
}

test('cdp manager connects, executes CDP methods, lists targets, and disconnects', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const requests = [];

  server.on('connection', (socket) => {
    socket.on('message', (buffer) => {
      const request = JSON.parse(buffer.toString());
      requests.push(request);

      if (request.method === 'Target.getTargets') {
        socket.send(JSON.stringify({
          id: request.id,
          result: {
            targetInfos: [
              { targetId: 'page-1', type: 'page', title: 'PDD' }
            ]
          }
        }));
        return;
      }

      socket.send(JSON.stringify({
        id: request.id,
        result: { ok: true, echo: request.params }
      }));
    });
  });

  try {
    await once(server, 'listening');
    const { port } = server.address();
    const manager = createCdpManager({
      url: `ws://127.0.0.1:${port}`,
      WebSocket
    });

    await manager.connect();
    assert.equal(manager.connected, true);

    const result = await manager.execute('Runtime.evaluate', { expression: '1 + 1' });
    assert.deepEqual(result, { ok: true, echo: { expression: '1 + 1' } });

    const targets = await manager.getTargets();
    assert.deepEqual(targets, [
      { targetId: 'page-1', type: 'page', title: 'PDD' }
    ]);

    await manager.disconnect();
    assert.equal(manager.connected, false);
    assert.deepEqual(requests.map((request) => request.method), [
      'Runtime.evaluate',
      'Target.getTargets'
    ]);
  } finally {
    server.close();
  }
});

test('cdp manager rejects pending commands when the socket closes', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => {
    socket.once('message', () => socket.close());
  });

  try {
    await once(server, 'listening');
    const { port } = server.address();
    const manager = createCdpManager({
      url: `ws://127.0.0.1:${port}`,
      WebSocket
    });

    await manager.connect();

    await assert.rejects(
      manager.execute('Runtime.evaluate', { expression: 'window.location.href' }),
      /CDP connection closed/
    );
  } finally {
    server.close();
  }
});

test('cdp manager fallback connects to Chromium default debug port after configured port fails', async () => {
  const attempts = [];

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      attempts.push(url);
      queueMicrotask(() => {
        if (url === 'ws://127.0.0.1:9222') {
          this.readyState = FakeWebSocket.OPEN;
          this.emit('open');
          return;
        }
        this.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      });
    }

    close() {
      this.emit('close');
    }
  }

  const manager = createCdpManager({
    url: 'ws://127.0.0.1:19999',
    WebSocket: FakeWebSocket,
    scanPddWebWorkbenchPorts: async () => []
  });

  const result = await manager.connectWithFallback();

  assert.deepEqual(attempts, [
    'ws://127.0.0.1:19999',
    'ws://127.0.0.1:9222'
  ]);
  assert.deepEqual(result, { connected: true, url: 'ws://127.0.0.1:9222' });
  assert.equal(manager.url, 'ws://127.0.0.1:9222');
});

test('cdp manager fallback scans pddwebworkbench listening ports after known ports fail', async () => {
  const attempts = [];

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      attempts.push(url);
      queueMicrotask(() => {
        if (url === 'ws://127.0.0.1:45678') {
          this.readyState = FakeWebSocket.OPEN;
          this.emit('open');
          return;
        }
        this.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      });
    }

    close() {
      this.emit('close');
    }
  }

  const manager = createCdpManager({
    url: 'ws://127.0.0.1:19999',
    WebSocket: FakeWebSocket,
    scanPddWebWorkbenchPorts: async () => [
      { pid: 111, port: 45678 }
    ]
  });

  const result = await manager.connectWithFallback();

  assert.deepEqual(attempts, [
    'ws://127.0.0.1:19999',
    'ws://127.0.0.1:9222',
    'ws://127.0.0.1:9229',
    'ws://127.0.0.1:45678'
  ]);
  assert.deepEqual(result, { connected: true, url: 'ws://127.0.0.1:45678' });
});

test('cdp manager fallback scans likely random debug port ranges after process-owned scan fails', async () => {
  const attempts = [];

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      attempts.push(url);
      queueMicrotask(() => {
        if (url === 'ws://127.0.0.1:19995') {
          this.readyState = FakeWebSocket.OPEN;
          this.emit('open');
          return;
        }
        this.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      });
    }

    close() {
      this.emit('close');
    }
  }

  const manager = createCdpManager({
    url: 'ws://127.0.0.1:19999',
    WebSocket: FakeWebSocket,
    scanPddWebWorkbenchPorts: async () => []
  });

  const result = await manager.connectWithFallback();

  assert.deepEqual(attempts, [
    'ws://127.0.0.1:19999',
    'ws://127.0.0.1:9222',
    'ws://127.0.0.1:9229',
    'ws://127.0.0.1:9220',
    'ws://127.0.0.1:9221',
    'ws://127.0.0.1:9223',
    'ws://127.0.0.1:9224',
    'ws://127.0.0.1:9225',
    'ws://127.0.0.1:9226',
    'ws://127.0.0.1:9227',
    'ws://127.0.0.1:9228',
    'ws://127.0.0.1:9230',
    'ws://127.0.0.1:19990',
    'ws://127.0.0.1:19991',
    'ws://127.0.0.1:19992',
    'ws://127.0.0.1:19993',
    'ws://127.0.0.1:19994',
    'ws://127.0.0.1:19995'
  ]);
  assert.deepEqual(result, { connected: true, url: 'ws://127.0.0.1:19995' });
});

test('selectPddChatTarget prefers chat detail targets from Chromium target list', () => {
  const targets = [
    { title: '商品订单', url: 'https://mms.pinduoduo.com/win-plugin/web/web_19.5.0/view/right_panel/index.html?uid=', webSocketDebuggerUrl: 'ws://right' },
    { title: '拼多多 商家后台', url: 'https://mms.pinduoduo.com/workbench/notification?tab=conversation', webSocketDebuggerUrl: 'ws://main' },
    { title: '聊天详情', url: 'https://mms.pinduoduo.com/win-plugin/web/web_19.5.0/view/middle_panel/index.html?uid=', webSocketDebuggerUrl: 'ws://chat' }
  ];

  assert.deepEqual(selectPddChatTarget(targets), targets[2]);
});

test('cdp manager resolves a debugging port to the selected page websocket URL', async () => {
  const attempts = [];

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      attempts.push(url);
      queueMicrotask(() => {
        if (url === 'ws://127.0.0.1:19999/devtools/page/chat') {
          this.readyState = FakeWebSocket.OPEN;
          this.emit('open');
          return;
        }
        this.emit('error', Object.assign(new Error('unexpected websocket url'), { code: 'EINVAL' }));
      });
    }

    close() {
      this.emit('close');
    }
  }

  const manager = createCdpManager({
    url: 'ws://127.0.0.1:19999',
    WebSocket: FakeWebSocket,
    resolveDebuggingPort: true,
    httpGetJson: async (url) => {
      assert.equal(url, 'http://127.0.0.1:19999/json/list');
      return [
        { title: '商品订单', url: 'https://mms.pinduoduo.com/right', webSocketDebuggerUrl: 'ws://127.0.0.1:19999/devtools/page/right' },
        { title: '聊天详情', url: 'https://mms.pinduoduo.com/win-plugin/web/web_19.5.0/view/middle_panel/index.html?uid=', webSocketDebuggerUrl: 'ws://127.0.0.1:19999/devtools/page/chat' }
      ];
    }
  });

  const result = await manager.connect();

  assert.deepEqual(result, { connected: true, url: 'ws://127.0.0.1:19999/devtools/page/chat' });
  assert.deepEqual(attempts, ['ws://127.0.0.1:19999/devtools/page/chat']);
});

test('cdp manager can list page targets and execute against a temporary target websocket', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

  server.on('connection', (socket) => {
    socket.on('message', (buffer) => {
      const request = JSON.parse(buffer.toString());
      socket.send(JSON.stringify({
        id: request.id,
        result: {
          ok: true,
          method: request.method,
          expression: request.params?.expression || ''
        }
      }));
    });
  });

  try {
    await once(server, 'listening');
    const { port } = server.address();
    const manager = createCdpManager({
      url: `ws://127.0.0.1:${port}/devtools/page/chat`,
      WebSocket,
      httpGetJson: async (url) => {
        assert.equal(url, `http://127.0.0.1:${port}/json/list`);
        return [{ title: '聊天详情', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/chat` }];
      }
    });

    const targets = await manager.listPageTargets();
    assert.equal(targets.length, 1);

    const result = await manager.executeOnWebSocketUrl(`ws://127.0.0.1:${port}/devtools/page/chat`, 'Runtime.evaluate', {
      expression: 'window.__probe = 1'
    });
    assert.deepEqual(result, {
      ok: true,
      method: 'Runtime.evaluate',
      expression: 'window.__probe = 1'
    });
  } finally {
    server.close();
  }
});
