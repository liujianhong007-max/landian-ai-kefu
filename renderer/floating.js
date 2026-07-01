'use strict';

const state = {
  clients: new Map(),
  conversations: new Map(),
  manualConversations: new Map(),
  tickets: {
    reshipment: new Map(),
    address: new Map(),
    afterSale: new Map()
  },
  confirmedTickets: new Set(),
  activeConversationId: null,
  activeMainTab: 'assistant',
  activeHandoffList: 'manual',
  activeTicketCategory: 'reshipment',
  aiEnabled: false,
  aiMerchantName: '',
  today: 0,
  sent: 0,
  pendingManualAfterCurrent: false,
  statuses: {
    pdd: null,
    qn: null
  }
};

const els = {
  connectionDot: document.getElementById('pluginConnectionDot'),
  connection: document.getElementById('pluginConnection'),
  cdp: document.getElementById('pluginCdp'),
  platform: document.getElementById('pluginPlatform'),
  pending: document.getElementById('pluginPending'),
  today: document.getElementById('pluginToday'),
  sent: document.getElementById('pluginSent'),
  assistantTab: document.getElementById('pluginAssistantTab'),
  ticketTab: document.getElementById('pluginTicketTab'),
  assistantPanel: document.getElementById('pluginAssistantPanel'),
  ticketPanel: document.getElementById('pluginTicketPanel'),
  manualMessages: document.getElementById('pluginManualMessages'),
  pendingMessages: document.getElementById('pluginPendingMessages'),
  ticketMessages: document.getElementById('pluginTicketMessages'),
  lastTime: document.getElementById('pluginLastTime'),
  autoReply: document.getElementById('pluginAutoReply'),
  modeHint: document.getElementById('pluginModeHint'),
  selection: document.getElementById('pluginSelection'),
  pendingAction: document.getElementById('pluginPendingAction'),
  manualAction: document.getElementById('pluginManualAction'),
  manualListAction: document.getElementById('pluginManualListAction'),
  pendingListAction: document.getElementById('pluginPendingListAction'),
  ticketReshipmentAction: document.getElementById('pluginTicketReshipmentAction'),
  ticketAddressAction: document.getElementById('pluginTicketAddressAction'),
  ticketAfterSaleAction: document.getElementById('pluginTicketAfterSaleAction'),
  currentConversation: document.getElementById('pluginCurrentConversation'),
  manualBadge: document.getElementById('pluginManualBadge'),
  pendingHumanBadge: document.getElementById('pluginPendingHumanBadge'),
  ticketReshipmentBadge: document.getElementById('pluginTicketReshipmentBadge'),
  ticketAddressBadge: document.getElementById('pluginTicketAddressBadge'),
  ticketAfterSaleBadge: document.getElementById('pluginTicketAfterSaleBadge'),
  close: document.getElementById('pluginClose'),
  minimize: document.getElementById('pluginMinimize')
};

function normalizePlatformName(platform) {
  if (platform === 'publicplatform') return 'pdd';
  if (platform === 'qianniu') return 'qn';
  return platform || '';
}

function setText(el, value) {
  if (el) el.textContent = String(value);
}

function setDisabled(el, value) {
  if (el) el.disabled = Boolean(value);
}

