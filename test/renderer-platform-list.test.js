const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('renderer platform list hydrates real logged-in clients collapsed by default', async () => {
  const listeners = new Map();
  const apiEvents = new Map();

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
        this.textContent += items.map((item) => item?.textContent || '').join('');
      },
      addEventListener(eventName, listener) {
        listeners.set(this, listeners.get(this) || new Map());
        listeners.get(this).set(eventName, listener);
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      setAttribute(name, value) {
        this[name] = String(value);
      }
    };
    node.classList = createClassList(node);
    return node;
  }

  function createPlatformCard(platform) {
    const count = createNode();
    const list = createNode();
    const caret = createNode();
    const card = createNode({ className: 'platform-card', dataset: { platform } });
    card.querySelector = (selector) => {
      if (selector === '.shop-count') return count;
      if (selector === '.shop-list') return list;
      if (selector === '.platform-caret') return caret;
      return null;
    };
    return { card, count, list, caret };
  }

  const pdd = createPlatformCard('pdd');
  const qn = createPlatformCard('qn');
  const platformList = createNode();
  platformList.querySelectorAll = (selector) => (selector === '.platform-card' ? [pdd.card, qn.card] : []);

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
    platformList,
    tmagentEnabledInput: createNode({ checked: true }),
    tmagentBaseUrlInput: createNode(),
    tmagentMerchantNameInput: createNode(),
    tmagentTenantIdInput: createNode(),
    tmagentApiKeyInput: createNode(),
    tmagentHeaderPreview: createNode(),
    tmagentShopIdPreview: createNode(),
    tmagentShopNamePreview: createNode(),
    tmagentEndpointPreview: createNode(),
    tmagentPayloadPreview: createNode(),
    tmagentEnabledSummary: createNode(),
    tmagentBaseUrlSummary: createNode(),
    tmagentMerchantNameSummary: createNode(),
    tmagentTenantIdSummary: createNode(),
    tmagentApiKeySummary: createNode(),
    productLibrarySummary: createNode(),
    productLibraryGrid: createNode(),
    diagnosticEvents: createNode(),
    clientCount: createNode(),
    clientDetails: createNode()
  };

  const document = {
    getElementById(id) {
      return nodes[id] || createNode();
    },
    querySelectorAll() {
      return [];
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
        getStatus: async () => ({
          server: null,
          pdd: null,
          qn: null,
          clients: [
            { id: 'pdd-1', platform: 'publicplatform', shopName: 'PDD Workbench' },
            { id: '1782289527476-fc2499148845e', platform: 'publicplatform', targetId: '1782289527476-fc2499148845e', url: '/publicplatform' },
            { id: 'qn-1', platform: 'qn', csrName: 'Qianniu:Main' }
          ]
        }),
        getAiSettings: async () => ({ enabled: true }),
        getDiagnosticsSnapshot: async () => ({ time: 123, summary: {}, sendReceipts: [] }),
        saveAiSettings: async (payload) => payload,
        launchPdd: async () => ({}),
        launchQn: async () => ({}),
        sendMessage: async () => ({}),
        onServerStatus() {},
        onPddStatus() {},
        onPddError() {},
        onQnStatus() {},
        onQnError() {},
        onBridgeStatus() {},
        onBridgeHealth() {},
        onBridgeDiagnostic() {},
        onCdpStatus() {},
        onClientConnected() {},
        onClientDisconnected() {},
        onProtocolMessage(callback) {
          apiEvents.set('protocol-message', callback);
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
    JSON
  };

  const script = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(pdd.card.className, /\bcollapsed\b/);
  assert.equal(pdd.count.textContent, '2');
  assert.equal(pdd.list.children.length, 0);

  apiEvents.get('protocol-message')({
    client: { id: 'pdd-1', platform: 'publicplatform' },
    protocol: {
      type: 'currentcsr',
      payload: { shopName: '拼多多旗舰店' }
    }
  });

  await listeners.get(pdd.caret).get('click')();

  assert.doesNotMatch(pdd.card.className, /\bcollapsed\b/);
  assert.equal(pdd.list.children.length, 2);
  assert.match(pdd.list.children[0].textContent, /拼多多旗舰店/);
  assert.doesNotMatch(pdd.list.children[0].textContent, /PDD Workbench/);
  assert.match(pdd.list.children[0].textContent, /关闭 AI 回复/);
  assert.match(pdd.list.children[1].textContent, /未识别店铺/);
  assert.doesNotMatch(pdd.list.children[1].textContent, /publicplatform/);
  assert.doesNotMatch(pdd.list.children[1].textContent, /1782289527476/);
  assert.equal(qn.count.textContent, '1');
});
