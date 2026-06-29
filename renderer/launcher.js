'use strict';

(function bootstrapLauncher() {
  const doc = typeof document !== 'undefined' ? document : null;
  const api = typeof window !== 'undefined' ? (window.pddFuke || {}) : {};

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

  function setDisabled(node, value) {
    if (node) node.disabled = Boolean(value);
  }

  function addListener(node, eventName, listener) {
    if (node && typeof node.addEventListener === 'function') {
      node.addEventListener(eventName, listener);
    }
  }

  function replaceChildren(node, children) {
    if (node && typeof node.replaceChildren === 'function') {
      node.replaceChildren(...children);
    }
  }

  function normalizePlatformKey(platform) {
    const value = String(platform || '').toLowerCase();
    if (value === 'publicplatform' || value === 'pdd') return 'pdd';
    if (value === 'qn' || value === 'qianniu' || value === 'taobao') return 'taobao';
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

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  function platformLogoText(platform) {
    const key = normalizePlatformKey(platform);
    if (key === 'pdd') return '拼';
    if (key === 'taobao') return '淘';
    if (key === 'douyin') return '抖';
    return '店';
  }

  function shopOverrideKey(platform, shopId) {
    const normalizedPlatform = normalizePlatformKey(platform);
    const normalizedShopId = cleanShopText(shopId);
    if (!normalizedPlatform || !normalizedShopId) return '';
    return `${normalizedPlatform === 'taobao' ? 'qn' : normalizedPlatform}::${normalizedShopId}`;
  }

  const els = {
    platformPddAction: byId('platformPddAction'),
    platformQnAction: byId('platformQnAction'),
    openProductLibraryButton: byId('openProductLibraryButton'),
    openAiAgentConfigButton: byId('openAiAgentConfigButton'),
    openVersionManagerButton: byId('openVersionManagerButton'),
    openAiSettingsButton: byId('openAiSettingsButton'),
    platformList: byId('platformList'),
    serverStatus: byId('serverStatus'),
    loginUserDisplay: byId('loginUserDisplay')
  };

  const state = {
    clients: [],
    expandedPlatforms: new Set(['taobao', 'pdd']),
    aiSettings: {
      enabled: true,
      provider: 'tmagent',
      baseUrl: '',
      merchantName: '',
      tenantId: '',
      apiKey: '',
      headerName: 'X-API-Key',
      shopOverrides: {}
    }
  };

  function isShopAiEnabled(shop) {
    if (state.aiSettings.enabled === false) return false;
    const key = shopOverrideKey(shop.platform, shop.shopId);
    const override = key ? state.aiSettings.shopOverrides?.[key] : null;
    return override?.enabled !== false;
  }

  async function toggleShopAi(shop) {
    const key = shopOverrideKey(shop.platform, shop.shopId);
    if (!key) return;
    const current = state.aiSettings.shopOverrides?.[key];
    const nextEnabled = current?.enabled === false;
    const nextSettings = {
      ...state.aiSettings,
      shopOverrides: {
        ...(state.aiSettings.shopOverrides || {}),
        [key]: {
          platform: key.split('::')[0],
          shopId: shop.shopId,
          shopName: shop.name,
          enabled: nextEnabled,
          updatedAt: Date.now()
        }
      }
    };
    const saved = await api.saveAiSettings?.(nextSettings);
    state.aiSettings = saved || nextSettings;
    renderPlatformList();
  }

  function renderPlatformList() {
    if (!els.platformList || typeof els.platformList.querySelectorAll !== 'function' || !doc) return;
    const cards = Array.from(els.platformList.querySelectorAll('.platform-card'));
    const shopsByPlatform = state.clients.reduce((map, client) => {
      const key = normalizePlatformKey(client?.platform);
      const shops = map.get(key) || [];
      const shopName = extractClientShopName(client);
      shops.push({
        id: String(client?.id || `${key}-${shops.length}`),
        platform: key,
        name: shopName,
        shopId: resolveShopId(client?.shopId || client?.mallId || client?.targetId || '', shopName)
      });
      map.set(key, shops);
      return map;
    }, new Map());

    for (const card of cards) {
      const platform = normalizePlatformKey(card.dataset ? card.dataset.platform : '');
      const shops = shopsByPlatform.get(platform) || [];
      const expanded = state.expandedPlatforms.has(platform);
      const countNode = typeof card.querySelector === 'function' ? card.querySelector('.shop-count') : null;
      const listNode = typeof card.querySelector === 'function' ? card.querySelector('.shop-list') : null;
      const caretNode = typeof card.querySelector === 'function' ? card.querySelector('.platform-caret') : null;

      if (card?.classList?.toggle) card.classList.toggle('collapsed', !expanded);
      if (countNode) countNode.textContent = String(shops.length);

      if (!listNode) continue;
      if (!expanded) {
        replaceChildren(listNode, []);
        continue;
      }

      const rows = shops.map((shop) => {
        const row = doc.createElement('div');
        row.className = 'shop-cell shop-row';
        const logo = doc.createElement('span');
        logo.className = `shop-logo ${shop.platform}`;
        logo.textContent = platformLogoText(shop.platform);
        const name = doc.createElement('span');
        name.className = 'shop-name';
        name.textContent = shop.name;
        const toggle = doc.createElement('button');
        toggle.type = 'button';
        toggle.className = `shop-ai-toggle${isShopAiEnabled(shop) ? ' enabled' : ' disabled'}`;
        toggle.textContent = isShopAiEnabled(shop) ? 'AI 开启' : 'AI 关闭';
        addListener(toggle, 'click', () => toggleShopAi(shop).catch(() => {}));
        row.append(logo, name, toggle);
        return row;
      });
      replaceChildren(listNode, rows);
    }
  }

  // 下载中的按钮文本缓存
  const downloadingButtons = {};

  function getPlatformButton(platform) {
    if (platform === 'pdd') return els.platformPddAction;
    if (platform === 'qn') return els.platformQnAction;
    // 其他平台按 data-platform 查找
    const cards = els.platformList?.querySelectorAll?.('.platform-card');
    if (cards) {
      for (const card of cards) {
        if (card.dataset?.platform === platform) {
          return card.querySelector('.platform-action');
        }
      }
    }
    return null;
  }

  function getPlatformLabel(platform) {
    const labels = { pdd: '拼多多', qn: '千牛', dy: '抖音', ks: '快手', jd: '京东' };
    return labels[platform] || platform;
  }

  async function handleLaunch(launcher) {
    if (typeof launcher !== 'function') return;
    const button = this;
    setDisabled(button, true);
    try {
      await launcher();
    } catch (_) {
      // silently ignore
    } finally {
      setDisabled(button, false);
    }
  }

  function bindEvents() {
    addListener(els.platformPddAction, 'click', function onLaunchPddAction() {
      return handleLaunch.call(this, api.launchPdd);
    });
    addListener(els.platformQnAction, 'click', function onLaunchQnAction() {
      return handleLaunch.call(this, api.launchQn);
    });
    addListener(els.openProductLibraryButton, 'click', () => api.openProductLibrary?.());
    addListener(els.openAiSettingsButton, 'click', () => api.openAiSettings?.());
    addListener(els.openVersionManagerButton, 'click', () => api.openVersionManager?.());
    addListener(els.openAiAgentConfigButton, 'click', () => openAiAgentConfigModal());

    // 窗口控制按钮
    addListener(byId('btnMinimize'), 'click', () => api.minimizeWindow?.());
    addListener(byId('btnClose'), 'click', () => api.closeWindow?.());

    if (els.platformList && typeof els.platformList.querySelectorAll === 'function') {
      for (const card of Array.from(els.platformList.querySelectorAll('.platform-card'))) {
        const caret = typeof card.querySelector === 'function' ? card.querySelector('.platform-caret') : null;
        addListener(caret, 'click', () => {
          const platform = normalizePlatformKey(card.dataset ? card.dataset.platform : '');
          if (state.expandedPlatforms.has(platform)) state.expandedPlatforms.delete(platform);
          else state.expandedPlatforms.add(platform);
          renderPlatformList();
        });
      }
    }
  }

  function bindApiEvents() {
    // 平台下载进度监听
    api.onPlatformDownloadProgress?.((data) => {
      const { platform, phase, percent, downloaded, total, extracted } = data;
      const button = getPlatformButton(platform);
      if (!button) return;
      const label = getPlatformLabel(platform);
      // 保存原始文本
      if (!downloadingButtons[platform]) {
        downloadingButtons[platform] = button.textContent;
      }
      setDisabled(button, true);
      if (phase === 'download') {
        const dlStr = typeof downloaded === 'number' ? formatFileSize(downloaded) : '';
        const totalStr = typeof total === 'number' ? formatFileSize(total) : '';
        setText(button, `下载${label} ${percent || 0}% ${dlStr}/${totalStr}`);
      } else if (phase === 'extract') {
        setText(button, `解压${label} ${percent || 0}% (${extracted || 0}文件)`);
      }
    });
    api.onPlatformDownloadStart?.((data) => {
      const button = getPlatformButton(data.platform);
      if (button) {
        downloadingButtons[data.platform] = button.textContent;
        setDisabled(button, true);
        setText(button, `准备下载${getPlatformLabel(data.platform)}...`);
      }
    });
    api.onPlatformDownloadComplete?.((data) => {
      const button = getPlatformButton(data.platform);
      if (button) {
        setDisabled(button, false);
        setText(button, `启动${getPlatformLabel(data.platform)}`);
      }
    });
    api.onPlatformDownloadError?.((data) => {
      const button = getPlatformButton(data.platform);
      if (button) {
        setDisabled(button, false);
        const orig = downloadingButtons[data.platform] || `启动${getPlatformLabel(data.platform)}`;
        setText(button, orig);
        delete downloadingButtons[data.platform];
      }
    });

    api.onClientConnected?.((client) => {
      state.clients = state.clients.filter((item) => item?.id !== client?.id);
      state.clients.push(client);
      renderPlatformList();
    });
    api.onClientDisconnected?.((client) => {
      state.clients = state.clients.filter((item) => item?.id !== client?.id);
      renderPlatformList();
    });
    api.onProtocolMessage?.((payload) => {
      if (!payload?.client?.id) return;
      state.clients = state.clients.map((client) => {
        if (client?.id !== payload.client.id) return client;
        const protocolPayload = payload.protocol?.payload || {};
        const shopName = extractProtocolShopName(protocolPayload);
        const shopId = resolveShopId(extractProtocolShopId(protocolPayload), shopName);
        return {
          ...client,
          ...payload.client,
          shopId: shopId || payload.client.shopId || client.shopId,
          shopName: shopName || payload.client.shopName || client.shopName
        };
      });
      renderPlatformList();
    });
    api.onLoginStateChanged?.((loginState) => {
      if (loginState?.loggedIn && loginState?.user) {
        const phone = loginState.user?.mobile || '';
        setText(els.loginUserDisplay, phone ? `已登录: ${phone}` : '已登录');
        els.loginUserDisplay?.classList?.remove('logged-out');
      } else {
        setText(els.loginUserDisplay, '未登录');
        els.loginUserDisplay?.classList?.add('logged-out');
      }
    });
  }

  async function hydrateStatus() {
    try {
      const [status, aiSettings, loginState] = await Promise.all([
        api.getStatus?.(),
        api.getAiSettings?.(),
        api.getLoginState?.()
      ]);
      state.clients = Array.isArray(status?.clients) ? status.clients : [];
      state.aiSettings = {
        provider: String(aiSettings?.provider || 'tmagent'),
        enabled: aiSettings?.enabled !== false,
        baseUrl: String(aiSettings?.baseUrl || ''),
        merchantName: String(aiSettings?.merchantName || ''),
        tenantId: String(aiSettings?.tenantId || ''),
        apiKey: String(aiSettings?.apiKey || ''),
        headerName: String(aiSettings?.headerName || 'X-API-Key'),
        shopOverrides: aiSettings?.shopOverrides || {}
      };
      if (status?.server) {
        const host = status.server.address || '127.0.0.1';
        const port = status.server.port || '';
        setText(els.serverStatus, port ? `ws://${host}:${port}` : '');
      }
      // 显示登录用户信息
      if (loginState?.loggedIn && loginState?.user) {
        const phone = loginState.user?.mobile || '';
        setText(els.loginUserDisplay, phone ? `已登录: ${phone}` : '已登录');
        els.loginUserDisplay?.classList?.remove?.('logged-out');
      } else {
        els.loginUserDisplay?.classList?.add?.('logged-out');
      }
      renderPlatformList();
    } catch (error) {
      // silently ignore
    }
  }

  // ===== AI客服配置 模态框逻辑 =====
  function getConfigEl(id) {
    return byId(id);
  }

  function showConfigStatus(text, type) {
    const node = getConfigEl('aiConfigStatus');
    if (!node) return;
    setText(node, text);
    node.className = `ai-config-status-text ${type || ''}`;
  }

  function clearConfigStatus() {
    const node = getConfigEl('aiConfigStatus');
    if (!node) return;
    setText(node, '');
    node.className = 'ai-config-status-text';
  }

  function parseCommaList(value) {
    const text = String(value || '').trim();
    if (!text) return [];
    return text.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  }

  function formatCommaList(arr) {
    if (!Array.isArray(arr) || !arr.length) return '';
    return arr.join(', ');
  }

  function getHandoffActionValue() {
    const checked = doc?.querySelector('input[name="cfgHandoffAction"]:checked');
    return checked ? String(checked.value).trim() : 'transfer_conversation_2';
  }

  function buildSoulPromptPreview(basic, advanced, soulName) {
    const name = soulName || basic?.agent_name || '客服';
    const parts = [];
    parts.push('【客服身份】');
    parts.push(`你叫${name}，是本店客服。`);
    parts.push('');
    parts.push('【公共核心规则】  ← 平台基线 basic.core_rules');
    parts.push('【公共商品规则】  ← 平台基线 basic.product_rules');
    parts.push('【公共售前流程】  ← 平台基线 basic.presale_guidance');
    parts.push('【公共售后口径】  ← 平台基线 basic.aftersale_policy');
    parts.push('【公共边界要求】  ← 平台基线 advanced.boundary_rules');
    parts.push('');
    const personalityTags = basic?.personality_tags || [];
    const expressionTags = basic?.expression_tags || [];
    if (personalityTags.length) parts.push(`【说话风格】      ← ${personalityTags.join('、')}`);
    if (expressionTags.length) parts.push(`【表达偏好】      ← ${expressionTags.join('、')}`);
    parts.push('');
    if (basic?.shop_facts) parts.push(`【店铺事实】      ← ${basic.shop_facts}`);
    if (basic?.product_facts) parts.push(`【商品事实】      ← ${basic.product_facts}`);
    if (basic?.presale_guidance) parts.push(`【售前引导】      ← ${basic.presale_guidance}`);
    if (basic?.aftersale_policy) parts.push(`【售后口径】      ← ${basic.aftersale_policy}`);
    if (advanced?.boundary_rules) parts.push(`【边界要求】      ← ${advanced.boundary_rules}`);
    if (advanced?.recommendation_policy) parts.push(`【推荐偏好】      ← ${advanced.recommendation_policy}`);
    parts.push('');
    const handoffTriggers = advanced?.handoff_triggers || [];
    const blockedPhrases = advanced?.blocked_phrases || [];
    const handoffAction = advanced?.handoff_action || 'transfer_conversation_2';
    const handoffLabel = handoffAction === 'human_takeover' ? '当前账号接待' : '转接其他客服';
    if (handoffTriggers.length) parts.push(`【转人工场景】    ← 平台 + 商户 handoff_triggers 合并去重: ${handoffTriggers.join('、')}`);
    parts.push(`【转人工方式】    ← ${handoffLabel} (${handoffAction})`);
    if (blockedPhrases.length) parts.push(`【禁用话术】      ← 平台 + 商户 blocked_phrases 合并去重: ${blockedPhrases.join('、')}`);
    parts.push('');
    parts.push('【默认边界】      ← 系统硬编码（不编造订单物流、不承诺时效等）');
    return parts.join('\n');
  }

  function fillConfigForm(config) {
    if (!config) return;
    // 兼容后端返回 JSON 字符串的情况
    let basic = config.basic || {};
    if (typeof basic === 'string') {
      try { basic = JSON.parse(basic); } catch (_) { basic = {}; }
    }
    let advanced = config.advanced || {};
    if (typeof advanced === 'string') {
      try { advanced = JSON.parse(advanced); } catch (_) { advanced = {}; }
    }
    const el = (id) => getConfigEl(id);

    // 基础人设
    const elSoulName = el('cfgSoulName');
    if (elSoulName) elSoulName.value = String(config.soul_name || basic.agent_name || '');
    const elShopFacts = el('cfgShopFacts');
    if (elShopFacts) elShopFacts.value = String(basic.shop_facts || '');
    const elProductFacts = el('cfgProductFacts');
    if (elProductFacts) elProductFacts.value = String(basic.product_facts || '');
    const elPresale = el('cfgPresaleGuidance');
    if (elPresale) elPresale.value = String(basic.presale_guidance || '');
    const elAftersale = el('cfgAftersalePolicy');
    if (elAftersale) elAftersale.value = String(basic.aftersale_policy || '');
    const elPersonality = el('cfgPersonalityTags');
    if (elPersonality) elPersonality.value = formatCommaList(basic.personality_tags);
    const elExpression = el('cfgExpressionTags');
    if (elExpression) elExpression.value = formatCommaList(basic.expression_tags);

    // 高级配置
    const elBoundary = el('cfgBoundaryRules');
    if (elBoundary) elBoundary.value = String(advanced.boundary_rules || '');
    const elRecommend = el('cfgRecommendationPolicy');
    if (elRecommend) elRecommend.value = String(advanced.recommendation_policy || '');
    const elHandoff = el('cfgHandoffTriggers');
    if (elHandoff) elHandoff.value = formatCommaList(advanced.handoff_triggers);
    const elBlocked = el('cfgBlockedPhrases');
    if (elBlocked) elBlocked.value = formatCommaList(advanced.blocked_phrases);

    // LLM
    const temp = typeof config.llm_temperature === 'number' ? config.llm_temperature : 0.7;
    const elTemp = el('cfgLlmTemperature');
    const elTempVal = el('cfgLlmTemperatureVal');
    if (elTemp) elTemp.value = String(temp);
    if (elTempVal) elTempVal.textContent = String(temp);
    const elMaxTokens = el('cfgLlmMaxTokens');
    if (elMaxTokens) elMaxTokens.value = String(config.llm_max_tokens || 800);

    // 行为
    const eps = typeof config.epsilon === 'number' ? config.epsilon : 0.2;
    const elEps = el('cfgEpsilon');
    const elEpsVal = el('cfgEpsilonVal');
    if (elEps) elEps.value = String(eps);
    if (elEpsVal) elEpsVal.textContent = String(eps);
    const elStrategy = el('cfgStrategy');
    if (elStrategy) elStrategy.value = String(config.strategy || 'plan_a');
    const elCtx = el('cfgMaxContextTurns');
    if (elCtx) elCtx.value = String(config.max_context_turns || 30);
    const elTopK = el('cfgTopK');
    if (elTopK) elTopK.value = String(config.top_k || 3);

    // 转人工设置
    const handoffAction = advanced.handoff_action || 'transfer_conversation_2';
    const elHandoffRadio = doc?.querySelector(`input[name="cfgHandoffAction"][value="${handoffAction}"]`);
    if (elHandoffRadio) elHandoffRadio.checked = true;

    // 预览
    updateSoulPromptPreview();
  }

  function readConfigForm() {
    const el = (id) => getConfigEl(id);
    const basic = {
      agent_name: String((el('cfgSoulName')?.value || '')).trim(),
      shop_facts: String((el('cfgShopFacts')?.value || '')).trim(),
      product_facts: String((el('cfgProductFacts')?.value || '')).trim(),
      presale_guidance: String((el('cfgPresaleGuidance')?.value || '')).trim(),
      aftersale_policy: String((el('cfgAftersalePolicy')?.value || '')).trim(),
      personality_tags: parseCommaList(el('cfgPersonalityTags')?.value),
      expression_tags: parseCommaList(el('cfgExpressionTags')?.value)
    };
    const advanced = {
      boundary_rules: String((el('cfgBoundaryRules')?.value || '')).trim(),
      recommendation_policy: String((el('cfgRecommendationPolicy')?.value || '')).trim(),
      handoff_triggers: parseCommaList(el('cfgHandoffTriggers')?.value),
      blocked_phrases: parseCommaList(el('cfgBlockedPhrases')?.value),
      handoff_action: getHandoffActionValue()
    };
    return {
      agent_type: 'agent',
      soul_name: basic.agent_name,
      persona_name: basic.agent_name,
      llm_temperature: parseFloat(el('cfgLlmTemperature')?.value) || 0.7,
      llm_max_tokens: parseInt(el('cfgLlmMaxTokens')?.value, 10) || 800,
      epsilon: parseFloat(el('cfgEpsilon')?.value) || 0.2,
      strategy: String(el('cfgStrategy')?.value || 'plan_a').trim(),
      max_context_turns: parseInt(el('cfgMaxContextTurns')?.value, 10) || 30,
      top_k: parseInt(el('cfgTopK')?.value, 10) || 3,
      basic,
      advanced,
      soul_prompt: buildSoulPromptPreview(basic, advanced, basic.agent_name),
      persona_system_prompt: buildSoulPromptPreview(basic, advanced, basic.agent_name)
    };
  }

  function updateSoulPromptPreview() {
    const el = (id) => getConfigEl(id);
    const basic = {
      agent_name: String((el('cfgSoulName')?.value || '')).trim(),
      shop_facts: String((el('cfgShopFacts')?.value || '')).trim(),
      product_facts: String((el('cfgProductFacts')?.value || '')).trim(),
      presale_guidance: String((el('cfgPresaleGuidance')?.value || '')).trim(),
      aftersale_policy: String((el('cfgAftersalePolicy')?.value || '')).trim(),
      personality_tags: parseCommaList(el('cfgPersonalityTags')?.value),
      expression_tags: parseCommaList(el('cfgExpressionTags')?.value)
    };
    const advanced = {
      boundary_rules: String((el('cfgBoundaryRules')?.value || '')).trim(),
      recommendation_policy: String((el('cfgRecommendationPolicy')?.value || '')).trim(),
      handoff_triggers: parseCommaList(el('cfgHandoffTriggers')?.value),
      blocked_phrases: parseCommaList(el('cfgBlockedPhrases')?.value),
      handoff_action: getHandoffActionValue()
    };
    const preview = buildSoulPromptPreview(basic, advanced, basic.agent_name);
    setText(getConfigEl('cfgSoulPromptPreview'), preview);
  }

  function bindConfigFormPreview() {
    const fields = [
      'cfgSoulName', 'cfgShopFacts', 'cfgProductFacts', 'cfgPresaleGuidance',
      'cfgAftersalePolicy', 'cfgPersonalityTags', 'cfgExpressionTags',
      'cfgBoundaryRules', 'cfgRecommendationPolicy', 'cfgHandoffTriggers',
      'cfgBlockedPhrases'
    ];
    for (const id of fields) {
      const el = getConfigEl(id);
      addListener(el, 'input', updateSoulPromptPreview);
    }
    // radio 切换也触发预览更新
    const handoffRadios = queryAll('input[name="cfgHandoffAction"]');
    if (handoffRadios) {
      for (const radio of handoffRadios) {
        addListener(radio, 'change', updateSoulPromptPreview);
      }
    }
  }

  function switchConfigTab(tabName) {
    const tabs = queryAll('.ai-config-tab');
    const panes = queryAll('.ai-config-pane');
    for (const tab of tabs) {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    }
    for (const pane of panes) {
      pane.classList.toggle('active', pane.dataset.pane === tabName);
    }
  }

  function bindConfigTabs() {
    const tabs = queryAll('.ai-config-tab');
    for (const tab of tabs) {
      addListener(tab, 'click', () => switchConfigTab(tab.dataset.tab));
    }
  }

  function bindConfigRangeSliders() {
    const tempSlider = getConfigEl('cfgLlmTemperature');
    const tempVal = getConfigEl('cfgLlmTemperatureVal');
    addListener(tempSlider, 'input', () => {
      if (tempVal) tempVal.textContent = String(parseFloat(tempSlider.value).toFixed(1));
      updateSoulPromptPreview();
    });
    const epsSlider = getConfigEl('cfgEpsilon');
    const epsVal = getConfigEl('cfgEpsilonVal');
    addListener(epsSlider, 'input', () => {
      if (epsVal) epsVal.textContent = String(parseFloat(epsSlider.value).toFixed(2));
    });
  }

  function showAiConfigModal() {
    const modal = getConfigEl('aiAgentConfigModal');
    if (modal) modal.style.display = 'flex';
  }

  function hideAiConfigModal() {
    const modal = getConfigEl('aiAgentConfigModal');
    if (modal) modal.style.display = 'none';
  }

  async function loadAgentConfig() {
    clearConfigStatus();
    try {
      showConfigStatus('正在加载配置...', '');
      const result = await api.getAgentConfig?.();
      // 新返回格式: { config, fromCache, fetchedAt }
      const config = result?.config || result; // 兼容旧格式
      const fromCache = result?.fromCache;
      const fetchedAt = result?.fetchedAt;

      if (config) {
        fillConfigForm(config);
        if (fromCache && fetchedAt) {
          const timeStr = new Date(fetchedAt).toLocaleString('zh-CN');
          showConfigStatus(`已加载本地缓存 (${timeStr})，后台正在刷新云端...`, 'success');
        } else {
          showConfigStatus('配置加载成功', 'success');
        }
      } else {
        showConfigStatus('暂无配置数据，请填写后保存', '');
      }
    } catch (error) {
      showConfigStatus(`加载失败: ${error.message}`, 'error');
    }
  }

  // 监听云端配置更新（登录时后台拉取 / get 时后台刷新）
  api.onAgentConfigCacheUpdated?.((payload) => {
    if (payload?.config) {
      // 只在弹窗打开时自动填充，避免打扰用户
      const modal = getConfigEl('aiAgentConfigModal');
      if (modal && modal.style.display !== 'none') {
        fillConfigForm(payload.config);
        const timeStr = new Date(payload.fetchedAt).toLocaleString('zh-CN');
        showConfigStatus(`云端配置已同步 (${timeStr})`, 'success');
      }
    }
  });

  async function saveAgentConfig() {
    clearConfigStatus();
    try {
      showConfigStatus('正在保存配置...', '');
      const payload = readConfigForm();
      console.log('[launcher:saveAgentConfig] payload keys:', Object.keys(payload));
      console.log('[launcher:saveAgentConfig] api.saveAgentConfig:', typeof api.saveAgentConfig);
      if (!api.saveAgentConfig) {
        throw new Error('api.saveAgentConfig 未定义，preload 可能未正确加载');
      }
      const savedConfig = await api.saveAgentConfig(payload);
      // 用后端返回的标准化配置更新表单（确保显示的是实际存储的值）
      if (savedConfig && savedConfig.soul_name !== undefined) {
        fillConfigForm(savedConfig);
        console.log('[launcher:saveAgentConfig] form updated from saved config');
      }
      showConfigStatus('配置保存成功', 'success');
    } catch (error) {
      console.error('[launcher:saveAgentConfig] error:', error.message);
      showConfigStatus(`保存失败: ${error.message}`, 'error');
    }
  }

  function openAiAgentConfigModal() {
    showAiConfigModal();
    loadAgentConfig();
  }

  function bindConfigModalEvents() {
    addListener(getConfigEl('aiConfigCloseBtn'), 'click', hideAiConfigModal);
    // 点击遮罩关闭
    addListener(getConfigEl('aiAgentConfigModal')?.querySelector('.ai-config-overlay'), 'click', hideAiConfigModal);
    addListener(getConfigEl('aiConfigRefreshBtn'), 'click', loadAgentConfig);
    addListener(getConfigEl('aiConfigSaveBtn'), 'click', saveAgentConfig);
    bindConfigTabs();
    bindConfigFormPreview();
    bindConfigRangeSliders();
  }

  function init() {
    bindEvents();
    bindApiEvents();
    bindConfigModalEvents();
    renderPlatformList();
    hydrateStatus();

    // 苹果风格涟漪效果
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('click', function (e) {
        const btn = e.target.closest('button');
        if (!btn) return;
        // 排除纯图标小按钮
        if (btn.classList.contains('platform-caret') || btn.classList.contains('ai-config-close')) return;

        const ripple = doc.createElement('span');
        const rect = btn.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const x = e.clientX - rect.left - size / 2;
        const y = e.clientY - rect.top - size / 2;

        ripple.style.cssText = [
          'position:absolute',
          'pointer-events:none',
          'border-radius:50%',
          'background:rgba(255,255,255,0.3)',
          `width:${size}px`,
          `height:${size}px`,
          `left:${x}px`,
          `top:${y}px`,
          'transform:scale(0)',
          'opacity:0.6',
          'animation:ripple 0.5s ease-out forwards'
        ].join(';');

        btn.style.position = btn.style.position || 'relative';
        btn.style.overflow = 'hidden';
        btn.appendChild(ripple);
        ripple.addEventListener('animationend', () => ripple.remove());
      });
    }
  }

  init();
})();