function timeLabel(value) {
  if (!value) return '--';
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function waitLabel(value) {
  if (!value) return '等待中';
  const totalMinutes = Math.max(1, Math.floor((Date.now() - Number(value)) / 60000));
  if (totalMinutes < 60) return `等待 ${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `等待 ${hours}小时${minutes}分钟` : `等待 ${hours}小时`;
}

function preview(message) {
  if (!message) return '';
  if (message.kind === 'text') return String(message.content?.text || message.text || '').trim();
  if (message.kind === 'goods') return `[商品] ${message.content?.goodsName || ''}`.trim();
  if (message.kind === 'order') return `[订单] ${message.content?.orderSn || message.content?.orderId || ''}`.trim();
  if (message.kind === 'image') return '[图片]';
  return `[${message.kind || '消息'}]`;
}

function stringifyCardValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(stringifyCardValue).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.values(value).map(stringifyCardValue).filter(Boolean).join(' ');
  return '';
}

function ticketCategoryForMessage(message) {
  const messageType = String(message?.messageType || '').toLowerCase();
  const cardType = String(message?.card?.type || '').toLowerCase();
  const text = [
    messageType,
    cardType,
    stringifyCardValue(message?.card),
    stringifyCardValue(message?.content)
  ].join(' ');

  if (messageType === 'reshipment_card' || cardType === 'reshipment' || /补寄/.test(text)) return 'reshipment';
  if (messageType === 'address_change_card' || cardType === 'address_change' || /改地址|修改地址|地址变更/.test(text)) return 'address';
  if (messageType === 'refund_card' || cardType === 'refund' || /售后|退款|退货|换货/.test(text)) return 'afterSale';
  return '';
}

function ticketCategoryLabel(category) {
  if (category === 'reshipment') return '补寄';
  if (category === 'address') return '改地址';
  return '售后';
}

function ticketSummary(message, fallbackText) {
  const card = message?.card || {};
  return String(
    card.event_text
    || card.application_reason
    || card.application_type
    || card.product?.title
    || fallbackText
    || ticketCategoryLabel(ticketCategoryForMessage(message))
  ).trim();
}

function platformLabel(platform) {
  platform = normalizePlatformName(platform);
  if (platform === 'qn') return '千牛';
  if (platform === 'pdd') return '拼多多';
  return '平台';
}

function ensureConversation(message, platform) {
  const id = String(message.conversationId || message.id || 'unknown');
  platform = normalizePlatformName(platform || 'pdd');
  if (!state.conversations.has(id)) {
    state.conversations.set(id, {
      id,
      title: String(message.senderName || message.conversationId || id),
      platform: platform || 'pdd',
      lastBuyerText: '',
      lastBuyerTime: 0,
      lastAssistantText: '',
      lastAssistantTime: 0,
      lastMessageTime: 0,
      unreadCount: 0
    });
  }
  const conversation = state.conversations.get(id);
  if (message.senderName) conversation.title = String(message.senderName);
  if (platform) conversation.platform = platform;
  return conversation;
}

function conversationFromManual(item) {
  const id = String(item.conversationId || '');
  if (!id) return null;
  const existing = state.conversations.get(id);
  return existing || {
    id,
    title: item.customerName || id,
    platform: item.platform || 'pdd',
    lastBuyerText: item.lastText || item.reason || '',
    lastBuyerTime: item.lastBuyerAt || item.pendingSince || 0,
    lastAssistantText: '',
    lastAssistantTime: item.lastAssistantAt || 0,
    lastMessageTime: item.lastBuyerAt || item.pendingSince || 0,
    unreadCount: 0
  };
}

function findTicketByConversationId(conversationId) {
  const id = String(conversationId || '');
  if (!id) return null;
  for (const tickets of Object.values(state.tickets)) {
    if (tickets.has(id)) return tickets.get(id);
  }
  return null;
}

function conversationFromTicket(item) {
  const id = String(item?.conversationId || '');
  if (!id) return null;
  const existing = state.conversations.get(id);
  return existing || {
    id,
    title: item.title || id,
    platform: normalizePlatformName(item.platform || 'pdd') || 'pdd',
    lastBuyerText: item.summary || ticketCategoryLabel(item.category),
    lastBuyerTime: item.timestamp || 0,
    lastAssistantText: '',
    lastAssistantTime: 0,
    lastMessageTime: item.timestamp || 0,
    unreadCount: 0
  };
}

function getActiveConversation() {
  if (!state.activeConversationId) return null;
  return state.conversations.get(state.activeConversationId)
    || conversationFromManual(state.manualConversations.get(state.activeConversationId) || {})
    || conversationFromTicket(findTicketByConversationId(state.activeConversationId));
}

function getCurrentPlatform() {
  const activeConversation = getActiveConversation();
  if (activeConversation?.platform) return normalizePlatformName(activeConversation.platform);
  for (const client of state.clients.values()) {
    if (client?.platform) return normalizePlatformName(client.platform);
  }
  if (state.statuses.pdd?.running) return 'pdd';
  if (state.statuses.qn?.running) return 'qn';
  return 'pdd';
}

function getCurrentStatus() {
  return state.statuses[getCurrentPlatform()] || null;
}

function isManualConversation(conversationId) {
  return state.manualConversations.has(String(conversationId || ''));
}

function normalizeCurrentConversation(payload) {
  const data = payload?.protocol?.payload || payload?.payload || payload || {};
  const id = String(
    data.ccode
    || data.conversationId
    || data.UIDSwitchInfo
    || data.uid
    || data.id
    || ''
  ).trim();
  if (!id) return null;
  return {
    id,
    title: String(data.nick || data.customerName || data.buyerName || data.name || id).trim() || id,
    platform: normalizePlatformName(data.platform || 'pdd') || 'pdd',
    lastBuyerText: String(data.lastText || data.lastBuyerText || data.message || '').trim(),
    lastBuyerTime: Number(data.lastBuyerAt || data.lastBuyerTime || data.timestamp) || 0,
    lastAssistantText: String(data.lastAssistantText || '').trim(),
    lastAssistantTime: Number(data.lastAssistantAt || data.lastAssistantTime) || 0,
    lastMessageTime: Number(data.lastMessageTime || data.lastBuyerAt || data.timestamp) || Date.now(),
    unreadCount: 0
  };
}

function applyCurrentConversation(payload) {
  const conversation = normalizeCurrentConversation(payload);
  if (!conversation) return null;
  const existing = state.conversations.get(conversation.id);
  state.conversations.set(conversation.id, {
    ...(existing || {}),
    ...conversation,
    lastBuyerText: conversation.lastBuyerText || existing?.lastBuyerText || '',
    lastBuyerTime: conversation.lastBuyerTime || existing?.lastBuyerTime || 0,
    lastAssistantText: conversation.lastAssistantText || existing?.lastAssistantText || '',
    lastAssistantTime: conversation.lastAssistantTime || existing?.lastAssistantTime || 0,
    unreadCount: existing?.unreadCount || conversation.unreadCount || 0
  });
  state.activeConversationId = conversation.id;
  renderAll();
  return state.conversations.get(conversation.id);
}

function sortedManualItems(filterFn) {
  return Array.from(state.manualConversations.values())
    .filter(filterFn)
    .sort((a, b) => (b.pendingSince || b.lastBuyerAt || 0) - (a.pendingSince || a.lastBuyerAt || 0));
}

function getTemporaryManualItems() {
  return sortedManualItems((item) => String(item.reason || '') === 'manual_takeover');
}

function getPendingHumanItems() {
  return sortedManualItems((item) => String(item.reason || '') !== 'manual_takeover');
}

function renderStatus() {
  const platform = getCurrentPlatform();
  const status = getCurrentStatus();
  const running = Boolean(status?.running);

  setText(els.platform, platformLabel(platform));
  els.connectionDot?.classList?.toggle('online', running);
  setText(
    els.connection,
    running ? `${platformLabel(platform)} 运行中${status?.pid ? ` · PID ${status.pid}` : ''}` : `${platformLabel(platform)} 未启动`
  );

  if (platform === 'pdd') {
    setText(els.cdp, status?.cdpConnected ? 'CDP 已连接' : 'CDP 未连接');
  } else {
    setText(els.cdp, running ? '插件在线' : '等待连接');
  }
}

function renderMetrics() {
  setText(els.pending, getPendingHumanItems().length || '--');
  setText(els.today, state.today);
  setText(els.sent, state.sent);
  setText(els.manualBadge, getTemporaryManualItems().length);
  setText(els.pendingHumanBadge, getPendingHumanItems().length);
  setText(els.ticketReshipmentBadge, state.tickets.reshipment.size);
  setText(els.ticketAddressBadge, state.tickets.address.size);
  setText(els.ticketAfterSaleBadge, state.tickets.afterSale.size);
}

function renderMainTabs() {
  const showAssistant = state.activeMainTab !== 'ticket';
  els.assistantTab?.classList?.toggle('active', showAssistant);
  els.ticketTab?.classList?.toggle('active', !showAssistant);
  els.assistantPanel?.classList?.toggle('hidden', !showAssistant);
  els.ticketPanel?.classList?.toggle('hidden', showAssistant);
}

function renderHandoffSwitch() {
  const showManual = state.activeHandoffList !== 'pending';
  els.manualListAction?.classList?.toggle('active', showManual);
  els.pendingListAction?.classList?.toggle('active', !showManual);
  els.manualMessages?.classList?.toggle('hidden', !showManual);
  els.pendingMessages?.classList?.toggle('hidden', showManual);
}

function renderTicketSwitch() {
  els.ticketReshipmentAction?.classList?.toggle('active', state.activeTicketCategory === 'reshipment');
  els.ticketAddressAction?.classList?.toggle('active', state.activeTicketCategory === 'address');
  els.ticketAfterSaleAction?.classList?.toggle('active', state.activeTicketCategory === 'afterSale');
}

function renderMode() {
  const activeConversation = getActiveConversation();
  const inManual = Boolean(activeConversation && isManualConversation(activeConversation.id));
  const autoReplyText = state.aiEnabled
    ? `AI 已启用${state.aiMerchantName ? ` · ${state.aiMerchantName}` : ''}`
    : '人工值守';

  setText(els.autoReply, autoReplyText);
  setText(els.modeHint, inManual ? '人工接管中' : state.aiEnabled ? 'AI 托管中' : '人工值守');
  if (els.modeHint?.classList) {
    els.modeHint.classList.toggle('manual', inManual);
    els.modeHint.classList.toggle('idle', !state.aiEnabled && !inManual);
  }
  setText(els.manualAction, inManual ? '恢复 AI' : '临时接管');
  if (els.manualAction?.classList) {
    els.manualAction.classList.toggle('danger', !inManual);
    els.manualAction.classList.toggle('primary', inManual);
  }
  setDisabled(els.manualAction, !activeConversation);
}

function renderSelection() {
  const activeConversation = getActiveConversation();
  if (!activeConversation) {
    setText(els.selection, '未选中会话');
    return;
  }

  const manual = state.manualConversations.get(activeConversation.id);
  const stateText = manual
    ? (manual.reason === 'manual_takeover' ? '临时接管' : '待人工回复')
    : activeConversation.unreadCount > 0
      ? `待回复 ${activeConversation.unreadCount}`
      : '已读';
  setText(els.selection, `${activeConversation.title} · ${stateText}`);
}

function renderCurrentConversation() {
  if (!els.currentConversation || typeof document.createElement !== 'function') return;
  const activeConversation = getActiveConversation();
  if (!activeConversation) {
    const title = document.createElement('strong');
    title.textContent = '未选中会话';
    const body = document.createElement('p');
    body.textContent = '点击会话后，这里显示当前会话信息。';
    els.currentConversation.className = 'current-conversation empty-state-card';
    els.currentConversation.replaceChildren(title, body);
    return;
  }

  const manual = state.manualConversations.get(activeConversation.id);
  const header = document.createElement('div');
  header.className = 'current-conversation-header';
  const title = document.createElement('strong');
  title.textContent = activeConversation.title;
  const subtitle = document.createElement('small');
  subtitle.textContent = manual
    ? `状态：${manual.reason === 'manual_takeover' ? '临时接管' : '待人工回复'} · ${waitLabel(manual.pendingSince)}`
    : activeConversation.unreadCount > 0
      ? `状态：待回复 ${activeConversation.unreadCount}`
      : '状态：AI 接待中';
  header.append(title, subtitle);

  const summary = document.createElement('p');
  const buyerText = activeConversation.lastBuyerText || '暂无买家消息';
  const lastTime = activeConversation.lastBuyerTime ? timeLabel(activeConversation.lastBuyerTime) : '--';
  summary.textContent = `${platformLabel(activeConversation.platform)} · ${lastTime} · ${buyerText}`;

  els.currentConversation.className = 'current-conversation';
  els.currentConversation.replaceChildren(header, summary);
}

async function focusConversation(conversation) {
  if (!conversation?.id) return;
  state.activeConversationId = conversation.id;
  renderAll();
  await window.pddFuke.focusConversation?.({
    conversationId: conversation.id,
    customerName: conversation.title,
    platform: conversation.platform
  });
}

async function requestCurrentConversation() {
  if (typeof window.pddFuke.getCurrentPddConv !== 'function') return null;
  return window.pddFuke.getCurrentPddConv({});
}

async function markActiveConversationManual() {
  const activeConversation = getActiveConversation();
  if (!activeConversation) return false;
  const now = Date.now();
  const entry = {
    conversationId: activeConversation.id,
    customerName: activeConversation.title,
    platform: activeConversation.platform,
    reason: 'manual_takeover',
    scope: 'conversation',
    pendingSince: activeConversation.lastBuyerTime || now,
    lastBuyerAt: activeConversation.lastBuyerTime || now,
    lastAssistantAt: activeConversation.lastAssistantTime || 0
  };
  state.manualConversations.set(activeConversation.id, entry);
  renderAll();
  await window.pddFuke.markManualConversation?.(entry);
  return true;
}

function createMessageCard(conversation, options = {}) {
  const card = document.createElement('article');
  const classes = ['message-card'];
  if (options.manual) classes.push('manual');
  if (conversation.id === state.activeConversationId) classes.push('active');
  card.className = classes.join(' ');

  const title = document.createElement('strong');
  title.textContent = `${conversation.title} · ${options.label}`;
  const body = document.createElement('p');
  body.textContent = conversation.lastBuyerText || options.reason || '暂无内容';
  const meta = document.createElement('span');
  meta.className = options.manual ? 'wait' : '';
  meta.textContent = `${waitLabel(options.pendingSince || conversation.lastBuyerTime)} · ${platformLabel(conversation.platform)} · ${timeLabel(options.lastBuyerAt || conversation.lastBuyerTime)}`;

  card.textContent = `${title.textContent} ${body.textContent} ${meta.textContent}`;
  card.append(title, body, meta);
  card.addEventListener('click', async () => {
    await focusConversation(conversation);
  });
  return card;
}

function renderList(container, items, emptyText, options = {}) {
  if (!container || typeof document.createElement !== 'function') return;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = emptyText;
    container.replaceChildren(empty);
    return;
  }

  const cards = items.map((item) => {
    const conversation = conversationFromManual(item);
    return createMessageCard(conversation, {
      manual: options.manual,
      label: options.label,
      reason: item.reason,
      pendingSince: item.pendingSince,
      lastBuyerAt: item.lastBuyerAt
    });
  });
  container.replaceChildren(...cards);
}

function currentTicketItems() {
  return Array.from(state.tickets[state.activeTicketCategory].values())
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

function renderTicketList() {
  if (!els.ticketMessages || typeof document.createElement !== 'function') return;
  const items = currentTicketItems();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `暂无${ticketCategoryLabel(state.activeTicketCategory)}会话`;
    els.ticketMessages.replaceChildren(empty);
    return;
  }

  const cards = items.map((item) => {
    const card = document.createElement('article');
    card.className = 'ticket-card';

    const main = document.createElement('div');
    main.className = 'ticket-card-main';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const summary = document.createElement('p');
    summary.textContent = item.summary || ticketCategoryLabel(item.category);
    const meta = document.createElement('span');
    meta.textContent = `${platformLabel(item.platform)} · ${timeLabel(item.timestamp)}`;
    main.append(title, summary, meta);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '确认';
    button.addEventListener('click', () => {
      state.confirmedTickets.add(item.key);
      state.tickets[item.category].delete(item.conversationId);
      renderAll();
    });

    card.textContent = `${title.textContent} ${summary.textContent} ${meta.textContent} ${button.textContent}`;
    card.append(main, button);
    card.addEventListener('click', async () => {
      await focusConversation(conversationFromTicket(item));
    });
    return card;
  });
  els.ticketMessages.replaceChildren(...cards);
}

function renderPendingAction() {
  if (!els.pendingAction) return;
  const pendingCount = getPendingHumanItems().length;
  els.pendingAction.textContent = pendingCount > 0 ? `查看待人工回复(${pendingCount})` : '查看待人工回复';
  setDisabled(els.pendingAction, pendingCount <= 0);
}

function syncCompactLayout() {
  if (!document.body?.classList?.toggle) return;
  document.body.classList.toggle('compact', Number(window.innerWidth || 0) > 0 && Number(window.innerWidth || 0) <= 220);
}

function renderAll() {
  const activeConversation = getActiveConversation();
  setText(els.lastTime, activeConversation?.lastBuyerTime ? timeLabel(activeConversation.lastBuyerTime) : '--');
  renderStatus();
  renderMetrics();
  renderMainTabs();
  renderMode();
  renderSelection();
  renderPendingAction();
  renderCurrentConversation();
  renderHandoffSwitch();
  renderTicketSwitch();
  renderList(els.manualMessages, getTemporaryManualItems(), '暂无临时接管会话', {
    manual: true,
    label: '临时接管'
  });
  renderList(els.pendingMessages, getPendingHumanItems(), '暂无待人工回复', {
    manual: true,
    label: '待人工回复'
  });
  renderTicketList();
  syncCompactLayout();
}

function normalizePlatform(payload) {
  return normalizePlatformName(payload?.client?.platform || payload?.platform || getCurrentPlatform());
}

function applyManualSnapshot(snapshot) {
  state.manualConversations.clear();
  for (const item of snapshot?.manual || []) {
    const conversationId = String(item.conversationId || '');
    if (!conversationId) continue;
    state.manualConversations.set(conversationId, {
      conversationId,
      customerName: String(item.customerName || ''),
      platform: normalizePlatformName(String(item.platform || '')),
      reason: String(item.reason || ''),
      scope: String(item.scope || ''),
      pendingSince: Number(item.pendingSince) || 0,
      lastBuyerAt: Number(item.lastBuyerAt) || 0,
      lastAssistantAt: Number(item.lastAssistantAt) || 0
    });
  }
  renderAll();
}

function handleIncomingMessage(payload) {
  const message = payload?.message || {};
  const platform = normalizePlatform(payload);
  const conversation = ensureConversation(message, platform);
  const text = preview(message);
  const timestamp = Number(message.timestamp) || Date.now();
  const ticketCategory = ticketCategoryForMessage(message);

  conversation.lastMessageTime = timestamp;
  if (message.direction === 'user') {
    conversation.lastBuyerText = text;
    conversation.lastBuyerTime = timestamp;
    conversation.unreadCount += 1;
    state.today += 1;

    const manual = state.manualConversations.get(conversation.id);
    if (manual) {
      manual.customerName = conversation.title;
      manual.platform = conversation.platform;
      manual.lastBuyerAt = timestamp;
      manual.pendingSince = manual.pendingSince || timestamp;
    }
  } else if (message.direction === 'assistant') {
    conversation.lastAssistantText = text;
    conversation.lastAssistantTime = timestamp;
    conversation.unreadCount = 0;
    state.sent += 1;

    const manual = state.manualConversations.get(conversation.id);
    if (manual) {
      manual.lastAssistantAt = timestamp;
    }
  }

  if (ticketCategory) {
    const key = `${ticketCategory}:${conversation.id}`;
    if (!state.confirmedTickets.has(key)) {
      state.tickets[ticketCategory].set(conversation.id, {
        key,
        category: ticketCategory,
        conversationId: conversation.id,
        title: conversation.title,
        platform: conversation.platform,
        summary: ticketSummary(message, text),
        timestamp
      });
    }
  }

  renderAll();
}

function updatePlatformStatus(platform, status) {
  state.statuses[normalizePlatformName(platform)] = status || null;
  renderStatus();
}

async function bootstrap() {
  try {
    const [status, aiSettings] = await Promise.all([
      window.pddFuke.getStatus?.(),
      window.pddFuke.getAiSettings?.()
    ]);

    state.statuses.pdd = status?.pdd || null;
    state.statuses.qn = status?.qn || null;
    state.aiEnabled = Boolean(aiSettings?.enabled);
    state.aiMerchantName = String(aiSettings?.merchantName || '').trim();
    applyManualSnapshot(status?.handoff || { manual: [] });
  } catch (error) {
    if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(error);
  }

  renderAll();
}

els.close?.addEventListener('click', () => window.pddFuke.closeFloating?.());
els.minimize?.addEventListener('click', () => window.pddFuke.minimizeFloating?.());
els.assistantTab?.addEventListener('click', () => {
  state.activeMainTab = 'assistant';
  renderAll();
});
els.ticketTab?.addEventListener('click', () => {
  state.activeMainTab = 'ticket';
  renderAll();
});
els.manualListAction?.addEventListener('click', () => {
  state.activeHandoffList = 'manual';
  renderAll();
});
els.pendingListAction?.addEventListener('click', () => {
  state.activeHandoffList = 'pending';
  renderAll();
});
els.ticketReshipmentAction?.addEventListener('click', () => {
  state.activeTicketCategory = 'reshipment';
  renderAll();
});
els.ticketAddressAction?.addEventListener('click', () => {
  state.activeTicketCategory = 'address';
  renderAll();
});
els.ticketAfterSaleAction?.addEventListener('click', () => {
  state.activeTicketCategory = 'afterSale';
  renderAll();
});
els.currentConversation?.addEventListener('click', () => {
  requestCurrentConversation().catch((error) => {
    if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(error);
  });
});
els.pendingAction?.addEventListener('click', async () => {
  const next = getPendingHumanItems()[0];
  if (!next) return;
  await focusConversation(conversationFromManual(next));
});
els.manualAction?.addEventListener('click', async () => {
  const activeConversation = getActiveConversation();
  if (!activeConversation) {
    state.pendingManualAfterCurrent = true;
    await requestCurrentConversation();
    return;
  }
  if (isManualConversation(activeConversation.id)) {
    state.manualConversations.delete(activeConversation.id);
    renderAll();
    await window.pddFuke.resumeConversation?.({
      conversationId: activeConversation.id,
      platform: activeConversation.platform
    });
    return;
  }
  await markActiveConversationManual();
});

if (typeof window.addEventListener === 'function') {
  window.addEventListener('resize', syncCompactLayout);
}

window.pddFuke.onPddStatus?.((status) => updatePlatformStatus('pdd', status));
window.pddFuke.onQnStatus?.((status) => updatePlatformStatus('qn', status));
window.pddFuke.onClientConnected?.((client) => {
  if (client?.id) {
    state.clients.set(client.id, {
      ...client,
      platform: normalizePlatformName(client.platform)
    });
  }
  renderStatus();
});
window.pddFuke.onClientDisconnected?.((client) => {
  if (client?.id) state.clients.delete(client.id);
  renderStatus();
});
window.pddFuke.onMessage?.(handleIncomingMessage);
window.pddFuke.onManualState?.(applyManualSnapshot);
window.pddFuke.onProtocolMessage?.((payload) => {
  const type = String(payload?.protocol?.type || payload?.type || '').toLowerCase();
  if (type !== 'currentconv') return;
  const conversation = applyCurrentConversation(payload);
  if (conversation && state.pendingManualAfterCurrent) {
    state.pendingManualAfterCurrent = false;
    markActiveConversationManual().catch((error) => {
      if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(error);
    });
  }
});
window.pddFuke.onCdpStatus?.((status) => {
  if (state.statuses.pdd) {
    state.statuses.pdd = { ...state.statuses.pdd, cdpConnected: Boolean(status?.connected) };
  }
  renderStatus();
});

bootstrap();
