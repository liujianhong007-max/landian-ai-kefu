const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('launcher renderer opens windows, renders shops, and toggles per-shop AI state', async () => {
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
      children: [],
      dataset: initial.dataset || {},
      lastChild: initial.lastChild || null,
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
      querySelector(selector) {
        if (selector === '.dot') return this.dot || null;
        return null;
      }
    };
    node.classList = createClassList(node);
    return node;
  }

  function createStatusNode(text) {
    const textNode = { textContent: text };
    const dot = createNode({ className: 'dot' });
    const node = createNode({ lastChild: textNode });
    node.dot = dot;
    node.querySelector = (selector) => (selector === '.dot' ? dot : null);
    return node;
  }

  const platformCards = [
    createNode({ className: 'platform-card', dataset: { platform: 'taobao' } }),
    createNode({ className: 'platform-card primary', dataset: { platform: 'pdd' } }),
    createNode({ className: 'platform-card', dataset: { platform: 'douyin' } })
  ];

  for (const card of platformCards) {
    card.countNode = createNode();
    card.listNode = createNode();
    card.caretNode = createNode();
    card.querySelector = (selector) => {
      if (selector === '.shop-count') return card.countNode;
      if (selector === '.shop-list') return card.listNode;
      if (selector === '.platform-caret') return card.caretNode;
      return null;
    };
  }

  let savedAiSettings = {
    enabled: true,
    provider: 'tmagent',
    baseUrl: 'http://127.0.0.1:8000',
    merchantName: 'demo-merchant',
    tenantId: 'tenant-a',
    apiKey: 'secret',
    headerName: 'X-API-Key',
    shopOverrides: {}
  };

  const nodes = {
    launchPdd: createNode(),
    platformPddAction: createNode(),
    platformQnAction: createNode(),
    openProductLibraryButton: createNode(),
    openAiSettingsButton: createNode(),
    serverStatus: createNode(),
    pddState: createStatusNode('未检测到'),
    qnState: createStatusNode('未检测到'),
    platformList: {
      querySelectorAll(selector) {
        return selector === '.platform-card' ? platformCards : [];
      }
    }
  };

  const apiEvents = new Map();
  const document = {
    getElementById(id) {
      return nodes[id] || createNode();
    },
    createElement() {
      return createNode();
    }
  };

  const context = {
    console: { error() {} },
    document,
    window: {
      pddFuke: {
        openProductLibrary: async () => {
          calls.push('openProductLibrary');
        },
        openAiSettings: async () => {
          calls.push('openAiSettings');
        },
        launchPdd: async () => ({ running: true, pid: 7788, cdpConnected: true }),
        launchQn: async () => ({ running: true, pid: 8899, helperInjected: true }),
        getStatus: async () => ({
          server: { address: '127.0.0.1', port: 59873 },
          clients: [{
            id: 'pdd-1',
            platform: 'publicplatform',
            shopId: '',
            shopName: '霸派运动户外旗舰店'
          }],
          pdd: { running: true, pid: 7788, cdpConnected: true },
          qn: { running: false }
        }),
        getAiSettings: async () => savedAiSettings,
        saveAiSettings: async (payload) => {
          savedAiSettings = payload;
          calls.push(['saveAiSettings', payload]);
          return payload;
        },
        onServerStatus(callback) {
          apiEvents.set('server', callback);
        },
        onPddStatus(callback) {
          apiEvents.set('pdd', callback);
        },
        onQnStatus(callback) {
          apiEvents.set('qn', callback);
        },
        onClientConnected(callback) {
          apiEvents.set('client-connected', callback);
        },
        onClientDisconnected(callback) {
          apiEvents.set('client-disconnected', callback);
        },
        onProtocolMessage(callback) {
          apiEvents.set('protocol', callback);
        }
      }
    },
    Set,
    Map,
    Array,
    String,
    Boolean,
    Promise
  };

  const script = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'launcher.js'), 'utf8');
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(nodes.serverStatus.textContent, 'ws://127.0.0.1:59873');
  assert.equal(platformCards[1].countNode.textContent, '1');
  assert.equal(platformCards[1].listNode.children.length, 1);
  assert.equal(platformCards[1].listNode.children[0].children[1].textContent, '霸派运动户外旗舰店');
  assert.equal(platformCards[1].listNode.children[0].children[2].textContent, 'AI 开启');

  await listeners.get(nodes.openProductLibraryButton).get('click')();
  await listeners.get(nodes.openAiSettingsButton).get('click')();
  assert.deepEqual(calls.slice(0, 2), ['openProductLibrary', 'openAiSettings']);

  await listeners.get(platformCards[1].listNode.children[0].children[2]).get('click')();
  assert.equal(savedAiSettings.baseUrl, 'http://127.0.0.1:8000');
  assert.equal(savedAiSettings.shopOverrides['pdd::name:霸派运动户外旗舰店'].enabled, false);
  assert.equal(platformCards[1].listNode.children[0].children[2].textContent, 'AI 关闭');

  apiEvents.get('protocol')({
    client: { id: 'pdd-1', platform: 'publicplatform' },
    protocol: { payload: { shopId: '440745', shopName: '新店铺名称' } }
  });

  assert.equal(platformCards[1].listNode.children[0].children[1].textContent, '新店铺名称');
});
