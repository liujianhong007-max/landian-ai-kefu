'use strict';

(function bootstrapRenderer() {
  const doc = typeof document !== 'undefined' ? document : null;
  const api = typeof window !== 'undefined' ? window.pddFuke || {} : {};
  const storage = typeof window !== 'undefined' ? window.localStorage || null : null;
  const pageKind = doc?.body?.dataset?.page || 'workspace';
  const PRODUCT_SHOP_REGISTRY_KEY = 'pdd-fuke.product-shop-registry.v1';
  const PRODUCT_SCOPE_KEY = 'pdd-fuke.product-scope.v1';

  function byId(id) {
    return doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null;
  }

  function queryAll(selector) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    try {
      return Array.from(doc.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function setText(node, value) {
    if (node) node.textContent = value == null || value === '' ? '--' : String(value);
  }

  function setValue(node, value) {
    if (node) node.value = value == null ? '' : String(value);
  }

  function setChecked(node, value) {
    if (node) node.checked = Boolean(value);
  }

  function setDisabled(node, value) {
    if (node) node.disabled = Boolean(value);
  }

  function setDisplay(node, value) {
    if (node?.style) node.style.display = value || '';
  }

  function setActive(node, active) {
    if (!node) return;
    if (node.classList && typeof node.classList.toggle === 'function') {
      node.classList.toggle('active', Boolean(active));
      return;
    }
    const classes = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
    if (active) classes.add('active');
    else classes.delete('active');
    node.className = Array.from(classes).join(' ');
  }

  function replaceChildren(node, children) {
    if (!node || typeof node.replaceChildren !== 'function') return;
    node.replaceChildren(...children);
  }

  function addListener(node, eventName, listener) {
    if (node && typeof node.addEventListener === 'function') {
      node.addEventListener(eventName, listener);
    }
  }

  function timeLabel(timestamp) {
    if (!timestamp) return '--';
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function truncate(value, max = 120) {
    const text = String(value == null ? '' : value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function stringify(value) {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function inferPlatformLabel(platform) {
    const map = {
      all: '全部',
      taobao: '淘宝天猫',
      qn: '淘宝天猫',
      '1688': '阿里巴巴',
      pdd: '拼多多',
      douyin: '抖店'
    };
    return map[platform] || platform || '未知平台';
  }

  function normalizePlatformKey(platform) {
    const value = String(platform || '').toLowerCase();
    if (value === 'publicplatform' || value === 'pdd') return 'pdd';
    if (value === 'qn' || value === 'qianniu' || value === 'taobao') return 'qn';
    return value || 'unknown';
  }

  function cleanShopText(value) {
    return String(value == null ? '' : value).trim();
  }

  function isTechnicalShopText(value) {
    const text = cleanShopText(value);
    if (!text) return true;
    if (/^unknown$/i.test(text)) return true;
    if (/^\/?publicplatform$/i.test(text)) return true;
    if (/^pdd\s*workbench$/i.test(text)) return true;
    if (/^\d{10,}[-_][a-z0-9]{8,}$/i.test(text)) return true;
    if (/^[a-f0-9]{8,}(?:-[a-f0-9]{4,}){2,}$/i.test(text)) return true;
    return false;
  }

  function firstShopDisplayName(...values) {
    for (const value of values) {
      const text = cleanShopText(value);
      if (!text || isTechnicalShopText(text)) continue;
      return text.split(/[:：]/)[0].trim() || text;
    }
    return '';
  }

  function extractClientShopName(client) {
    return firstShopDisplayName(
      client?.shopName,
      client?.storeName,
      client?.mallName,
      client?.merchantName,
      client?.name,
      client?.csrName
    ) || '未识别店铺';
  }

  function extractProtocolShopName(payload) {
    const mall = payload?.mall && typeof payload.mall === 'object' ? payload.mall : {};
    return firstShopDisplayName(
      payload?.shopName,
      payload?.storeName,
      payload?.mallName,
      payload?.merchantName,
      mall.mall_name,
      mall.name
    );
  }

  function extractProtocolShopId(payload) {
    const mall = payload?.mall && typeof payload.mall === 'object' ? payload.mall : {};
    return cleanShopText(payload?.shopId || payload?.shop_id || payload?.mallId || payload?.mall_id || mall.mall_id || mall.id);
  }

  function buildSyntheticShopId(shopName) {
    const name = cleanShopText(shopName);
    return name ? `name:${name}` : '';
  }

  function resolveShopId(shopId, shopName) {
    return cleanShopText(shopId) || buildSyntheticShopId(shopName);
  }

  function isSyntheticShopId(shopId) {
    return cleanShopText(shopId).startsWith('name:');
  }

  function formatShopScopeLabel(scope) {
    const shopId = cleanShopText(scope?.shopId || '');
    const shopName = cleanShopText(scope?.shopName || '') || shopId;
    return isSyntheticShopId(shopId) ? `${shopName}（未识别ID）` : `${shopName}（${shopId}）`;
  }

  function extractProtocolCsrName(payload) {
    const value = payload?.csrName || payload?.userName || payload?.username || payload?.nick || payload?.name;
    return String(value || '').trim();
  }

  function snapshotProductShopScope(scope) {
    const shopName = cleanShopText(scope?.shopName || '');
    return {
      platform: normalizePlatformKey(scope?.platform || 'pdd'),
      shopId: resolveShopId(scope?.shopId || '', shopName),
      shopName
    };
  }

  function trimCsvCell(value) {
    return String(value == null ? '' : value).replace(/\uFEFF/g, '').replace(/\t/g, '').trim();
  }

  function isActiveShelfValue(value) {
    const text = trimCsvCell(value);
    return !text || text === '上架';
  }

  function csvNumber(value) {
    const text = trimCsvCell(value).replace(/,/g, '');
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function parseCsvText(text) {
    const rows = [];
    let current = '';
    let row = [];
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (char === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (char === ',' && !inQuotes) {
        row.push(current);
        current = '';
        continue;
      }
      if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && next === '\n') index += 1;
        row.push(current);
        rows.push(row);
        row = [];
        current = '';
        continue;
      }
      current += char;
    }

    if (current !== '' || row.length) {
      row.push(current);
      rows.push(row);
    }
    if (!rows.length) return [];

    const header = rows[0].map(trimCsvCell);
    return rows
      .slice(1)
      .filter((cells) => cells.some((value) => trimCsvCell(value) !== ''))
      .map((cells) => {
        const entry = {};
        for (let index = 0; index < header.length; index += 1) {
          entry[header[index]] = cells[index] == null ? '' : cells[index];
        }
        return entry;
      });
  }

  function hasCsvHeaders(rows) {
    if (!rows.length) return false;
    const sample = rows[0] || {};
    return ['商品ID', '商品名称', '商品状态', 'SKU状态'].every((key) => Object.prototype.hasOwnProperty.call(sample, key));
  }

  function decodeCsvFileBuffer(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    for (const encoding of ['utf-8', 'gb18030', 'gbk']) {
      try {
        if (typeof TextDecoder !== 'function') break;
        const text = new TextDecoder(encoding).decode(bytes);
        const rows = parseCsvText(text);
        if (hasCsvHeaders(rows)) {
          return { rows, encoding };
        }
      } catch {}
    }
    throw new Error('CSV 编码无法识别，支持 utf-8 / gb18030 / gbk。');
  }

  function splitCsvImages(value) {
    return String(value || '')
      .split(',')
      .map(trimCsvCell)
      .filter(Boolean);
  }

  function buildCsvSku(row) {
    return {
      sku_id: trimCsvCell(row.SKUID),
      sku_code: trimCsvCell(row.SKU编码),
      sku_name: trimCsvCell(row.SKU属性) || trimCsvCell(row.颜色) || trimCsvCell(row.尺码) || trimCsvCell(row.商品名称),
      color: trimCsvCell(row.颜色),
      size: trimCsvCell(row.尺码),
      merchant_code: trimCsvCell(row.商家编码),
      stock: csvNumber(row.SKU库存),
      group_price: csvNumber(row.拼单价),
      single_price: csvNumber(row.单买价),
      reference_price: csvNumber(row.商品参考价),
      status: trimCsvCell(row.SKU状态 || row.商品状态 || '上架')
    };
  }

  function aggregateCsvItems(rows) {
    const groups = new Map();
    for (const row of rows) {
      if (!isActiveShelfValue(row.商品状态) || !isActiveShelfValue(row.SKU状态)) continue;
      const productId = trimCsvCell(row.商品ID);
      if (!productId) continue;

      if (!groups.has(productId)) {
        const gallery = [];
        for (let index = 1; index <= 10; index += 1) {
          const image = trimCsvCell(row[`商品轮播图${index}`]);
          if (image) gallery.push(image);
        }
        groups.set(productId, {
          product_id: productId,
          name: trimCsvCell(row.商品名称) || productId,
          category: trimCsvCell(row.商品分类),
          status: 'active',
          source: 'import',
          image_url: gallery[0] || trimCsvCell(row.规格预览图链接) || '',
          gallery,
          detail_images: splitCsvImages(row.商品详情图),
          brand: trimCsvCell(row.品牌),
          goods_attributes: trimCsvCell(row.商品属性),
          merchant_code: trimCsvCell(row.商家编码),
          created_at: trimCsvCell(row.创建时间),
          skus: [],
          prices: [],
          stocks: []
        });
      }

      const group = groups.get(productId);
      const sku = buildCsvSku(row);
      group.skus.push(sku);
      if (sku.group_price != null) group.prices.push(sku.group_price);
      else if (sku.single_price != null) group.prices.push(sku.single_price);
      else if (sku.reference_price != null) group.prices.push(sku.reference_price);
      if (sku.stock != null) group.stocks.push(sku.stock);
    }

    return Array.from(groups.values()).map((group) => ({
      product_id: group.product_id,
      name: group.name,
      category: group.category || null,
      status: 'active',
      source: 'import',
      image_url: group.image_url || null,
      price: group.prices.length ? Math.min(...group.prices) : null,
      stock: group.stocks.length ? group.stocks.reduce((sum, value) => sum + value, 0) : null,
      attributes: {
        brand: group.brand || '',
        goods_attributes: group.goods_attributes || '',
        merchant_code: group.merchant_code || '',
        created_at: group.created_at || '',
        gallery: group.gallery,
        detail_images: group.detail_images,
        skus: group.skus
      }
    }));
  }

  function platformLogoText(platform) {
    const key = normalizePlatformKey(platform);
    if (key === 'pdd') return '拼';
    if (key === 'qn') return '千';
    if (key === 'douyin') return '抖';
    return '店';
  }

  const els = {
    launchPdd: byId('launchPdd'),
    platformPddAction: byId('platformPddAction'),
    platformQnAction: byId('platformQnAction'),
    pddState: byId('pddState'),
    qnState: byId('qnState'),
    serverStatus: byId('serverStatus'),
    platformList: byId('platformList'),
    toggleProductPanel: byId('toggleProductPanel'),
    toggleToolsPanel: byId('toggleToolsPanel'),
    toolsDrawer: byId('toolsDrawer'),
    workspaceDrawerTitle: byId('workspaceDrawerTitle'),
    opsPanel: doc && typeof doc.querySelector === 'function' ? doc.querySelector('.ops-panel') : null,
    metricGrid: doc && typeof doc.querySelector === 'function' ? doc.querySelector('.metric-grid') : null,
    diagnosticsPanel: doc && typeof doc.querySelector === 'function' ? doc.querySelector('.diagnostics') : null,
    conversationPanel: doc && typeof doc.querySelector === 'function' ? doc.querySelector('.conversation-panel') : null,
    clientCount: byId('clientCount'),
    clientDetails: byId('clientDetails'),
    pendingCount: byId('pendingCount'),
    todayReception: byId('todayReception'),
    bridgeStatus: byId('bridgeStatus'),
    bridgeHttpStatus: byId('bridgeHttpStatus'),
    bridgeWsStatus: byId('bridgeWsStatus'),
    bridgeReadyStatus: byId('bridgeReadyStatus'),
    cdpStatus: byId('cdpStatus'),
    lastRawMessage: byId('lastRawMessage'),
    lastParsedMessage: byId('lastParsedMessage'),
    unparsedCount: byId('unparsedCount'),
    lastSendResult: byId('lastSendResult'),
    transferTraceStatus: byId('transferTraceStatus'),
    lastBridgeProbe: byId('lastBridgeProbe'),
    lastWbChatFile: byId('lastWbChatFile'),
    lastDomChat: byId('lastDomChat'),
    helperProcessSummary: byId('helperProcessSummary'),
    workbenchProcessSummary: byId('workbenchProcessSummary'),
    lastSendReceiptSummary: byId('lastSendReceiptSummary'),
    sendReceiptList: byId('sendReceiptList'),
    diagnosticEvents: byId('diagnosticEvents'),
    refreshDiagnostics: byId('refreshDiagnostics'),
    copyDiagnostics: byId('copyDiagnostics'),
    diagnosticSnapshotTime: byId('diagnosticSnapshotTime'),
    chatTitle: byId('chatTitle'),
    chatSubtitle: byId('chatSubtitle'),
    conversationList: byId('conversationList'),
    messages: byId('messages'),
    composer: byId('composer'),
    messageInput: byId('messageInput'),
    sendButton: byId('sendButton'),
    tabProductLibrary: byId('tabProductLibrary'),
    tabSessionTools: byId('tabSessionTools'),
    tabAiSettings: byId('tabAiSettings'),
    tabQuickReplies: byId('tabQuickReplies'),
    tabWorkspaceLogs: byId('tabWorkspaceLogs'),
    productLibraryPane: byId('productLibraryPane'),
    sessionToolsPane: byId('sessionToolsPane'),
    aiSettingsPane: byId('aiSettingsPane'),
    quickRepliesPane: byId('quickRepliesPane'),
    workspaceLogsPane: byId('workspaceLogsPane'),
    shopSearchInput: byId('shopSearchInput'),
    goodsSearchInput: byId('goodsSearchInput'),
    productScopePlatformSelect: byId('productScopePlatformSelect'),
    productScopeRegistrySelect: byId('productScopeRegistrySelect'),
    productScopeHint: byId('productScopeHint'),
    clearProductShopRegistryButton: byId('clearProductShopRegistryButton'),
    agentFilterSelect: byId('agentFilterSelect'),
    fetchProductsButton: byId('fetchProductsButton'),
    taskProgressButton: byId('taskProgressButton'),
    productScopeSelect: byId('productScopeSelect'),
    productStatusFilterSelect: byId('productStatusFilterSelect'),
    productSortBySelect: byId('productSortBySelect'),
    productSortOrderSelect: byId('productSortOrderSelect'),
    batchDeleteButton: byId('batchDeleteButton'),
    selectAllProductsButton: byId('selectAllProductsButton'),
    batchLearnButton: byId('batchLearnButton'),
    productSearchButton: byId('productSearchButton'),
    refreshProductsButton: byId('refreshProductsButton'),
    uploadProductsButton: byId('uploadProductsButton'),
    productLibrarySummary: byId('productLibrarySummary'),
    productLibraryGrid: byId('productLibraryGrid'),
    productLibraryPagination: byId('productLibraryPagination'),
    productTableHeaderCheck: byId('productTableHeaderCheck'),
    productTableEmpty: byId('productTableEmpty'),
    productBatchBar: byId('productBatchBar'),
    productBatchCount: byId('productBatchCount'),
    productDetailOverlay: byId('productDetailOverlay'),
    productBreadcrumbTitle: byId('productBreadcrumbTitle'),
    closeDetailDrawerButton: byId('closeDetailDrawerButton'),
    loadProductsButton: byId('loadProductsButton'),
    addProductButton: byId('addProductButton'),
    productDetailPanel: byId('productDetailPanel'),
    productDrawerTitle: byId('productDrawerTitle'),
    productOverviewSummary: byId('productOverviewSummary'),
    saveProductButton: byId('saveProductButton'),
    resetProductButton: byId('resetProductButton'),
    productIdInput: byId('productIdInput'),
    productNameInput: byId('productNameInput'),
    productCategoryInput: byId('productCategoryInput'),
    productPriceInput: byId('productPriceInput'),
    productStockInput: byId('productStockInput'),
    productImageUrlInput: byId('productImageUrlInput'),
    productMediaLinks: byId('productMediaLinks'),
    productDetailLinks: byId('productDetailLinks'),
    productSkuSummary: byId('productSkuSummary'),
    productStatusSelect: byId('productStatusSelect'),
    productSourceSelect: byId('productSourceSelect'),
    addAttributeRowButton: byId('addAttributeRowButton'),
    productAttributesEditor: byId('productAttributesEditor'),
    productSyncStatusDisplay: byId('productSyncStatusDisplay'),
    productSyncErrorDisplay: byId('productSyncErrorDisplay'),
    productLastSyncAtDisplay: byId('productLastSyncAtDisplay'),
    rebuildProductSearchButton: byId('rebuildProductSearchButton'),
    deleteProductButton: byId('deleteProductButton'),
    productImportModal: byId('productImportModal'),
    productCsvFileInput: byId('productCsvFileInput'),
    chooseProductCsvButton: byId('chooseProductCsvButton'),
    productCsvFileName: byId('productCsvFileName'),
    closeProductImportButton: byId('closeProductImportButton'),
    runProductImportButton: byId('runProductImportButton'),
    productImportScopeLabel: byId('productImportScopeLabel'),
    productImportResult: byId('productImportResult'),
    loadCurrentCsrButton: byId('loadCurrentCsrButton'),
    loadCurrentConvButton: byId('loadCurrentConvButton'),
    loadRemoteHistoryButton: byId('loadRemoteHistoryButton'),
    currentCsrDisplay: byId('currentCsrDisplay'),
    currentConvDisplay: byId('currentConvDisplay'),
    sessionCcodeInput: byId('sessionCcodeInput'),
    remoteHistoryLimitInput: byId('remoteHistoryLimitInput'),
    remoteHistoryResult: byId('remoteHistoryResult'),
    orderIdInput: byId('orderIdInput'),
    orderConversationInput: byId('orderConversationInput'),
    queryOrderRemarkButton: byId('queryOrderRemarkButton'),
    saveOrderRemarkButton: byId('saveOrderRemarkButton'),
    sendOrderMessageButton: byId('sendOrderMessageButton'),
    orderRemarkInput: byId('orderRemarkInput'),
    orderTagColorSelect: byId('orderTagColorSelect'),
    orderTagNameInput: byId('orderTagNameInput'),
    orderMessageInput: byId('orderMessageInput'),
    orderToolResult: byId('orderToolResult'),
    tmagentEnabledInput: byId('tmagentEnabledInput'),
    tmagentBaseUrlInput: byId('tmagentBaseUrlInput'),
    tmagentMerchantNameInput: byId('tmagentMerchantNameInput'),
    tmagentTenantIdInput: byId('tmagentTenantIdInput'),
    tmagentApiKeyInput: byId('tmagentApiKeyInput'),
    tmagentHeaderPreview: byId('tmagentHeaderPreview'),
    tmagentShopIdPreview: byId('tmagentShopIdPreview'),
    tmagentShopNamePreview: byId('tmagentShopNamePreview'),
    tmagentEndpointPreview: byId('tmagentEndpointPreview'),
    tmagentPayloadPreview: byId('tmagentPayloadPreview'),
    tmagentEnabledSummary: byId('tmagentEnabledSummary'),
    tmagentBaseUrlSummary: byId('tmagentBaseUrlSummary'),
    tmagentMerchantNameSummary: byId('tmagentMerchantNameSummary'),
    tmagentTenantIdSummary: byId('tmagentTenantIdSummary'),
    tmagentApiKeySummary: byId('tmagentApiKeySummary'),
    testReplyInput: byId('testReplyInput'),
    testReplyOutput: byId('testReplyOutput'),
    runTestReplyButton: byId('runTestReplyButton'),
    saveAiSettingsButton: byId('saveAiSettingsButton')
  };

  const state = {
    diagnostics: {
      events: [],
      clients: [],
      bridgeConnected: false,
      cdpConnected: false,
      bridgeHealth: {
        httpStarted: false,
        bridgeUrl: '',
        wsConnected: false,
        pageReady: false,
        pageReadyAt: null,
        activeTraceId: null
      },
      unparsedCount: 0,
      lastRaw: null,
      lastParsed: null,
      lastSend: null,
      lastBridgeProbe: null,
      lastWbChatFile: null,
      lastDomChat: null
    },
    conversations: new Map(),
    activeConversationId: null,
    workspace: {
      activeTab: 'session-tools',
      toolsOpen: false,
      sidePanel: null,
      drawerMode: 'product',
      expandedPlatforms: new Set(),
      selectedProductIds: new Set(),
      productLibrary: [],
      productPagination: {
        page: 1,
        page_size: 20,
        total: 0,
        total_pages: 1
      },
      productScope: {
        platform: 'pdd',
        shopId: '',
        shopName: '',
        status: 'active',
        q: '',
        category: '',
        page: 1,
        pageSize: 20,
        sortBy: 'updated_at',
        sortOrder: 'desc'
      },
      productShopRegistry: [],
      productDetailMode: 'idle',
      activeProductId: null,
      productDraft: null,
      productImportOpen: false,
      aiSettings: {
        provider: 'tmagent',
        enabled: true,
        baseUrl: 'https://xingqiao.taluo.club',
        merchantName: '',
        tenantId: '',
        apiKey: '',
        headerName: 'X-API-Key',
        shopOverrides: {}
      },
      sessionTools: {
        currentCsr: null,
        currentConv: null,
        remoteHistory: [],
        remoteHistoryMeta: null,
        orderResult: null,
        pendingRequests: {
          orderRemarkQuery: null,
          orderRemarkSave: null,
          orderMessageSend: null
        }
      }
    }
  };

  function addDiagnosticEvent(label, detail, timestamp) {
    state.diagnostics.events.unshift({
      label,
      detail: truncate(detail, 240),
      timestamp: timestamp || Date.now()
    });
    state.diagnostics.events = state.diagnostics.events.slice(0, 60);
    renderDiagnosticEvents();
    renderWorkspaceLogs();
  }

  function renderBridgeHealth(status = {}) {
    state.diagnostics.bridgeHealth = {
      httpStarted: Boolean(status.httpStarted),
      bridgeUrl: String(status.bridgeUrl || ''),
      wsConnected: Boolean(status.wsConnected),
      pageReady: Boolean(status.pageReady),
      pageReadyAt: status.pageReadyAt || null,
      activeTraceId: status.activeTraceId || null
    };
    setText(els.bridgeHttpStatus, status.httpStarted ? (status.bridgeUrl || 'Ready') : 'Not ready');
    setText(els.bridgeWsStatus, status.wsConnected ? 'Connected' : 'Not connected');
    setText(
      els.bridgeReadyStatus,
      status.pageReady ? `Ready ${timeLabel(status.pageReadyAt)}` : 'Waiting'
    );
    setText(els.transferTraceStatus, status.activeTraceId || 'None');
  }

  function renderDiagnosticEvents() {
    if (!els.diagnosticEvents || !doc || typeof doc.createElement !== 'function') return;
    const items = state.diagnostics.events.slice(0, 12).map((event) => {
      const item = doc.createElement('div');
      item.className = 'diagnostic-event';
      item.textContent = `${timeLabel(event.timestamp)} ${event.label} - ${event.detail}`;
      return item;
    });
    replaceChildren(els.diagnosticEvents, items);
  }

  function formatClientSummary() {
    if (!state.diagnostics.clients.length) return 'No clients connected';
    return state.diagnostics.clients
      .map((client) => `${client.platform || 'client'}${client.path ? ` ${client.path}` : ''}`)
      .join(' | ');
  }

  function renderCounters() {
    const pending = Array.from(state.conversations.values()).filter((item) => item.unreadCount > 0).length;
    setText(els.clientCount, `${state.diagnostics.clients.length} clients`);
    setText(els.clientDetails, formatClientSummary());
    setText(els.pendingCount, pending);
    setText(els.todayReception, state.conversations.size);
  }

  function updateStatusLabel(node, text, active) {
    if (!node) return;
    const textNode = node.lastChild && typeof node.lastChild.textContent === 'string' ? node.lastChild : node;
    setText(textNode, text);
    const dot = typeof node.querySelector === 'function' ? node.querySelector('.dot') : null;
    if (dot && dot.classList && typeof dot.classList.toggle === 'function') {
      dot.classList.toggle('active', Boolean(active));
    }
  }

  function formatPddStatus(status) {
    if (!status || !status.running) return 'Not detected';
    const parts = [`Running 路 PID ${status.pid || '--'}`];
    if (status.cdpConnected) parts.push('CDP ready');
    return parts.join(' | ');
  }

  function formatQnStatus(status) {
    if (!status || !status.running) return 'QN not detected';
    const parts = [`Running 路 PID ${status.pid || '--'}`];
    if (status.helperInjected) parts.push('Helper ready');
    return parts.join(' | ');
  }

  function renderPlatformList() {
    if (!els.platformList || typeof els.platformList.querySelectorAll !== 'function') return;
    const cards = Array.from(els.platformList.querySelectorAll('.platform-card'));
    const shopsByPlatform = state.diagnostics.clients.reduce((map, client) => {
      const key = normalizePlatformKey(client?.platform);
      const shops = map.get(key) || [];
      shops.push({
        id: String(client?.id || `${key}-${shops.length}`),
        platform: key,
        name: extractClientShopName(client),
        client
      });
      map.set(key, shops);
      return map;
    }, new Map());

    for (const card of cards) {
      const platform = normalizePlatformKey(card.dataset ? card.dataset.platform : '');
      const shops = shopsByPlatform.get(platform) || [];
      const expanded = state.workspace.expandedPlatforms.has(platform);
      const countNode = typeof card.querySelector === 'function' ? card.querySelector('.shop-count') : null;
      const listNode = typeof card.querySelector === 'function' ? card.querySelector('.shop-list') : null;
      const caretNode = typeof card.querySelector === 'function' ? card.querySelector('.platform-caret') : null;
      setActive(card, expanded);
      if (card.classList && typeof card.classList.toggle === 'function') {
        card.classList.toggle('collapsed', !expanded);
      }
      if (caretNode) {
        caretNode.textContent = expanded ? 'v' : '>';
        if (typeof caretNode.setAttribute === 'function') {
          caretNode.setAttribute('aria-expanded', String(expanded));
        }
      }
      if (countNode) countNode.textContent = String(shops.length);
      if (listNode) {
        if (!expanded) {
          replaceChildren(listNode, []);
        } else {
          const rows = shops.map((shop) => {
            const row = doc.createElement('div');
            row.className = 'shop-row';

            const logo = doc.createElement('span');
            logo.className = `shop-logo ${shop.platform}`;
            logo.textContent = platformLogoText(shop.platform);

            const name = doc.createElement('span');
            name.className = 'shop-name';
            name.textContent = shop.name;

            const action = doc.createElement('button');
            action.type = 'button';
            action.className = 'shop-ai-action';
            action.textContent = state.workspace.aiSettings.enabled ? '关闭 AI 回复' : 'AI 已关闭';
            setDisabled(action, !state.workspace.aiSettings.enabled);
            addListener(action, 'click', async () => {
              await saveAiSettings({ enabled: false });
            });

            row.append(logo, name, action);
            return row;
          });
          replaceChildren(listNode, rows);
        }
      }
    }
  }

  function ensureConversation(id) {
    const key = String(id || 'unknown');
    if (!state.conversations.has(key)) {
      state.conversations.set(key, {
        id: key,
        title: key,
        subtitle: '',
        messages: [],
        unreadCount: 0,
        platform: 'pdd',
        senderName: key
      });
    }
    return state.conversations.get(key);
  }

  function normalizeIncomingMessage(payload) {
    const message = payload?.message || payload || {};
    const content = message.content || {};
    const text = content.text || message.text || message.body || '';
    return {
      id: message.id || `${message.conversationId || 'conversation'}-${Date.now()}`,
      conversationId: message.conversationId || payload?.client?.targetId || 'unknown',
      text: String(text || ''),
      direction: message.direction || 'user',
      timestamp: message.timestamp || payload?.time || Date.now(),
      senderName: message.senderName || payload?.client?.path || message.conversationId || '未知会话',
      platform: payload?.client?.platform || message.platform || 'pdd'
    };
  }

  function renderConversationList() {
    if (!els.conversationList || !doc || typeof doc.createElement !== 'function') return;
    const items = Array.from(state.conversations.values())
      .sort((a, b) => (b.messages.at(-1)?.timestamp || 0) - (a.messages.at(-1)?.timestamp || 0))
      .map((conversation) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = `conversation-item${conversation.id === state.activeConversationId ? ' active' : ''}`;
        button.textContent = `${conversation.title}${conversation.unreadCount ? ` (${conversation.unreadCount})` : ''} ${truncate(conversation.subtitle || '', 28)}`;
        addListener(button, 'click', () => {
          state.activeConversationId = conversation.id;
          conversation.unreadCount = 0;
          renderConversationList();
          renderMessages();
          renderCounters();
        });
        return button;
      });
    replaceChildren(els.conversationList, items);
  }

  function renderMessages() {
    const conversation = state.activeConversationId ? state.conversations.get(state.activeConversationId) : null;
    const canSend = Boolean(conversation);
    setDisabled(els.messageInput, !canSend);
    setDisabled(els.sendButton, !canSend);
    setText(els.chatTitle, conversation ? conversation.title : '最近消息');
    setText(els.chatSubtitle, conversation ? (conversation.subtitle || '等待新消息') : 'Waiting for PDD messages');

    if (!els.messages || !doc || typeof doc.createElement !== 'function') return;
    if (!conversation || !conversation.messages.length) {
      const empty = doc.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无买家消息';
      replaceChildren(els.messages, [empty]);
      return;
    }

    const nodes = conversation.messages.slice(-20).map((message) => {
      const item = doc.createElement('div');
      item.className = `message-row ${message.direction === 'assistant' ? 'assistant' : 'user'}`;
      item.textContent = `${message.direction === 'assistant' ? '客服' : '买家'} ${timeLabel(message.timestamp)}  ${message.text}`;
      return item;
    });
    replaceChildren(els.messages, nodes);
  }

  function appendIncomingMessage(payload) {
    const message = normalizeIncomingMessage(payload);
    if (!message.text) return;
    const conversation = ensureConversation(message.conversationId);
    conversation.title = message.senderName || conversation.title;
    conversation.subtitle = message.text;
    conversation.platform = message.platform;
    conversation.senderName = message.senderName || conversation.senderName;
    conversation.messages.push(message);
    if (message.direction !== 'assistant') {
      conversation.unreadCount += state.activeConversationId === conversation.id ? 0 : 1;
    }
    if (!state.activeConversationId) state.activeConversationId = conversation.id;
    addDiagnosticEvent('message', `${conversation.title} | ${message.text}`, message.timestamp);
    renderConversationList();
    renderMessages();
    renderCounters();
  }

  function buildTmagentBaseUrl() {
    const raw = String(state.workspace.aiSettings.baseUrl || els.tmagentBaseUrlInput?.value || 'https://xingqiao.taluo.club').trim();
    if (!raw) throw new Error('请先在设置里配置 tmagent Base URL');
    return raw.endsWith('/') ? raw.slice(0, -1) : raw;
  }

  function buildTmagentHeaders() {
    const apiKey = String(state.workspace.aiSettings.apiKey || els.tmagentApiKeyInput?.value || '').trim();
    if (!apiKey) throw new Error('请先在设置里配置 tmagent API Key');
    return {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    };
  }

  async function tmagentRequest(path, options = {}) {
    if (!api?.tmagentRequest) throw new Error('当前版本缺少 tmagent 请求代理，请重启客户端');
    return api.tmagentRequest({
      baseUrl: buildTmagentBaseUrl(),
      path,
      method: options.method || 'GET',
      headers: {
        ...buildTmagentHeaders(),
        ...(options.headers || {})
      },
      body: options.body
    });
  }

  function currentProductScope() {
    return {
      platform: String(state.workspace.productScope.platform || '').trim(),
      shopId: String(state.workspace.productScope.shopId || '').trim(),
      shopName: String(state.workspace.productScope.shopName || '').trim()
    };
  }

  function persistProductShopRegistry() {
    if (!storage) return;
    try {
      storage.setItem(PRODUCT_SHOP_REGISTRY_KEY, JSON.stringify(state.workspace.productShopRegistry));
    } catch {}
  }

  function persistProductScope() {
    if (!storage) return;
    try {
      storage.setItem(PRODUCT_SCOPE_KEY, JSON.stringify({
        platform: state.workspace.productScope.platform,
        shopId: state.workspace.productScope.shopId,
        shopName: state.workspace.productScope.shopName
      }));
    } catch {}
  }

  function loadProductScope() {
    if (!storage) return;
    try {
      const raw = storage.getItem(PRODUCT_SCOPE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.platform) state.workspace.productScope.platform = String(parsed.platform).trim();
      if (parsed.shopId) state.workspace.productScope.shopId = String(parsed.shopId).trim();
      if (parsed.shopName) state.workspace.productScope.shopName = String(parsed.shopName).trim();
    } catch {}
  }

  function loadProductShopRegistry() {
    if (!storage) return;
    try {
      const raw = storage.getItem(PRODUCT_SHOP_REGISTRY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      state.workspace.productShopRegistry = parsed
        .map((item) => snapshotProductShopScope(item))
        .filter((item) => item.platform && item.shopId);
    } catch {}
  }

  function mergeProductShopRegistryEntry(scope) {
    const next = snapshotProductShopScope(scope);
    if (!next.platform || !next.shopId) return;
    state.workspace.productShopRegistry = [
      next,
      ...state.workspace.productShopRegistry.filter((item) => !(item.platform === next.platform && item.shopId === next.shopId))
    ];
    persistProductShopRegistry();
  }

  function syncProductScopeForm() {
    setValue(els.productScopePlatformSelect, state.workspace.productScope.platform);
    renderProductShopRegistry();
    setValue(
      els.productScopeRegistrySelect,
      state.workspace.productScope.shopId
        ? `${state.workspace.productScope.platform}::${state.workspace.productScope.shopId}`
        : ''
    );
    renderProductScopeHint();
  }

  function productScopeOptionValue(scope) {
    return `${scope.platform}::${scope.shopId}`;
  }

  function getCurrentPlatformProductShops() {
    const platform = String(state.workspace.productScope.platform || 'pdd').trim();
    return state.workspace.productShopRegistry.filter((scope) => scope.platform === platform);
  }

  function applyProductScopeFromRegistryValue(value) {
    const matched = state.workspace.productShopRegistry.find((scope) => productScopeOptionValue(scope) === value);
    if (!matched) {
      state.workspace.productScope.shopId = '';
      state.workspace.productScope.shopName = '';
      persistProductScope();
      return null;
    }
    state.workspace.productScope.platform = matched.platform;
    state.workspace.productScope.shopId = matched.shopId;
    state.workspace.productScope.shopName = matched.shopName;
    persistProductScope();
    return matched;
  }

  function renderProductScopeHint() {
    const scope = currentProductScope();
    const shops = getCurrentPlatformProductShops();
    const text = scope.shopId
      ? `当前店铺：${formatShopScopeLabel(scope)}`
      : (shops.length ? '请选择一个店铺，再进入商品库。' : '当前平台还没有识别到店铺，先去启动台登录店铺。');
    setText(els.productScopeHint, text);
    setText(
      els.productImportScopeLabel,
      scope.shopId
        ? `当前店铺：${formatShopScopeLabel(scope)}`
        : '当前店铺：未选择'
    );
  }

  function renderProductShopRegistry() {
    const select = els.productScopeRegistrySelect;
    if (!select || !doc || typeof doc.createElement !== 'function') return;
    const shops = getCurrentPlatformProductShops();
    const options = [];
    const placeholder = doc.createElement('option');
    placeholder.value = '';
    placeholder.textContent = shops.length ? '请选择店铺' : '当前平台暂无已识别店铺';
    options.push(placeholder);
    for (const scope of shops) {
      const option = doc.createElement('option');
      option.value = productScopeOptionValue(scope);
      option.textContent = formatShopScopeLabel(scope);
      options.push(option);
    }
    replaceChildren(select, options);
  }

  function syncProductShopRegistryFromClients(clients) {
    const list = Array.isArray(clients) ? clients : [];
    let scopeChanged = false;
    for (const client of list) {
      const platform = normalizePlatformKey(client?.platform);
      const shopName = extractClientShopName(client);
      const shopId = resolveShopId(client?.shopId || client?.shop_id || client?.mallId || client?.mall_id, shopName);
      if (!platform || !shopId) continue;
      mergeProductShopRegistryEntry({ platform, shopId, shopName });
      if (state.workspace.productScope.platform === platform && state.workspace.productScope.shopId === shopId) {
        state.workspace.productScope.shopName = shopName || state.workspace.productScope.shopName;
        scopeChanged = true;
      }
    }
    if (scopeChanged) persistProductScope();
    syncProductScopeForm();
  }

  function hasProductScope() {
    const scope = currentProductScope();
    return Boolean(scope.platform && scope.shopId);
  }

  function requireProductScope(actionLabel = '操作') {
    const scope = currentProductScope();
    if (!scope.platform || !scope.shopId) {
      throw new Error(`请先选择店铺，再${actionLabel}`);
    }
    return scope;
  }

  function ensureProductDraft(product = null) {
    const current = product || {};
    state.workspace.productDraft = {
      id: current.id || '',
      product_id: current.product_id || '',
      name: current.name || '',
      category: current.category || '',
      price: current.price ?? '',
      stock: current.stock ?? '',
      image_url: current.image_url || '',
      status: current.status || 'active',
      source: current.source || 'manual',
      attributes: { ...(current.attributes || {}) },
      search_snapshot: current.search_snapshot || null,
      sync_status: current.sync_status || '--',
      sync_error: current.sync_error || '',
      last_sync_at: current.last_sync_at || ''
    };
  }

  function readProductScopeForm() {
    state.workspace.productScope.platform = String(els.productScopePlatformSelect?.value || 'pdd').trim();
    applyProductScopeFromRegistryValue(String(els.productScopeRegistrySelect?.value || '').trim());
    state.workspace.productScope.q = String(els.goodsSearchInput?.value || '').trim();
    state.workspace.productScope.category = String(els.shopSearchInput?.value || '').trim();
    state.workspace.productScope.status = String(els.productStatusFilterSelect?.value || 'active').trim();
    state.workspace.productScope.sortBy = String(els.productSortBySelect?.value || 'updated_at').trim();
    state.workspace.productScope.sortOrder = String(els.productSortOrderSelect?.value || 'desc').trim();
  }

  function renderAttributeEditor() {
    if (!els.productAttributesEditor || !doc || typeof doc.createElement !== 'function') return;
    const entries = Object.entries(state.workspace.productDraft?.attributes || {});
    const rows = entries.map(([key, value], index) => {
      const row = doc.createElement('div');
      row.className = 'attribute-row';
      const keyInput = doc.createElement('input');
      keyInput.className = 'workspace-input';
      keyInput.value = key;
      const valueInput = doc.createElement('input');
      valueInput.className = 'workspace-input';
      valueInput.value = value == null ? '' : String(value);
      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'workspace-action danger';
      remove.textContent = '删';
      addListener(keyInput, 'input', () => {
        const next = Object.entries(state.workspace.productDraft.attributes || {});
        next[index] = [keyInput.value, valueInput.value];
        state.workspace.productDraft.attributes = Object.fromEntries(next.filter(([draftKey]) => String(draftKey || '').trim()));
      });
      addListener(valueInput, 'input', () => {
        const next = Object.entries(state.workspace.productDraft.attributes || {});
        next[index] = [keyInput.value, valueInput.value];
        state.workspace.productDraft.attributes = Object.fromEntries(next.filter(([draftKey]) => String(draftKey || '').trim()));
      });
      addListener(remove, 'click', () => {
        const next = Object.entries(state.workspace.productDraft.attributes || {}).filter((_, currentIndex) => currentIndex !== index);
        state.workspace.productDraft.attributes = Object.fromEntries(next);
        renderAttributeEditor();
      });
      row.append(keyInput, valueInput, remove);
      return row;
    });
    replaceChildren(els.productAttributesEditor, rows);
  }

  function linkArrayFromValue(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
    const text = String(value || '').trim();
    return text ? [text] : [];
  }

  function renderProductLinkList(node, title, links) {
    if (!node || !doc || typeof doc.createElement !== 'function') return;
    const values = linkArrayFromValue(links);
    const box = doc.createElement('div');
    box.className = 'product-link-box';
    const heading = doc.createElement('strong');
    heading.textContent = title;
    box.append(heading);
    if (!values.length) {
      const empty = doc.createElement('span');
      empty.className = 'product-link-empty';
      empty.textContent = '暂无链接';
      box.append(empty);
      replaceChildren(node, [box]);
      return;
    }
    const list = doc.createElement('div');
    list.className = 'product-link-chip-list';
    values.forEach((url, index) => {
      const anchor = doc.createElement('a');
      anchor.className = 'product-link-chip';
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      anchor.textContent = `${title} ${index + 1}`;
      list.append(anchor);
    });
    box.append(list);
    replaceChildren(node, [box]);
  }

  function renderProductOverviewSummary(product) {
    if (!els.productOverviewSummary || !doc || typeof doc.createElement !== 'function') return;
    const metrics = [
      ['商品名称 / Name', product?.name || '--'],
      ['商品ID / Product ID', product?.product_id || '--'],
      ['分类 / Category', product?.category || '--'],
      ['价格 / Price', product?.price === '' || product?.price == null ? '--' : `¥${product.price}`],
      ['库存 / Stock', product?.stock === '' || product?.stock == null ? '--' : String(product.stock)],
      ['状态 / Status', product?.status || '--'],
      ['来源 / Source', product?.source || '--']
    ];
    const items = metrics.map(([label, value]) => {
      const row = doc.createElement('div');
      row.className = 'product-overview-item';
      const labelNode = doc.createElement('span');
      labelNode.className = 'product-overview-label';
      labelNode.textContent = label;
      const valueNode = doc.createElement('strong');
      valueNode.className = 'product-overview-value';
      valueNode.textContent = value;
      row.append(labelNode, valueNode);
      return row;
    });
    replaceChildren(els.productOverviewSummary, items);
  }

  function renderProductSkuSummary(product) {
    if (!els.productSkuSummary || !doc || typeof doc.createElement !== 'function') return;
    const skus = Array.isArray(product?.attributes?.skus) ? product.attributes.skus : [];
    if (!skus.length) {
      const empty = doc.createElement('div');
      empty.className = 'product-sku-empty';
      empty.textContent = '暂无 SKU 数据';
      replaceChildren(els.productSkuSummary, [empty]);
      return;
    }
    const rows = skus.slice(0, 20).map((sku, index) => {
      const item = doc.createElement('div');
      item.className = 'product-sku-row';
      const name = doc.createElement('strong');
      name.textContent = sku.sku_name || sku.sku_id || `SKU ${index + 1}`;
      const meta = doc.createElement('span');
      meta.textContent = [
        sku.color ? `颜色 ${sku.color}` : '',
        sku.size ? `尺码 ${sku.size}` : '',
        sku.group_price != null ? `拼单价 ¥${sku.group_price}` : '',
        sku.stock != null ? `库存 ${sku.stock}` : '',
        sku.status ? `状态 ${sku.status}` : ''
      ].filter(Boolean).join(' · ') || '暂无更多信息';
      item.append(name, meta);
      return item;
    });
    replaceChildren(els.productSkuSummary, rows);
  }

  function renderProductDetail() {
    if (!state.workspace.productDraft) ensureProductDraft(null);
    const draft = state.workspace.productDraft;
    setText(els.productDrawerTitle, draft.name || draft.product_id || '未选择商品');
    setValue(els.productIdInput, draft.product_id);
    setValue(els.productNameInput, draft.name);
    setValue(els.productCategoryInput, draft.category);
    setValue(els.productPriceInput, draft.price);
    setValue(els.productStockInput, draft.stock);
    setValue(els.productImageUrlInput, draft.image_url);
    setValue(els.productStatusSelect, draft.status);
    setValue(els.productSourceSelect, draft.source);
    // 同步状态：优先展示 search_snapshot.display_attributes，fallback 到 sync_status
    const displayAttr = draft.search_snapshot?.display_attributes || {};
    setText(els.productSyncStatusDisplay, displayAttr.status || draft.sync_status || '--');
    setText(els.productSyncErrorDisplay, displayAttr.error || draft.sync_error || '--');
    setText(els.productLastSyncAtDisplay, displayAttr.last_sync || draft.last_sync_at || '--');
    renderProductOverviewSummary(draft);
    renderProductLinkList(
      els.productMediaLinks,
      '主图链接 / Main media',
      [draft.image_url, ...(Array.isArray(draft.attributes?.gallery) ? draft.attributes.gallery : [])].filter(Boolean)
    );
    renderProductLinkList(els.productDetailLinks, '详情图链接 / Detail media', draft.attributes?.detail_images);
    renderProductSkuSummary(draft);
    renderAttributeEditor();
  }

  function renderProductPagination() {
    if (!els.productLibraryPagination || !doc || typeof doc.createElement !== 'function') return;
    const pag = state.workspace.productPagination;
    const page = pag.page || 1;
    const totalPages = pag.total_pages || 1;
    const total = pag.total || 0;

    const container = doc.createElement('div');
    if (container.style) {
      container.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;width:100%;';
    }

    const info = doc.createElement('span');
    info.textContent = `共 ${total} 条 · 第 ${page} / ${totalPages} 页`;

    const actions = doc.createElement('div');
    actions.className = 'product-pagination-actions';

    const prevBtn = doc.createElement('button');
    prevBtn.textContent = '上一页';
    prevBtn.disabled = page <= 1;
    addListener(prevBtn, 'click', () => {
      if (page <= 1) return;
      state.workspace.productScope.page = page - 1;
      loadProductLibrary().catch((error) => addDiagnosticEvent('pagination error', error.message || String(error)));
    });

    const pageInfo = doc.createElement('button');
    pageInfo.className = 'active';
    pageInfo.textContent = String(page);

    const nextBtn = doc.createElement('button');
    nextBtn.textContent = '下一页';
    nextBtn.disabled = page >= totalPages;
    addListener(nextBtn, 'click', () => {
      if (page >= totalPages) return;
      state.workspace.productScope.page = page + 1;
      loadProductLibrary().catch((error) => addDiagnosticEvent('pagination error', error.message || String(error)));
    });

    actions.append(prevBtn, pageInfo, nextBtn);
    container.append(info, actions);
    replaceChildren(els.productLibraryPagination, [container]);
  }

  function normalizeProductPaneCopy() {
    setValue(els.productScopePlatformSelect, state.workspace.productScope.platform || 'pdd');
    if (els.productScopePlatformSelect?.options?.length) {
      const labels = { pdd: '拼多多', qn: '淘宝天猫', douyin: '抖店', '1688': '1688' };
      for (const option of Array.from(els.productScopePlatformSelect.options)) {
        option.textContent = labels[option.value] || option.textContent;
      }
    }
    if (els.loadProductsButton) {
      els.loadProductsButton.textContent = '进入商品库';
    }
    if (els.addProductButton) {
      els.addProductButton.textContent = '新增商品';
    }
    if (els.taskProgressButton) {
      els.taskProgressButton.textContent = '重建搜索';
    }
  }

  function renderProductCommandState() {
    const enabled = hasProductScope();
    for (const node of [
      els.fetchProductsButton,
      els.addProductButton,
      els.batchDeleteButton,
      els.taskProgressButton,
      els.refreshProductsButton,
      els.uploadProductsButton,
      els.selectAllProductsButton,
      els.runProductImportButton,
      els.saveProductButton,
      els.deleteProductButton,
      els.rebuildProductSearchButton
    ]) {
      setDisabled(node, !enabled);
    }
  }

  function renderProductLibrary() {
    setActive(els.productImportModal, state.workspace.productImportOpen);
    renderProductCommandState();
    if (!hasProductScope()) {
      setText(els.productLibrarySummary, '请先选择店铺');
      if (els.productLibraryGrid && doc && typeof doc.createElement === 'function') {
        const empty = doc.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '<div class="empty-state-icon">🏪</div><div class="empty-state-title">请先选择店铺</div><div class="empty-state-desc">在左侧选择平台和店铺后再进入商品库</div>';
        replaceChildren(els.productLibraryGrid, [empty]);
      }
      if (els.productTableEmpty) setDisplay(els.productTableEmpty, 'none');
      renderProductPagination();
      ensureProductDraft(null);
      renderProductDetail();
      return;
    }

    const scope = currentProductScope();
    setText(
      els.productLibrarySummary,
      `${formatShopScopeLabel(scope)} · 共 ${state.workspace.productPagination.total} 个商品 · 已选 ${state.workspace.selectedProductIds.size}`
    );
    if (!els.productLibraryGrid || !doc || typeof doc.createElement !== 'function') return;

    // 批量操作栏
    const hasSelection = state.workspace.selectedProductIds.size > 0;
    if (els.productBatchBar) setDisplay(els.productBatchBar, hasSelection ? 'flex' : 'none');
    if (els.productBatchCount) setText(els.productBatchCount, `已选 ${state.workspace.selectedProductIds.size} 项`);

    // 渲染表格行
    if (state.workspace.productLibrary.length === 0) {
      replaceChildren(els.productLibraryGrid, []);
      if (els.productTableEmpty) {
        setDisplay(els.productTableEmpty, 'grid');
      }
    } else {
      if (els.productTableEmpty) setDisplay(els.productTableEmpty, 'none');
      const rows = state.workspace.productLibrary.map((product) => buildProductTableRow(product));
      replaceChildren(els.productLibraryGrid, rows);
    }

    // 表头全选复选框
    if (els.productTableHeaderCheck) {
      const allSelected = state.workspace.productLibrary.length > 0 &&
        state.workspace.productLibrary.every((p) => state.workspace.selectedProductIds.has(p.id));
      els.productTableHeaderCheck.checked = allSelected;
      els.productTableHeaderCheck.indeterminate = hasSelection && !allSelected;
    }

    if (!state.workspace.activeProductId && state.workspace.productLibrary[0]) {
      state.workspace.activeProductId = state.workspace.productLibrary[0].id;
      ensureProductDraft(state.workspace.productLibrary[0]);
    }
    renderProductPagination();
    renderProductDetail();
  }

  // 构建单行表格
  function buildProductTableRow(product) {
    const isActive = product.id === state.workspace.activeProductId;
    const isSelected = state.workspace.selectedProductIds.has(product.id);

    const row = doc.createElement('div');
    row.className = `product-table-row${isActive ? ' active' : ''}`;

    // 复选框
    const cellCheck = doc.createElement('div');
    cellCheck.className = 'product-table-cell col-check';
    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isSelected;
    addListener(checkbox, 'click', (event) => event?.stopPropagation?.());
    addListener(checkbox, 'change', () => {
      if (checkbox.checked) state.workspace.selectedProductIds.add(product.id);
      else state.workspace.selectedProductIds.delete(product.id);
      renderProductLibrary();
    });
    cellCheck.append(checkbox);

    // 商品信息（缩略图 + 名称 + ID）
    const cellInfo = doc.createElement('div');
    cellInfo.className = 'product-table-cell col-info';
    const infoCell = doc.createElement('div');
    infoCell.className = 'product-info-cell';
    const thumb = doc.createElement('div');
    thumb.className = 'product-info-thumb';
    if (product.image_url) {
      const img = doc.createElement('img');
      img.src = product.image_url;
      img.alt = product.name || '';
      img.loading = 'lazy';
      img.onerror = function () { this.style.display = 'none'; thumb.innerHTML = '<span class="product-info-thumb-fallback">📦</span>'; };
      thumb.append(img);
    } else {
      thumb.innerHTML = '<span class="product-info-thumb-fallback">📦</span>';
    }
    const text = doc.createElement('div');
    text.className = 'product-info-text';
    const nameEl = doc.createElement('span');
    nameEl.className = 'product-info-name';
    nameEl.textContent = product.name || '未命名商品';
    const idEl = doc.createElement('span');
    idEl.className = 'product-info-id';
    idEl.textContent = product.product_id || '--';
    text.append(nameEl, idEl);
    infoCell.append(thumb, text);
    cellInfo.append(infoCell);

    // 价格
    const cellPrice = doc.createElement('div');
    cellPrice.className = 'product-table-cell col-price';
    cellPrice.textContent = product.price != null ? `¥${Number(product.price).toFixed(2)}` : '--';

    // 库存
    const cellStock = doc.createElement('div');
    cellStock.className = 'product-table-cell col-stock';
    cellStock.textContent = product.stock != null ? String(product.stock) : '--';

    // 分类
    const cellCategory = doc.createElement('div');
    cellCategory.className = 'product-table-cell col-category';
    cellCategory.textContent = product.category || '--';

    // 状态标签
    const cellStatus = doc.createElement('div');
    cellStatus.className = 'product-table-cell col-status';
    const statusBadge = doc.createElement('span');
    const statusMap = { active: '销售中', inactive: '已下架', deleted: '已删除' };
    const statusText = statusMap[product.status] || product.status || '--';
    statusBadge.className = `product-status-badge status-${product.status || 'active'}`;
    statusBadge.innerHTML = `<span class="product-status-dot ${product.status || 'active'}"></span>${statusText}`;
    cellStatus.append(statusBadge);

    // 同步状态
    const cellSync = doc.createElement('div');
    cellSync.className = 'product-table-cell col-sync';
    const syncBadge = doc.createElement('span');
    const syncStatus = product.sync_status || 'pending';
    const syncMap = { synced: '已同步', pending: '待同步', failed: '同步失败' };
    syncBadge.className = `product-sync-badge ${syncStatus}`;
    syncBadge.textContent = syncMap[syncStatus] || syncStatus;
    cellSync.append(syncBadge);

    // 操作按钮
    const cellActions = doc.createElement('div');
    cellActions.className = 'product-table-cell col-actions';
    const actionsWrap = doc.createElement('div');
    actionsWrap.className = 'product-row-actions';
    const editBtn = doc.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'workspace-action';
    editBtn.textContent = '编辑';
    addListener(editBtn, 'click', (event) => {
      event?.stopPropagation?.();
      state.workspace.activeProductId = product.id;
      state.workspace.productDetailMode = 'view';
      ensureProductDraft(product);
      renderProductLibrary();
      renderProductDetail();
      openProductDetailDrawer();
    });
    const delBtn = doc.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'workspace-action danger';
    delBtn.textContent = '删除';
    addListener(delBtn, 'click', (event) => {
      event?.stopPropagation?.();
      state.workspace.activeProductId = product.id;
      ensureProductDraft(product);
      deleteActiveProduct().catch((error) => addDiagnosticEvent('product delete error', error.message || String(error)));
    });
    actionsWrap.append(editBtn, delBtn);
    cellActions.append(actionsWrap);

    row.append(cellCheck, cellInfo, cellPrice, cellStock, cellCategory, cellStatus, cellSync, cellActions);

    // 点击行打开详情
    addListener(row, 'click', (event) => {
      if (event?.target?.tagName === 'INPUT' || event?.target?.tagName === 'BUTTON') return;
      state.workspace.activeProductId = product.id;
      state.workspace.productDetailMode = 'view';
      ensureProductDraft(product);
      renderProductLibrary();
      renderProductDetail();
      openProductDetailDrawer();
    });

    return row;
  }

  // 打开/关闭详情抽屉
  function openProductDetailDrawer() {
    if (els.productDetailPanel) els.productDetailPanel.classList.add('open');
    if (els.productDetailOverlay) els.productDetailOverlay.classList.add('open');
    // 打开时从服务端拉取最新详情（含 search_snapshot）
    const draft = state.workspace.productDraft;
    if (draft?.product_id) {
      loadProductDetail(draft.product_id).catch((error) =>
        addDiagnosticEvent('product detail error', error.message || String(error))
      );
    }
  }

  function closeProductDetailDrawer() {
    if (els.productDetailPanel) els.productDetailPanel.classList.remove('open');
    if (els.productDetailOverlay) els.productDetailOverlay.classList.remove('open');
  }

  async function loadProductLibrary() {
    readProductScopeForm();
    if (!hasProductScope()) {
      renderProductLibrary();
      return;
    }
    const scope = currentProductScope();
    const params = new URLSearchParams({
      q: state.workspace.productScope.q,
      category: state.workspace.productScope.category,
      status: state.workspace.productScope.status,
      page: String(state.workspace.productScope.page),
      page_size: String(state.workspace.productScope.pageSize),
      sort_by: state.workspace.productScope.sortBy,
      sort_order: state.workspace.productScope.sortOrder
    });
    const payload = await tmagentRequest(`/api/shops/${encodeURIComponent(scope.platform)}/${encodeURIComponent(scope.shopId)}/products?${params.toString()}`);
    state.workspace.productLibrary = Array.isArray(payload.items) ? payload.items : [];
    state.workspace.productPagination = payload.pagination || { page: 1, page_size: 20, total: 0, total_pages: 1 };
    state.workspace.selectedProductIds.clear();
    state.workspace.activeProductId = state.workspace.productLibrary[0]?.id || null;
    ensureProductDraft(state.workspace.productLibrary[0] || null);
    addDiagnosticEvent('product load', `${scope.platform}/${scope.shopId} loaded ${state.workspace.productLibrary.length}`);
    renderProductLibrary();
  }

  async function loadProductDetail(productId) {
    if (!productId) return;
    const scope = requireProductScope('获取商品详情');
    const result = await tmagentRequest(
      `/api/shops/${encodeURIComponent(scope.platform)}/${encodeURIComponent(scope.shopId)}/products/${encodeURIComponent(productId)}`
    );
    const detail = result.item || result;
    // 合并详情到列表缓存
    const idx = state.workspace.productLibrary.findIndex(p => p.product_id === productId);
    if (idx >= 0) {
      state.workspace.productLibrary[idx] = { ...state.workspace.productLibrary[idx], ...detail };
    }
    ensureProductDraft(detail);
    renderProductDetail();
  }

  function readProductDraftForm() {
    if (!state.workspace.productDraft) ensureProductDraft(null);
    state.workspace.productDraft.product_id = String(els.productIdInput?.value || '').trim();
    state.workspace.productDraft.name = String(els.productNameInput?.value || '').trim();
    state.workspace.productDraft.category = String(els.productCategoryInput?.value || '').trim();
    state.workspace.productDraft.price = String(els.productPriceInput?.value || '').trim();
    state.workspace.productDraft.stock = String(els.productStockInput?.value || '').trim();
    state.workspace.productDraft.image_url = String(els.productImageUrlInput?.value || '').trim();
    state.workspace.productDraft.status = String(els.productStatusSelect?.value || 'active').trim();
    state.workspace.productDraft.source = String(els.productSourceSelect?.value || 'manual').trim();
  }

  async function saveProductDraft() {
    readProductScopeForm();
    if (!hasProductScope()) throw new Error('请先选择当前店铺');
    readProductDraftForm();
    const scope = currentProductScope();
    const draft = state.workspace.productDraft;
    const payload = {
      name: draft.name,
      category: draft.category || null,
      price: draft.price === '' ? null : Number(draft.price),
      stock: draft.stock === '' ? null : Number(draft.stock),
      attributes: draft.attributes,
      image_url: draft.image_url || null,
      status: draft.status,
      source: draft.source
    };
    if (!draft.id) {
      const created = await tmagentRequest(
        `/api/shops/${encodeURIComponent(scope.platform)}/${encodeURIComponent(scope.shopId)}/products`,
        {
          method: 'POST',
          body: JSON.stringify({
            product_id: draft.product_id,
            ...payload
          })
        }
      );
      addDiagnosticEvent('product create', draft.product_id || draft.name);
      state.workspace.activeProductId = created?.item?.id || null;
    } else {
      await tmagentRequest(
        `/api/shops/${encodeURIComponent(scope.platform)}/${encodeURIComponent(scope.shopId)}/products/${encodeURIComponent(draft.product_id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(payload)
        }
      );
      addDiagnosticEvent('product patch', draft.product_id || draft.name);
    }
    await loadProductLibrary();
  }

  async function deleteActiveProduct() {
    const draft = state.workspace.productDraft;
    if (!draft?.product_id) return;
    const scope = requireProductScope('删除商品');
    await tmagentRequest(
      `/api/shops/${encodeURIComponent(scope.platform)}/${encodeURIComponent(scope.shopId)}/products/${encodeURIComponent(draft.product_id)}`,
      { method: 'DELETE' }
    );
    addDiagnosticEvent('product delete', draft.product_id);
    await loadProductLibrary();
  }

  async function rebuildActiveProductSearch() {
    const draft = state.workspace.productDraft;
    if (!draft?.product_id) return;
    const scope = requireProductScope('重建搜索');
    await tmagentRequest(
      `/api/shops/${encodeURIComponent(scope.platform)}/${encodeURIComponent(scope.shopId)}/products/${encodeURIComponent(draft.product_id)}/rebuild-search`,
      { method: 'POST' }
    );
    addDiagnosticEvent('product rebuild', draft.product_id);
    await loadProductLibrary();
  }

  async function deleteSelectedProducts() {
    const ids = Array.from(state.workspace.selectedProductIds);
    if (!ids.length) return;
    const scope = requireProductScope('批量删除商品');
    await tmagentRequest(
      `/api/shops/${encodeURIComponent(scope.platform)}/${encodeURIComponent(scope.shopId)}/products/delete-batch`,
      {
        method: 'POST',
        body: JSON.stringify({ product_ids: ids })
      }
    );
    addDiagnosticEvent('product delete batch', `${ids.length} items`);
    await loadProductLibrary();
  }

  async function rebuildSelectedProducts() {
    const scope = requireProductScope('批量重建搜索');
    const ids = Array.from(state.workspace.selectedProductIds);
    for (const id of ids) {
      const item = state.workspace.productLibrary.find((product) => product.id === id);
      if (!item) continue;
      await tmagentRequest(
        `/api/shops/${encodeURIComponent(scope.platform)}/${encodeURIComponent(scope.shopId)}/products/${encodeURIComponent(item.product_id)}/rebuild-search`,
        { method: 'POST' }
      );
    }
    if (ids.length) addDiagnosticEvent('product rebuild batch', `${ids.length} items`);
    await loadProductLibrary();
  }

  function toBatchUpsertItem(product) {
    return {
      product_id: product.product_id,
      name: product.name || null,
      category: product.category || null,
      price: product.price == null || product.price === '' ? null : Number(product.price),
      stock: product.stock == null || product.stock === '' ? null : Number(product.stock),
      attributes: product.attributes || {},
      image_url: product.image_url || null
    };
  }

  async function uploadCurrentProductsToServer() {
    const scope = requireProductScope('上传商品数据');
    const source = state.workspace.selectedProductIds.size
      ? state.workspace.productLibrary.filter((product) => state.workspace.selectedProductIds.has(product.id))
      : state.workspace.productLibrary;
    if (!source.length) throw new Error('当前没有可上传的商品数据');
    const items = source.map(toBatchUpsertItem).filter((item) => item.product_id);
    const payload = await tmagentRequest(
      `/api/shops/${encodeURIComponent(scope.platform)}/${encodeURIComponent(scope.shopId)}/products/batch`,
      {
        method: 'POST',
        body: JSON.stringify({ items })
      }
    );
    addDiagnosticEvent('product upload', `${scope.shopId} uploaded ${payload.total || items.length}`);
    setText(els.productLibrarySummary, `已上传 ${items.length} 个商品到服务器`);
    await loadProductLibrary();
  }

  async function importProductsBatch() {
    const scope = requireProductScope('导入商品');
    const file = els.productCsvFileInput?.files?.[0] || null;
    if (!file) throw new Error('请选择 CSV 文件');
    const buffer = typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : new TextEncoder().encode(await file.text()).buffer;
    const decoded = decodeCsvFileBuffer(buffer);
    const items = aggregateCsvItems(decoded.rows);
    if (!items.length) throw new Error('CSV 里没有可导入的上架商品。');
    const payload = await tmagentRequest(
      `/api/shops/${encodeURIComponent(scope.platform)}/${encodeURIComponent(scope.shopId)}/products/batch`,
      {
        method: 'POST',
        body: JSON.stringify({ items })
      }
    );
    setText(els.productImportResult, `导入完成：${items.length} 个商品，编码 ${decoded.encoding}`);
    if (els.productCsvFileInput) {
      els.productCsvFileInput.value = '';
    }
    setText(els.productCsvFileName, '未选择文件');
    state.workspace.productImportOpen = false;
    setActive(els.productImportModal, false);
    addDiagnosticEvent('product import', `${scope.shopId} total ${payload.total || 0}`);
    await loadProductLibrary();
  }

  function nextRequestId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  }

  function getPreferredConversationId() {
    return String(
      els.sessionCcodeInput?.value ||
      els.orderConversationInput?.value ||
      state.workspace.sessionTools.currentConv?.ccode ||
      state.activeConversationId ||
      ''
    ).trim();
  }

  function formatHistoryMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) return '暂无历史消息';
    return messages.slice(-20).map((item) => {
      const content = item?.content;
      const text = typeof content === 'string'
        ? content
        : (content?.text || item?.text || stringify(content || item));
      const msgId = item?.msgId || item?.msg_id || item?.id || '--';
      return `${msgId} | ${truncate(text, 120)}`;
    }).join('\n');
  }

  function renderSessionTools() {
    const toolState = state.workspace.sessionTools;
    const csr = toolState.currentCsr;
    const conv = toolState.currentConv;
    const historyMeta = toolState.remoteHistoryMeta;
    const orderResult = toolState.orderResult;

    setValue(
      els.currentCsrDisplay,
      csr ? `${csr.nick || '--'}${csr.targetId ? ` | ${csr.targetId}` : ''}` : ''
    );
    setValue(
      els.currentConvDisplay,
      conv ? `${conv.nick || '--'}${conv.ccode ? ` | ${conv.ccode}` : ''}` : ''
    );
    if (conv?.ccode && !String(els.sessionCcodeInput?.value || '').trim()) setValue(els.sessionCcodeInput, conv.ccode);
    if (conv?.ccode && !String(els.orderConversationInput?.value || '').trim()) setValue(els.orderConversationInput, conv.ccode);

    const historyText = historyMeta?.error
      ? `拉取失败: ${historyMeta.error}`
      : `${historyMeta?.ccode ? `会话 ${historyMeta.ccode}` : '当前会话'}\n${formatHistoryMessages(toolState.remoteHistory)}`;
    setText(els.remoteHistoryResult, historyText);
    setText(els.orderToolResult, orderResult ? stringify(orderResult) : '尚未执行');
  }

  async function loadCurrentCsr() {
    if (typeof api.getCurrentPddCsr !== 'function') return;
    setValue(els.currentCsrDisplay, '读取中...');
    await api.getCurrentPddCsr();
  }

  async function loadCurrentConv() {
    if (typeof api.getCurrentPddConv !== 'function') return;
    setValue(els.currentConvDisplay, '读取中...');
    await api.getCurrentPddConv({ conversationId: getPreferredConversationId() });
  }

  async function loadRemoteHistory() {
    if (typeof api.getPddRemoteHistory !== 'function') return;
    const ccode = getPreferredConversationId();
    const limit = Number(els.remoteHistoryLimitInput?.value || 20);
    setText(els.remoteHistoryResult, '拉取中...');
    await api.getPddRemoteHistory({
      conversationId: ccode,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 20
    });
  }

  function rememberOrderRequest(kind, requestId) {
    state.workspace.sessionTools.pendingRequests[kind] = requestId;
  }

  async function queryOrderRemark() {
    if (typeof api.queryPddOrderRemark !== 'function') return;
    const orderId = String(els.orderIdInput?.value || '').trim();
    if (!orderId) {
      setText(els.orderToolResult, '请输入订单号');
      return;
    }
    const requestId = nextRequestId('query-order-remark');
    rememberOrderRequest('orderRemarkQuery', requestId);
    setText(els.orderToolResult, '查询中...');
    await api.queryPddOrderRemark({
      conversationId: getPreferredConversationId(),
      params: { requestId, orderId }
    });
  }

  async function saveOrderRemark() {
    if (typeof api.setPddOrderRemark !== 'function') return;
    const orderId = String(els.orderIdInput?.value || '').trim();
    if (!orderId) {
      setText(els.orderToolResult, '请输入订单号');
      return;
    }
    const requestId = nextRequestId('set-order-remark');
    rememberOrderRequest('orderRemarkSave', requestId);
    setText(els.orderToolResult, '保存中...');
    await api.setPddOrderRemark({
      conversationId: getPreferredConversationId(),
      params: {
        requestId,
        orderId,
        remark: String(els.orderRemarkInput?.value || '').trim(),
        tagColor: String(els.orderTagColorSelect?.value || 'RED').trim(),
        tagName: String(els.orderTagNameInput?.value || '').trim()
      }
    });
  }

  async function sendOrderMessage() {
    if (typeof api.sendPddOrderMessage !== 'function') return;
    const orderId = String(els.orderIdInput?.value || '').trim();
    const text = String(els.orderMessageInput?.value || '').trim();
    if (!orderId || !text) {
      setText(els.orderToolResult, '请输入订单号和订单消息');
      return;
    }
    const requestId = nextRequestId('send-order-message');
    rememberOrderRequest('orderMessageSend', requestId);
    setText(els.orderToolResult, '发送中...');
    await api.sendPddOrderMessage({
      conversationId: getPreferredConversationId(),
      params: { requestId, orderId, text }
    });
  }

  function renderWorkspaceTabs() {
    const tabs = [
      ['session-tools', els.tabSessionTools, els.sessionToolsPane],
      ['ai-settings', els.tabAiSettings, els.aiSettingsPane],
      ['quick-replies', els.tabQuickReplies, els.quickRepliesPane],
      ['workspace-logs', els.tabWorkspaceLogs, els.workspaceLogsPane]
    ];
    for (const [key, tab, pane] of tabs) {
      const active = state.workspace.activeTab === key;
      setActive(tab, active);
      setActive(pane, active);
      if (pane) pane.hidden = !active;
    }
    setActive(els.productLibraryPane, true);
    if (els.productLibraryPane) els.productLibraryPane.hidden = false;
  }

  function renderToolsDrawer() {
    const activePanel = state.workspace.sidePanel;
    const showDrawer = activePanel === 'tools' || activePanel === 'ai-settings';
    setActive(els.toolsDrawer, showDrawer);
    if (els.toolsDrawer) {
      els.toolsDrawer.hidden = !showDrawer;
    }
    const sideDrawer = byId('opsSideDrawer');
    if (sideDrawer?.classList?.toggle) {
      sideDrawer.classList.toggle('active', Boolean(state.workspace.toolsOpen));
    }
    const sideDrawerBody = sideDrawer && typeof sideDrawer.querySelector === 'function'
      ? sideDrawer.querySelector('.ops-side-drawer-body')
      : null;
    if (sideDrawerBody) {
      sideDrawerBody.hidden = !state.workspace.toolsOpen;
    }
    const diagnosticsPanel = byId('opsDiagnosticsPanel');
    if (diagnosticsPanel) {
      diagnosticsPanel.hidden = activePanel !== 'diagnostics';
    }
    for (const [key, id] of [['diagnostics', 'opsShowDiagnostics'], ['tools', 'opsShowTools'], ['ai-settings', 'opsShowAiSettings']]) {
      const button = byId(id);
      if (button?.classList?.toggle) {
        button.classList.toggle('active', activePanel === key);
      }
    }
    if (els.workspaceDrawerTitle) {
      els.workspaceDrawerTitle.textContent = activePanel === 'ai-settings' ? '设置' : '工具';
    }
  }

  function renderPlatformFilters() {
    for (const button of queryAll('.platform-filter-chip')) {
      setActive(button, false);
    }
  }

  function readAiSettingsForm() {
    state.workspace.aiSettings = {
      ...state.workspace.aiSettings,
      provider: 'tmagent',
      enabled: Boolean(els.tmagentEnabledInput?.checked),
      baseUrl: String(els.tmagentBaseUrlInput?.value || 'https://xingqiao.taluo.club').trim() || 'https://xingqiao.taluo.club',
      merchantName: String(els.tmagentMerchantNameInput?.value || '').trim(),
      tenantId: String(els.tmagentTenantIdInput?.value || '').trim(),
      apiKey: String(els.tmagentApiKeyInput?.value || '').trim(),
      headerName: 'X-API-Key'
    };
  }

  function maskApiKey(value) {
    const text = String(value || '').trim();
    if (!text) return '未设置';
    if (text.length <= 4) return '*'.repeat(text.length);
    if (text.length <= 8) return `${text.slice(0, 2)}***${text.slice(-2)}`;
    return `${text.slice(0, 6)}...${text.slice(-4)}`;
  }

  function renderTmagentDiagnosticSummary() {
    const settings = state.workspace.aiSettings;
    setText(els.tmagentEnabledSummary, settings.enabled ? '已启用' : '已禁用');
    setText(els.tmagentBaseUrlSummary, settings.baseUrl || '未设置');
    setText(els.tmagentMerchantNameSummary, settings.merchantName || '未设置');
    setText(els.tmagentTenantIdSummary, settings.tenantId || '未设置');
    setText(els.tmagentApiKeySummary, maskApiKey(settings.apiKey));
  }

  function maskApiKeySummary(value) {
    const text = String(value || '').trim();
    if (!text) return '未设置';
    if (text.length <= 4) return '***';
    return `${text.slice(0, 2)}***${text.slice(-2)}`;
  }

  function buildTmagentPayloadPreview(messageText) {
    const settings = state.workspace.aiSettings;
    const activeConversation = state.activeConversationId ? state.conversations.get(state.activeConversationId) : null;
    const buyerId = activeConversation?.id || 'buyer-preview';
    const buyerName = activeConversation?.title || '预览买家';
    return {
      conversation_id: `pdd:${settings.tenantId || 'default'}:${buyerId}`,
      platform: 'pdd',
      shop_id: settings.tenantId || 'default',
      shop_name: settings.merchantName || '',
      buyer_id: buyerId,
      buyer_name: buyerName,
      message_type: 'text',
      message: messageText,
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
    };
  }

  function renderAiSettingsPreview() {
    const settings = state.workspace.aiSettings;
    const previewMessage = String(els.testReplyInput?.value || '').trim() || '这个今天能发吗？';
    const payload = buildTmagentPayloadPreview(previewMessage);
    setText(els.tmagentHeaderPreview, `${settings.headerName}: ${maskApiKey(settings.apiKey)}`);
    setValue(els.tmagentShopIdPreview, settings.tenantId || 'default');
    setValue(els.tmagentShopNamePreview, settings.merchantName || '');
    setValue(els.tmagentEndpointPreview, `${String(settings.baseUrl || '').replace(/\/+$/, '')}/api/orchestrate/chat`);
    setText(els.tmagentPayloadPreview, stringify(payload));
    setText(els.testReplyOutput, `POST /api/orchestrate/chat | ${settings.headerName} | shop_id=${payload.shop_id}`);
    setText(els.tmagentEnabledSummary, settings.enabled ? '已启用' : '已停用');
    setText(els.tmagentBaseUrlSummary, settings.baseUrl);
    setText(els.tmagentMerchantNameSummary, settings.merchantName || '未设置');
    setText(els.tmagentTenantIdSummary, settings.tenantId || 'default');
    setText(els.tmagentApiKeySummary, maskApiKeySummary(settings.apiKey));
  }

  function renderAiSettings() {
    const settings = state.workspace.aiSettings;
    setChecked(els.tmagentEnabledInput, settings.enabled);
    setValue(els.tmagentBaseUrlInput, settings.baseUrl);
    setValue(els.tmagentMerchantNameInput, settings.merchantName);
    setValue(els.tmagentTenantIdInput, settings.tenantId);
    setValue(els.tmagentApiKeyInput, settings.apiKey);
    renderTmagentDiagnosticSummary();
    renderAiSettingsPreview();
  }

  async function hydrateAiSettings() {
    if (typeof api.getAiSettings !== 'function') {
      renderAiSettings();
      return;
    }
    try {
      const saved = await api.getAiSettings();
      state.workspace.aiSettings = {
        ...state.workspace.aiSettings,
        provider: 'tmagent',
        enabled: saved?.enabled !== false,
        baseUrl: String(saved?.baseUrl || 'https://xingqiao.taluo.club'),
        merchantName: String(saved?.merchantName || ''),
        tenantId: String(saved?.tenantId || ''),
        apiKey: String(saved?.apiKey || ''),
        headerName: 'X-API-Key',
        shopOverrides: saved?.shopOverrides || {}
      };
    } catch (error) {
      addDiagnosticEvent('ai settings load error', error.message || String(error));
    }

    // 拉取云端 AI客服配置（agent-config），映射到 aiSettings
    if (typeof api.getAgentConfig === 'function') {
      try {
        const result = await api.getAgentConfig();
        applyAgentConfigToAiSettings(result?.config);
      } catch (error) {
        addDiagnosticEvent('agent config load error', error.message || String(error));
      }
    }

    renderAiSettings();
    renderPlatformList();
  }

  // 将云端 agent-config 映射到本地 aiSettings
  function applyAgentConfigToAiSettings(config) {
    if (!config || typeof config !== 'object') return;
    const settings = state.workspace.aiSettings;
    // 映射通用字段
    if (config.soul_name !== undefined) settings.soulName = String(config.soul_name);
    if (config.soul_prompt !== undefined) settings.soulPrompt = String(config.soul_prompt);
    if (config.llm_temperature !== undefined) settings.llmTemperature = Number(config.llm_temperature);
    if (config.llm_max_tokens !== undefined) settings.llmMaxTokens = Number(config.llm_max_tokens);
    if (config.reply_strategy !== undefined) settings.replyStrategy = String(config.reply_strategy);
    if (config.max_context_messages !== undefined) settings.maxContextMessages = Number(config.max_context_messages);
    if (config.agent_type !== undefined) settings.agentType = String(config.agent_type);
    if (config.agent_id !== undefined) settings.agentId = String(config.agent_id);
    if (config.enabled !== undefined) settings.enabled = Boolean(config.enabled);
    // 映射店铺级别覆盖配置
    if (config.shop_overrides && typeof config.shop_overrides === 'object') {
      const merged = { ...(settings.shopOverrides || {}) };
      for (const [key, override] of Object.entries(config.shop_overrides)) {
        if (override && typeof override === 'object') {
          merged[key] = {
            platform: String(override.platform || key.split('::')[0] || ''),
            shopId: String(override.shopId || key.split('::').slice(1).join('::') || ''),
            shopName: String(override.shopName || ''),
            enabled: override.enabled !== false,
            updatedAt: Number(override.updatedAt) || Date.now()
          };
        }
      }
      settings.shopOverrides = merged;
    }
    addDiagnosticEvent('agent config mapped', `soul: ${settings.soulName || '--'}, strategy: ${settings.replyStrategy || '--'}`);
  }

  function renderWorkspaceLogs() {
    if (!els.workspaceLogsPane || !doc || typeof doc.createElement !== 'function') return;
    const logHost = typeof els.workspaceLogsPane.querySelector === 'function'
      ? els.workspaceLogsPane.querySelector('.workspace-log-list')
      : null;
    if (!logHost) return;
    const items = state.diagnostics.events.slice(0, 10).map((event) => {
      const item = doc.createElement('div');
      item.className = 'diagnostic-event';
      item.textContent = `${timeLabel(event.timestamp)} ${event.label} - ${event.detail}`;
      return item;
    });
    replaceChildren(els.workspaceLogsPane.querySelector('.workspace-log-list') || logHost, items);
  }

  function setActiveTab(tabKey) {
    state.workspace.activeTab = tabKey;
    state.workspace.drawerMode = 'tools';
    state.workspace.sidePanel = tabKey === 'ai-settings' ? 'ai-settings' : 'tools';
    state.workspace.toolsOpen = true;
    renderWorkspaceTabs();
    renderToolsDrawer();
  }

  function toggleToolsDrawer() {
    if (state.workspace.sidePanel === 'tools' && state.workspace.toolsOpen) {
      state.workspace.toolsOpen = false;
      state.workspace.sidePanel = null;
    } else {
      state.workspace.drawerMode = 'tools';
      state.workspace.activeTab = 'session-tools';
      state.workspace.sidePanel = 'tools';
      state.workspace.toolsOpen = true;
    }
    renderWorkspaceTabs();
    renderToolsDrawer();
  }

  function toggleProductDrawer() {
    state.workspace.drawerMode = 'product';
    state.workspace.toolsOpen = false;
    state.workspace.sidePanel = null;
    renderWorkspaceTabs();
    renderToolsDrawer();
  }

  function toggleDiagnosticsDrawer() {
    if (state.workspace.sidePanel === 'diagnostics' && state.workspace.toolsOpen) {
      state.workspace.toolsOpen = false;
      state.workspace.sidePanel = null;
    } else {
      state.workspace.sidePanel = 'diagnostics';
      state.workspace.toolsOpen = true;
    }
    renderWorkspaceTabs();
    renderToolsDrawer();
  }

  function toggleAiSettingsDrawer() {
    if (state.workspace.sidePanel === 'ai-settings' && state.workspace.toolsOpen) {
      state.workspace.toolsOpen = false;
      state.workspace.sidePanel = null;
    } else {
      state.workspace.drawerMode = 'tools';
      state.workspace.activeTab = 'ai-settings';
      state.workspace.sidePanel = 'ai-settings';
      state.workspace.toolsOpen = true;
    }
    renderWorkspaceTabs();
    renderToolsDrawer();
  }

  function showProductHome() {
    state.workspace.drawerMode = 'product';
    state.workspace.toolsOpen = false;
    state.workspace.sidePanel = null;
    renderWorkspaceTabs();
    renderToolsDrawer();
  }

  function setupRightColumnLayout() {
    if (!doc || !els.opsPanel || !els.productLibraryPane || !els.toolsDrawer) return;
    const metricNode = els.metricGrid;
    const productNode = els.productLibraryPane;
    const diagnosticsNode = els.diagnosticsPanel;
    const toolsNode = els.toolsDrawer;
    const conversationNode = els.conversationPanel;
    let sideDrawer = byId('opsSideDrawer');

    if (!productNode.classList.contains('ops-product-pane')) {
      productNode.classList.add('ops-product-pane');
    }
    productNode.hidden = false;

    if (!sideDrawer) {
      sideDrawer = doc.createElement('aside');
      sideDrawer.id = 'opsSideDrawer';
      sideDrawer.className = 'ops-side-drawer';
      const handles = doc.createElement('div');
      handles.className = 'ops-side-drawer-handles';
      const diagnosticsHandle = doc.createElement('button');
      diagnosticsHandle.id = 'opsShowDiagnostics';
      diagnosticsHandle.className = 'ops-side-drawer-handle';
      diagnosticsHandle.type = 'button';
      diagnosticsHandle.textContent = '检测';
      addListener(diagnosticsHandle, 'click', toggleDiagnosticsDrawer);
      const toolsHandle = doc.createElement('button');
      toolsHandle.id = 'opsShowTools';
      toolsHandle.className = 'ops-side-drawer-handle';
      toolsHandle.type = 'button';
      toolsHandle.textContent = '工具';
      addListener(toolsHandle, 'click', toggleToolsDrawer);
      const aiHandle = doc.createElement('button');
      aiHandle.id = 'opsShowAiSettings';
      aiHandle.className = 'ops-side-drawer-handle';
      aiHandle.type = 'button';
      aiHandle.textContent = '设置';
      addListener(aiHandle, 'click', toggleAiSettingsDrawer);
      handles.append(diagnosticsHandle, toolsHandle, aiHandle);
      const body = doc.createElement('div');
      body.className = 'ops-side-drawer-body';
      const diagnosticsWrap = doc.createElement('div');
      diagnosticsWrap.id = 'opsDiagnosticsPanel';
      diagnosticsWrap.className = 'ops-diagnostics-panel';
      sideDrawer.append(handles, body);
      body.append(diagnosticsWrap, toolsNode);
    }

    const sideDrawerBody = sideDrawer.querySelector('.ops-side-drawer-body');
    const diagnosticsWrap = byId('opsDiagnosticsPanel');
    if (productNode.parentNode !== els.opsPanel) {
      els.opsPanel.prepend(productNode);
    }
    if (metricNode && diagnosticsWrap && metricNode.parentNode !== diagnosticsWrap) {
      diagnosticsWrap.append(metricNode);
    }
    for (const node of [diagnosticsNode, conversationNode]) {
      if (node && diagnosticsWrap && node.parentNode !== diagnosticsWrap) {
        diagnosticsWrap.append(node);
      }
    }
    if (toolsNode && sideDrawerBody && toolsNode.parentNode !== sideDrawerBody) {
      sideDrawerBody.append(toolsNode);
    }
    if (sideDrawer.parentNode !== doc.body) {
      doc.body.append(sideDrawer);
    }
  }

  async function saveAiSettings(patch = null) {
    if (patch && typeof patch === 'object') {
      state.workspace.aiSettings = {
        ...state.workspace.aiSettings,
        ...patch
      };
    } else {
      readAiSettingsForm();
    }
    let saved = state.workspace.aiSettings;
    try {
      if (typeof api.saveAiSettings === 'function') {
        saved = await api.saveAiSettings(state.workspace.aiSettings);
        state.workspace.aiSettings = {
          ...state.workspace.aiSettings,
          provider: 'tmagent',
          enabled: saved?.enabled !== false,
          baseUrl: String(saved?.baseUrl || 'https://xingqiao.taluo.club'),
          merchantName: String(saved?.merchantName || ''),
          tenantId: String(saved?.tenantId || ''),
          apiKey: String(saved?.apiKey || ''),
          headerName: 'X-API-Key',
          shopOverrides: saved?.shopOverrides || state.workspace.aiSettings.shopOverrides || {}
        };
      }
      renderAiSettings();
      renderPlatformList();
      addDiagnosticEvent('ai settings', `tenant=${state.workspace.aiSettings.tenantId || 'default'} merchant=${state.workspace.aiSettings.merchantName || '-'}`);
      setText(els.testReplyOutput, 'tmagent 设置已保存到本地。');
    } catch (error) {
      setText(els.testReplyOutput, error.message || String(error));
      addDiagnosticEvent('ai settings save error', error.message || String(error));
    }
  }

  function runTestReply() {
    readAiSettingsForm();
    renderAiSettingsPreview();
  }
  function updateDiagnosticsSnapshot(snapshot) {
    setText(els.diagnosticSnapshotTime, snapshot?.time ? timeLabel(snapshot.time) : '未刷新');
    const helper = snapshot?.summary?.helper;
    const workbench = snapshot?.summary?.workbench;
    setText(els.helperProcessSummary, helper ? `${helper.name} 路 PID ${helper.pid}` : '--');
    setText(els.workbenchProcessSummary, workbench ? `${workbench.name} 路 PID ${workbench.pid}` : '--');

    const receipts = Array.isArray(snapshot?.sendReceipts) ? snapshot.sendReceipts : [];
    setText(
      els.lastSendReceiptSummary,
      receipts[0]
        ? `${receipts[0].status || 'unknown'} ${receipts[0].responseCode || ''}`.trim()
        : '--'
    );

    if (els.sendReceiptList && doc && typeof doc.createElement === 'function') {
      const nodes = receipts.slice(0, 6).map((receipt) => {
        const item = doc.createElement('div');
        item.className = 'diagnostic-event';
        item.textContent = `${receipt.at} ${receipt.status || ''} ${truncate(receipt.content || receipt.ccode || '', 80)}`.trim();
        return item;
      });
      replaceChildren(els.sendReceiptList, nodes);
    }
  }

  async function refreshDiagnosticsSnapshot() {
    if (typeof api.getDiagnosticsSnapshot !== 'function') return null;
    try {
      const snapshot = await api.getDiagnosticsSnapshot();
      updateDiagnosticsSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      addDiagnosticEvent('diagnostics error', error.message || String(error));
      return null;
    }
  }

  async function handleLaunch(launcher, updateStatus, pendingText, failureText) {
    if (typeof launcher !== 'function') return;
    const button = this;
    setDisabled(button, true);
    updateStatus(pendingText, true);
    try {
      const status = await launcher();
      updateStatus(status?.lastError || formatPddStatus(status), Boolean(status?.running));
      if (status?.lastError) addDiagnosticEvent('launch error', status.lastError);
    } catch (error) {
      updateStatus(failureText || error.message || String(error), false);
      if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(error);
    } finally {
      setDisabled(button, false);
    }
  }

  function bindEvents() {
    addListener(els.launchPdd, 'click', function onLaunchPdd() {
      return handleLaunch.call(
        this,
        api.launchPdd,
        (text, active) => updateStatusLabel(els.pddState, text, active),
        'Launching PDD...',
        'PDD launch failed'
      );
    });

    addListener(els.platformPddAction, 'click', function onLaunchPddAction() {
      return handleLaunch.call(
        this,
        api.launchPdd,
        (text, active) => updateStatusLabel(els.pddState, text, active),
        'Launching PDD...',
        'PDD launch failed'
      );
    });

    addListener(els.platformQnAction, 'click', function onLaunchQnAction() {
      return handleLaunch.call(
        this,
        api.launchQn,
        (text, active) => updateStatusLabel(els.qnState, text, active),
        'Launching QN...',
        'QN launch failed'
      );
    });

    addListener(els.composer, 'submit', async (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const conversation = state.activeConversationId ? state.conversations.get(state.activeConversationId) : null;
      const text = String(els.messageInput?.value || '').trim();
      if (!conversation || !text || typeof api.sendMessage !== 'function') return;
      try {
        const result = await api.sendMessage({ targetId: conversation.id, text });
        state.diagnostics.lastSend = result;
        setText(els.lastSendResult, stringify(result));
        appendIncomingMessage({
          message: {
            conversationId: conversation.id,
            direction: 'assistant',
            content: { text },
            senderName: conversation.title
          }
        });
        if (els.messageInput) els.messageInput.value = '';
      } catch (error) {
        setText(els.lastSendResult, error.message || String(error));
        addDiagnosticEvent('send error', error.message || String(error));
      }
    });

    const tabEntries = [
      [els.tabSessionTools, 'session-tools'],
      [els.tabAiSettings, 'ai-settings'],
      [els.tabQuickReplies, 'quick-replies'],
      [els.tabWorkspaceLogs, 'workspace-logs']
    ];
    for (const [button, key] of tabEntries) {
      addListener(button, 'click', () => setActiveTab(key));
    }

    addListener(els.toggleToolsPanel, 'click', toggleToolsDrawer);
    addListener(els.toggleProductPanel, 'click', toggleProductDrawer);

    if (els.platformList && typeof els.platformList.querySelectorAll === 'function') {
      for (const card of Array.from(els.platformList.querySelectorAll('.platform-card'))) {
        const caret = typeof card.querySelector === 'function' ? card.querySelector('.platform-caret') : null;
        addListener(caret, 'click', () => {
          const platform = normalizePlatformKey(card.dataset ? card.dataset.platform : '');
          if (state.workspace.expandedPlatforms.has(platform)) state.workspace.expandedPlatforms.delete(platform);
          else state.workspace.expandedPlatforms.add(platform);
          renderPlatformList();
        });
      }
    }

    for (const node of [
      els.shopSearchInput,
      els.goodsSearchInput,
      els.productStatusFilterSelect,
      els.productSortBySelect,
      els.productSortOrderSelect
    ]) {
      addListener(node, 'change', () => {
        state.workspace.productScope.page = 1;
        loadProductLibrary().catch((error) => addDiagnosticEvent('product load error', error.message || String(error)));
      });
      addListener(node, 'input', () => {
        state.workspace.productScope.page = 1;
      });
    }

    addListener(els.productScopePlatformSelect, 'change', () => {
      state.workspace.productScope.platform = String(els.productScopePlatformSelect?.value || 'pdd').trim();
      state.workspace.productScope.shopId = '';
      state.workspace.productScope.shopName = '';
      state.workspace.productScope.page = 1;
      persistProductScope();
      syncProductScopeForm();
      renderProductLibrary();
    });

    addListener(els.productScopeRegistrySelect, 'change', () => {
      applyProductScopeFromRegistryValue(String(els.productScopeRegistrySelect?.value || '').trim());
      state.workspace.productScope.page = 1;
      renderProductScopeHint();
      renderProductLibrary();
    });

    addListener(els.loadProductsButton, 'click', () => {
      return loadProductLibrary().catch((error) => addDiagnosticEvent('product load error', error.message || String(error)));
    });
    addListener(els.refreshProductsButton, 'click', () => {
      return loadProductLibrary().catch((error) => addDiagnosticEvent('product refresh error', error.message || String(error)));
    });
    addListener(els.uploadProductsButton, 'click', () => {
      return uploadCurrentProductsToServer().catch((error) => addDiagnosticEvent('product upload error', error.message || String(error)));
    });
    addListener(els.fetchProductsButton, 'click', () => {
      if (!hasProductScope()) {
        setText(els.productImportResult, '请先在上方选择当前店铺。');
        renderProductLibrary();
        return;
      }
      state.workspace.productImportOpen = true;
      if (els.productCsvFileInput) {
        els.productCsvFileInput.value = '';
      }
      setText(els.productCsvFileName, '未选择文件');
      setText(els.productImportResult, '请选择 CSV 文件。');
      renderProductScopeHint();
      setActive(els.productImportModal, true);
    });
    addListener(els.chooseProductCsvButton, 'click', () => {
      if (els.productCsvFileInput && typeof els.productCsvFileInput.click === 'function') {
        els.productCsvFileInput.click();
      }
    });
    addListener(els.productCsvFileInput, 'change', () => {
      const file = els.productCsvFileInput?.files?.[0] || null;
      setText(els.productCsvFileName, file ? file.name : '未选择文件');
      if (file) {
        setText(els.productImportResult, `已选择文件：${file.name}`);
      }
    });
    addListener(els.closeProductImportButton, 'click', () => {
      state.workspace.productImportOpen = false;
      setActive(els.productImportModal, false);
    });
    addListener(els.runProductImportButton, 'click', () => {
      return importProductsBatch().catch((error) => setText(els.productImportResult, error.message || String(error)));
    });
    addListener(els.taskProgressButton, 'click', () => {
      return rebuildSelectedProducts().catch((error) => addDiagnosticEvent('product rebuild error', error.message || String(error)));
    });
    addListener(els.addProductButton, 'click', () => {
      state.workspace.activeProductId = null;
      state.workspace.productDetailMode = 'create';
      ensureProductDraft(null);
      renderProductDetail();
    });

    addListener(els.selectAllProductsButton, 'click', () => {
      const allSelected = state.workspace.productLibrary.length > 0
        && state.workspace.productLibrary.every((item) => state.workspace.selectedProductIds.has(item.id));
      for (const product of state.workspace.productLibrary) {
        if (allSelected) state.workspace.selectedProductIds.delete(product.id);
        else state.workspace.selectedProductIds.add(product.id);
      }
      renderProductLibrary();
    });

    addListener(els.batchDeleteButton, 'click', () => {
      return deleteSelectedProducts().catch((error) => addDiagnosticEvent('product delete error', error.message || String(error)));
    });
    addListener(els.saveProductButton, 'click', () => {
      return saveProductDraft().catch((error) => addDiagnosticEvent('product save error', error.message || String(error)));
    });
    addListener(els.resetProductButton, 'click', () => {
      const product = state.workspace.productLibrary.find((item) => item.id === state.workspace.activeProductId) || null;
      ensureProductDraft(product);
      renderProductDetail();
    });
    addListener(els.deleteProductButton, 'click', () => {
      return deleteActiveProduct().catch((error) => addDiagnosticEvent('product delete error', error.message || String(error)));
    });
    addListener(els.rebuildProductSearchButton, 'click', () => {
      return rebuildActiveProductSearch().catch((error) => addDiagnosticEvent('product rebuild error', error.message || String(error)));
    });

    // 新 UI：详情抽屉关闭
    addListener(els.closeDetailDrawerButton, 'click', () => {
      closeProductDetailDrawer();
    });
    addListener(els.productDetailOverlay, 'click', () => {
      closeProductDetailDrawer();
    });

    // 表头全选复选框
    addListener(els.productTableHeaderCheck, 'change', () => {
      const checked = els.productTableHeaderCheck?.checked || false;
      if (checked) {
        for (const product of state.workspace.productLibrary) {
          state.workspace.selectedProductIds.add(product.id);
        }
      } else {
        state.workspace.selectedProductIds.clear();
      }
      renderProductLibrary();
    });

    // 搜索框回车自动搜索
    addListener(els.goodsSearchInput, 'keydown', (event) => {
      if (event?.key === 'Enter') {
        state.workspace.productScope.page = 1;
        loadProductLibrary().catch((error) => addDiagnosticEvent('product search error', error.message || String(error)));
      }
    });
    addListener(els.shopSearchInput, 'keydown', (event) => {
      if (event?.key === 'Enter') {
        state.workspace.productScope.page = 1;
        loadProductLibrary().catch((error) => addDiagnosticEvent('product search error', error.message || String(error)));
      }
    });

    // 筛选下拉即时生效
    addListener(els.productStatusFilterSelect, 'change', () => {
      state.workspace.productScope.page = 1;
      loadProductLibrary().catch((error) => addDiagnosticEvent('product filter error', error.message || String(error)));
    });
    addListener(els.productSortBySelect, 'change', () => {
      state.workspace.productScope.page = 1;
      loadProductLibrary().catch((error) => addDiagnosticEvent('product sort error', error.message || String(error)));
    });
    addListener(els.productSortOrderSelect, 'change', () => {
      state.workspace.productScope.page = 1;
      loadProductLibrary().catch((error) => addDiagnosticEvent('product sort error', error.message || String(error)));
    });

    // 侧边栏导航过滤
    const navItems = queryAll('.product-admin-nav-item[data-nav]');
    navItems.forEach((navItem) => {
      addListener(navItem, 'click', () => {
        navItems.forEach((n) => n.classList.remove('active'));
        navItem.classList.add('active');
        const filter = navItem.getAttribute('data-nav');
        if (filter === 'all') {
          state.workspace.productScope.status = '';
        } else {
          state.workspace.productScope.status = filter;
        }
        if (els.productStatusFilterSelect) els.productStatusFilterSelect.value = state.workspace.productScope.status;
        if (els.productBreadcrumbTitle) {
          const titles = { all: '全部商品', active: '销售中', inactive: '已下架', deleted: '回收站' };
          els.productBreadcrumbTitle.textContent = titles[filter] || '全部商品';
        }
        state.workspace.productScope.page = 1;
        loadProductLibrary().catch((error) => addDiagnosticEvent('nav filter error', error.message || String(error)));
      });
    });
    addListener(els.addAttributeRowButton, 'click', () => {
      if (!state.workspace.productDraft) ensureProductDraft(null);
      state.workspace.productDraft.attributes[`属性${Object.keys(state.workspace.productDraft.attributes || {}).length + 1}`] = '';
      renderAttributeEditor();
    });
    addListener(els.clearProductShopRegistryButton, 'click', () => {
      state.workspace.productShopRegistry = [];
      state.workspace.productScope.shopId = '';
      state.workspace.productScope.shopName = '';
      persistProductShopRegistry();
      persistProductScope();
      syncProductScopeForm();
      renderProductLibrary();
    });

    addListener(els.loadCurrentCsrButton, 'click', loadCurrentCsr);
    addListener(els.loadCurrentConvButton, 'click', loadCurrentConv);
    addListener(els.loadRemoteHistoryButton, 'click', loadRemoteHistory);
    addListener(els.queryOrderRemarkButton, 'click', queryOrderRemark);
    addListener(els.saveOrderRemarkButton, 'click', saveOrderRemark);
    addListener(els.sendOrderMessageButton, 'click', sendOrderMessage);

    addListener(els.runTestReplyButton, 'click', runTestReply);
    addListener(els.saveAiSettingsButton, 'click', saveAiSettings);
    for (const node of [
      els.tmagentEnabledInput,
      els.tmagentBaseUrlInput,
      els.tmagentMerchantNameInput,
      els.tmagentTenantIdInput,
      els.tmagentApiKeyInput,
      els.testReplyInput
    ]) {
      addListener(node, 'input', runTestReply);
      addListener(node, 'change', runTestReply);
    }
    addListener(els.refreshDiagnostics, 'click', refreshDiagnosticsSnapshot);
    addListener(els.copyDiagnostics, 'click', async () => {
      const text = state.diagnostics.events
        .slice(0, 12)
        .map((event) => `${timeLabel(event.timestamp)} ${event.label} - ${event.detail}`)
        .join('\n');
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        }
        addDiagnosticEvent('diagnostics copy', '已复制诊断摘要');
      } catch (error) {
        addDiagnosticEvent('diagnostics copy error', error.message || String(error));
      }
    });
  }

  function bindApiEvents() {
    api.onServerStatus?.((address) => {
      const label = address?.port ? `ws://${address.address || '127.0.0.1'}:${address.port}` : 'WS starting...';
      setText(els.serverStatus, label);
    });

    api.onPddStatus?.((status) => {
      updateStatusLabel(els.pddState, formatPddStatus(status), Boolean(status?.running));
      renderCounters();
    });

    api.onQnStatus?.((status) => {
      updateStatusLabel(els.qnState, formatQnStatus(status), Boolean(status?.running));
    });

    api.onPddError?.((message) => addDiagnosticEvent('pdd error', message));
    api.onQnError?.((message) => addDiagnosticEvent('qn error', message));

    api.onBridgeStatus?.((status) => {
      state.diagnostics.bridgeConnected = Boolean(status?.injected);
      setText(els.bridgeStatus, status?.injected ? `Injected 路 PID ${status.pid || '--'}` : (status?.error || 'Not started'));
    });

    api.onBridgeHealth?.((status) => {
      renderBridgeHealth(status);
    });

    api.onCdpStatus?.((status) => {
      state.diagnostics.cdpConnected = Boolean(status?.connected);
      setText(els.cdpStatus, status?.connected ? (status.url || 'Connected') : (status?.error || 'Not connected'));
    });

    api.onBridgeDiagnostic?.(({ diagnostic }) => {
      const detail = diagnostic?.payload?.sample || diagnostic?.payload?.url || stringify(diagnostic?.payload || diagnostic);
      state.diagnostics.lastBridgeProbe = diagnostic;
      setText(els.lastBridgeProbe, `${diagnostic?.name || 'probe'} | ${truncate(detail, 96)}`);
      addDiagnosticEvent(`probe ${diagnostic?.name || 'event'}`, detail, diagnostic?.time);
    });

    api.onClientConnected?.((client) => {
      state.diagnostics.clients = state.diagnostics.clients.filter((item) => item?.id !== client?.id);
      state.diagnostics.clients.push(client);
      syncProductShopRegistryFromClients(state.diagnostics.clients);
      renderCounters();
      renderPlatformList();
      addDiagnosticEvent('client connected', `${client?.platform || 'client'} | ${client?.path || ''}`);
    });

    api.onClientDisconnected?.((client) => {
      state.diagnostics.clients = state.diagnostics.clients.filter((item) => item?.id !== client?.id);
      syncProductShopRegistryFromClients(state.diagnostics.clients);
      renderCounters();
      renderPlatformList();
      addDiagnosticEvent('client disconnected', `${client?.platform || 'client'} | ${client?.path || ''}`);
    });

    api.onProtocolMessage?.((payload) => {
      if (payload?.client?.id) {
        state.diagnostics.clients = state.diagnostics.clients.map((client) => {
          if (client?.id !== payload.client.id) return client;
          const protocolPayload = payload.protocol?.payload || {};
          const shopName = extractProtocolShopName(protocolPayload);
          const csrName = extractProtocolCsrName(protocolPayload);
          return {
            ...client,
            ...payload.client,
            shopId: extractProtocolShopId(protocolPayload) || payload.client.shopId || client.shopId,
            shopName: shopName || payload.client.shopName || client.shopName,
            csrName: csrName || payload.client.csrName || client.csrName
          };
        });
        syncProductShopRegistryFromClients(state.diagnostics.clients);
        renderPlatformList();
      }
      const protocol = payload?.protocol || {};
      if (protocol.type === 'currentcsr') {
        state.workspace.sessionTools.currentCsr = protocol.payload || null;
        const shopName = extractProtocolShopName(protocol.payload || {});
        const shopId = resolveShopId(extractProtocolShopId(protocol.payload || {}), shopName);
        const platform = normalizePlatformKey(protocol.payload?.platform || 'pdd');
        if (shopId) syncProductShopRegistryFromClients([{ platform, shopId, shopName }]);
        renderSessionTools();
      }
      if (protocol.type === 'currentconv') {
        state.workspace.sessionTools.currentConv = protocol.payload || null;
        renderSessionTools();
      }
      if (protocol.type === 'remote_his_message') {
        state.workspace.sessionTools.remoteHistory = Array.isArray(payload?.raw?.msg)
          ? payload.raw.msg
          : Array.isArray(protocol.raw?.msg)
            ? protocol.raw.msg
            : [];
        state.workspace.sessionTools.remoteHistoryMeta = protocol.payload || null;
        renderSessionTools();
      }
      if (protocol.type === 'queryorderremarkresult') {
        if (protocol.requestId === state.workspace.sessionTools.pendingRequests.orderRemarkQuery) {
          state.workspace.sessionTools.orderResult = protocol.payload || protocol.raw || null;
          const result = protocol.payload?.result || {};
          if (result.remark !== undefined) setValue(els.orderRemarkInput, result.remark || '');
          if (result.tagColor) setValue(els.orderTagColorSelect, result.tagColor);
          if (result.tagName !== undefined) setValue(els.orderTagNameInput, result.tagName || '');
          renderSessionTools();
        }
      }
      if (protocol.type === 'setorderremarkresult') {
        if (protocol.requestId === state.workspace.sessionTools.pendingRequests.orderRemarkSave) {
          state.workspace.sessionTools.orderResult = protocol.payload || protocol.raw || null;
          renderSessionTools();
        }
      }
      if (protocol.type === 'autoordermessageresult') {
        if (protocol.requestId === state.workspace.sessionTools.pendingRequests.orderMessageSend) {
          state.workspace.sessionTools.orderResult = protocol.payload || protocol.raw || null;
          renderSessionTools();
        }
      }
      state.diagnostics.lastParsed = payload;
      setText(els.lastParsedMessage, truncate(stringify(payload), 96));
    });

    api.onRawMessage?.((payload) => {
      state.diagnostics.lastRaw = payload;
      setText(els.lastRawMessage, truncate(stringify(payload), 96));
    });

    api.onWsError?.((payload) => {
      state.diagnostics.unparsedCount += 1;
      setText(els.unparsedCount, state.diagnostics.unparsedCount);
      addDiagnosticEvent('ws error', payload?.error || stringify(payload));
    });

    api.onWbChatFileChange?.((payload) => {
      setText(els.lastWbChatFile, `${payload?.name || 'file'} ${payload?.size || 0}B`);
      addDiagnosticEvent('wbchat file', `${payload?.name || 'file'} ${payload?.size || 0}B`, payload?.mtime);
    });

    api.onDomChat?.((payload) => {
      const lastMessage = payload?.chat?.messages?.at?.(-1) || payload?.chat?.messages?.[payload?.chat?.messages?.length - 1];
      const text = lastMessage?.text || payload?.chat?.title || 'chat updated';
      setText(els.lastDomChat, truncate(text, 96));
      addDiagnosticEvent('dom chat', text, payload?.time);
    });

    api.onDomChatError?.((payload) => addDiagnosticEvent('dom chat error', payload?.error || stringify(payload)));
    api.onMessage?.((payload) => appendIncomingMessage(payload));

    // 监听云端 AI客服配置更新（登录后拉取/后台刷新时触发）
    api.onAgentConfigCacheUpdated?.((payload) => {
      if (payload?.config) {
        applyAgentConfigToAiSettings(payload.config);
        renderAiSettings();
        renderPlatformList();
        addDiagnosticEvent('agent config cache updated', `fetchedAt: ${payload.fetchedAt || '--'}`);
      }
    });
  }

  async function hydrateStatus() {
    if (typeof api.getStatus !== 'function') return;
    try {
      const status = await api.getStatus();
      if (status?.server) {
        setText(els.serverStatus, `ws://${status.server.address || '127.0.0.1'}:${status.server.port}`);
      }
      if (Array.isArray(status?.clients)) {
        state.diagnostics.clients = status.clients;
        syncProductShopRegistryFromClients(status.clients);
        renderPlatformList();
        renderCounters();
      }
      if (status?.bridge) renderBridgeHealth(status.bridge);
      if (status?.pdd) updateStatusLabel(els.pddState, formatPddStatus(status.pdd), Boolean(status.pdd.running));
      if (status?.qn) updateStatusLabel(els.qnState, formatQnStatus(status.qn), Boolean(status.qn.running));
    } catch (error) {
      addDiagnosticEvent('status error', error.message || String(error));
    }
  }

  function init() {
    if (pageKind === 'ai-settings') {
      state.workspace.activeTab = 'ai-settings';
    }
    loadProductShopRegistry();
    loadProductScope();
    setupRightColumnLayout();
    bindEvents();
    bindApiEvents();
    renderWorkspaceTabs();
    renderToolsDrawer();
    renderPlatformFilters();
    normalizeProductPaneCopy();
    // 先水合设置（含 apiKey），再渲染商品库，确保请求时有正确的凭据
    hydrateAiSettings().then(() => {
      syncProductScopeForm();
      renderProductShopRegistry();
      renderProductLibrary();
      // 如果是商品库独立窗口且已有选中的店铺，自动加载商品列表
      if (pageKind === 'product-library' && hasProductScope()) {
        loadProductLibrary().catch((error) => addDiagnosticEvent('product auto-load error', error.message || String(error)));
      }
    });
    renderSessionTools();
    renderPlatformList();
    renderDiagnosticEvents();
    renderWorkspaceLogs();
    renderCounters();
    renderMessages();
    hydrateStatus();
    refreshDiagnosticsSnapshot();
    if (pageKind !== 'ai-settings') {
      showProductHome();
    }
    if (typeof setInterval === 'function') {
      setInterval(refreshDiagnosticsSnapshot, 15000);
    }
  }

  init();
})();
