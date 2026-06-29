'use strict';

const state = {
  clients: new Map(),
  conversations: new Map(),
  manualConversations: new Map(),
  events: [],
  activeConversationId: null,
  activeTab: 'pending',
  aiEnabled: false,
  aiMerchantName: '',
  today: 0,
  sent: 0,
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
  messages: document.getElementById('pluginMessages'),
  emptyState: document.getElementById('pluginEmptyState'),
  lastTime: document.getElementById('pluginLastTime'),
  clients: document.getElementById('pluginClients'),
  events: document.getElementById('pluginEvents'),
  autoReply: document.getElementById('pluginAutoReply'),
  modeHint: document.getElementById('pluginModeHint'),
  selection: document.getElementById('pluginSelection'),
  pendingAction: document.getElementById('pluginPendingAction'),
  manualAction: document.getElementById('pluginManualAction'),
  tabPending: document.getElementById('pluginTabPending'),
  tabManual: document.getElementById('pluginTabManual'),
  manualBadge: document.getElementById('pluginManualBadge'),
  close: document.getElementById('pluginClose'),
  minimize: document.getElementById('pluginMinimize')
};

function normalizePlatformName(platform) {
  if (platform === 'publicplatform') return 'pdd';
  return platform || '';
}

function setText(el, value) {
  if (el) el.textContent = String(value);
}

function timeLabel(value) {
  if (!value) return '--';
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function waitLabel(value) {
  if (!value) return '已回复';
  const deltaMs = Math.max(0, Date.now() - Number(value));
  const totalMinutes = Math.floor(deltaMs / 60000);
  if (totalMinutes < 1) return '等待 1分钟内';
  if (totalMinutes < 60) return `等待 ${totalMinutes}分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `等待 ${hours}小时${minutes}分钟` : `等待 ${hours}小时`;
}

function preview(message) {
  if (!message) return '';
  if (message.kind === 'text') return String(message.content?.text || '').trim();
  if (message.kind === 'goods') return `[商品] ${message.content?.goodsName || ''}`.trim();
  if (message.kind === 'order') return `[订单] ${message.content?.orderSn || message.content?.orderId || ''}`.trim();
  if (message.kind === 'image') return '[图片]';
  return `[${message.kind || '消息'}]`;
}

function platformLabel(platform) {
  platform = normalizePlatformName(platform);
  if (platform === 'qn') return '千牛';
  if (platform === 'pdd' || platform === 'publicplatform') return '拼多多';
  return '平台';
}

function addEvent(label, detail) {
  state.events.unshift({
    at: Date.now(),
    label,
    detail: detail ? String(detail) : ''
  });
  state.events = state.events.slice(0, 12);
  renderEvents();
}

function renderEvents() {
  if (!els.events || typeof document.createElement !== 'function') return;
  const items = state.events.map((event) => {
    const item = document.createElement('div');
    item.className = 'plugin-event';
    item.textContent = `${timeLabel(event.at)} ${event.label}${event.detail ? ` - ${event.detail}` : ''}`;
    return item;
  });
  els.events.replaceChildren(...items);
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
      lastMessageTime: 0,
      unreadCount: 0
    });
  }
  const conversation = state.conversations.get(id);
  if (message.senderName) conversation.title = String(message.senderName);
  if (platform) conversation.platform = platform;
  return conversation;
}

function getConversationList() {
  return Array.from(state.conversations.values()).sort((a, b) => {
    const timeDelta = (b.lastBuyerTime || 0) - (a.lastBuyerTime || 0);
    if (timeDelta !== 0) return timeDelta;
    return (b.lastMessageTime || 0) - (a.lastMessageTime || 0);
  });
}

function getPendingConversations() {
  return getConversationList().filter((item) => item.unreadCount > 0);
}

function getManualConversations() {
  return Array.from(state.manualConversations.values()).sort((a, b) => {
    const left = b.pendingSince || b.lastBuyerAt || 0;
    const right = a.pendingSince || a.lastBuyerAt || 0;
    return left - right;
  });
}

function getActiveConversation() {
  if (!state.activeConversationId) return null;
  return state.conversations.get(state.activeConversationId) || null;
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
  const platform = getCurrentPlatform();
  return state.statuses[platform] || null;
}

function isManualConversation(conversationId) {
  return state.manualConversations.has(String(conversationId || ''));
}

function getDisplayConversations() {
  return state.activeTab === 'manual' ? getManualConversations() : getPendingConversations();
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
  setText(els.pending, getPendingConversations().length || '--');
  setText(els.today, state.today);
  setText(els.sent, state.sent);
  setText(els.clients, `${state.clients.size} client${state.clients.size === 1 ? '' : 's'}`);
}

function renderTabs() {
  const manualCount = getManualConversations().length;
  setText(els.manualBadge, manualCount);
  els.tabPending?.classList?.toggle('active', state.activeTab === 'pending');
  els.tabManual?.classList?.toggle('active', state.activeTab === 'manual');
}

function renderMode() {
  const activeConversation = getActiveConversation();
  const inManual = Boolean(activeConversation && isManualConversation(activeConversation.id));
  const autoReplyText = state.aiEnabled
    ? `AI 已启用${state.aiMerchantName ? ` · ${state.aiMerchantName}` : ''}`
    : '人工值守';

  setText(els.autoReply, autoReplyText);
  setText(els.modeHint, inManual ? '人工跟进中' : state.aiEnabled ? 'AI 托管中' : '人工值守');
  setText(els.manualAction, inManual ? '继续接待' : '转人工');
}

function renderSelection() {
  const activeConversation = getActiveConversation();
  if (!activeConversation) {
    setText(els.selection, '暂无会话');
    return;
  }

  const pendingText = isManualConversation(activeConversation.id)
    ? '待人工处理'
    : activeConversation.unreadCount > 0
      ? `待回复 ${activeConversation.unreadCount}`
      : '已读';
  setText(els.selection, `${activeConversation.title} · ${pendingText}`);
}

async function focusConversation(conversation) {
  if (!conversation) return;
  state.activeConversationId = conversation.id;
  renderAll();
  await window.pddFuke.focusConversation?.({
    conversationId: conversation.id,
    customerName: conversation.title,
    platform: conversation.platform
  });
}

function renderMessages() {
  if (!els.messages || typeof document.createElement !== 'function') return;
  const items = getDisplayConversations();

  if (!items.length) {
    const empty = els.emptyState || document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.activeTab === 'manual' ? '暂无待人工会话' : '暂无买家消息';
    els.messages.replaceChildren(empty);
    return;
  }

  const cards = items.map((item) => {
    const conversation = state.activeTab === 'manual'
      ? state.conversations.get(item.conversationId) || {
          id: item.conversationId,
          title: item.customerName || item.conversationId,
          platform: item.platform || 'pdd',
          lastBuyerText: '',
          lastBuyerTime: item.lastBuyerAt || item.pendingSince || 0,
          lastMessageTime: item.lastBuyerAt || item.pendingSince || 0,
          unreadCount: 0
        }
      : item;

    const card = document.createElement('article');
    const classes = ['message-card'];
    if (state.activeTab === 'manual') classes.push('manual');
    if (conversation.id === state.activeConversationId) classes.push('active');
    card.className = classes.join(' ');

    const title = document.createElement('strong');
    title.textContent = state.activeTab === 'manual'
      ? `${conversation.title} · 待人工`
      : `${conversation.title} · 待回复`;

    const body = document.createElement('p');
    body.textContent = conversation.lastBuyerText || '暂无内容';

    const meta = document.createElement('span');
    if (state.activeTab === 'manual') {
      const manual = state.manualConversations.get(conversation.id);
      meta.className = 'wait';
      meta.textContent = `${waitLabel(manual?.pendingSince)} · ${platformLabel(conversation.platform)} · ${timeLabel(manual?.lastBuyerAt || manual?.pendingSince)}`;
    } else {
      meta.textContent = `${platformLabel(conversation.platform)} · ${timeLabel(conversation.lastBuyerTime)}`;
    }

    card.textContent = `${title.textContent} ${body.textContent} ${meta.textContent}`;
    card.append(title, body, meta);
    card.addEventListener('click', async () => {
      await focusConversation(conversation);
    });
    return card;
  });

  els.messages.replaceChildren(...cards);
}

function renderPendingAction() {
  if (!els.pendingAction) return;
  const pendingCount = getPendingConversations().length;
  els.pendingAction.textContent = pendingCount > 0 ? `查看待回复 (${pendingCount})` : '查看待回复';
}

function renderAll() {
  const activeConversation = getActiveConversation();
  setText(els.lastTime, activeConversation?.lastBuyerTime ? timeLabel(activeConversation.lastBuyerTime) : '--');
  renderStatus();
  renderMetrics();
  renderTabs();
  renderMode();
  renderSelection();
  renderPendingAction();
  renderMessages();
}

function normalizePlatform(payload) {
  return normalizePlatformName(payload?.client?.platform || payload?.platform || getCurrentPlatform());
}

function applyManualSnapshot(snapshot) {
  state.manualConversations.clear();
  for (const item of snapshot?.manual || []) {
    state.manualConversations.set(String(item.conversationId), {
      conversationId: String(item.conversationId),
      customerName: String(item.customerName || ''),
      platform: normalizePlatformName(String(item.platform || '')),
      reason: String(item.reason || ''),
      scope: String(item.scope || ''),
      pendingSince: Number(item.pendingSince) || 0,
      lastBuyerAt: Number(item.lastBuyerAt) || 0,
      lastAssistantAt: Number(item.lastAssistantAt) || 0
    });
  }
  if (state.activeTab === 'manual' && !getManualConversations().length) {
    state.activeTab = 'pending';
  }
  renderAll();
}

function handleIncomingMessage(payload) {
  const message = payload?.message || {};
  const platform = normalizePlatform(payload);
  const conversation = ensureConversation(message, platform);
  const text = preview(message);
  const timestamp = Number(message.timestamp) || Date.now();

  conversation.lastMessageTime = timestamp;
  if (message.direction === 'user') {
    conversation.lastBuyerText = text;
    conversation.lastBuyerTime = timestamp;
    conversation.unreadCount += 1;
    state.today += 1;
    state.activeConversationId = conversation.id;

    const manual = state.manualConversations.get(conversation.id);
    if (manual) {
      manual.customerName = conversation.title;
      manual.platform = conversation.platform;
      manual.lastBuyerAt = timestamp;
      manual.pendingSince = manual.pendingSince || timestamp;
    }
  } else if (message.direction === 'assistant') {
    conversation.unreadCount = 0;
    state.sent += 1;

    const manual = state.manualConversations.get(conversation.id);
    if (manual) {
      manual.lastAssistantAt = timestamp;
      manual.pendingSince = 0;
    }
  }

  addEvent(message.direction === 'assistant' ? 'assistant reply' : 'buyer message', conversation.title);
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
    addEvent('init error', error?.message || String(error));
  }

  renderAll();
}

els.close?.addEventListener('click', () => window.pddFuke.closeFloating?.());
els.minimize?.addEventListener('click', () => window.pddFuke.minimizeFloating?.());
els.tabPending?.addEventListener('click', () => {
  state.activeTab = 'pending';
  renderAll();
});
els.tabManual?.addEventListener('click', () => {
  state.activeTab = 'manual';
  const first = getManualConversations()[0];
  if (first) state.activeConversationId = first.conversationId;
  renderAll();
});
els.pendingAction?.addEventListener('click', async () => {
  const next = getPendingConversations()[0];
  if (!next) return;
  state.activeTab = 'pending';
  await focusConversation(next);
});
els.manualAction?.addEventListener('click', async () => {
  const activeConversation = getActiveConversation();
  if (!activeConversation) return;
  if (isManualConversation(activeConversation.id)) {
    await window.pddFuke.resumeConversation?.({
      conversationId: activeConversation.id,
      platform: activeConversation.platform
    });
    state.manualConversations.delete(activeConversation.id);
    if (state.activeTab === 'manual' && !getManualConversations().length) state.activeTab = 'pending';
    renderAll();
    return;
  }
  state.manualConversations.set(activeConversation.id, {
    conversationId: activeConversation.id,
    customerName: activeConversation.title,
    platform: activeConversation.platform,
    pendingSince: activeConversation.lastBuyerTime || Date.now(),
    lastBuyerAt: activeConversation.lastBuyerTime || Date.now(),
    lastAssistantAt: 0
  });
  state.activeTab = 'manual';
  renderAll();
});

window.pddFuke.onPddStatus?.((status) => {
  updatePlatformStatus('pdd', status);
  addEvent('pdd status', status?.running ? 'running' : 'stopped');
});
window.pddFuke.onQnStatus?.((status) => {
  updatePlatformStatus('qn', status);
  addEvent('qn status', status?.running ? 'running' : 'stopped');
});
window.pddFuke.onClientConnected?.((client) => {
  if (client?.id) {
    state.clients.set(client.id, {
      ...client,
      platform: normalizePlatformName(client.platform)
    });
  }
  renderMetrics();
  renderStatus();
  addEvent('client connected', client?.platform || 'unknown');
});
window.pddFuke.onClientDisconnected?.((client) => {
  if (client?.id) state.clients.delete(client.id);
  renderMetrics();
  renderStatus();
  addEvent('client disconnected', client?.platform || client?.id || 'unknown');
});
window.pddFuke.onMessage?.(handleIncomingMessage);
window.pddFuke.onManualState?.((snapshot) => {
  applyManualSnapshot(snapshot);
  addEvent('manual state', `${(snapshot?.manual || []).length} conversation(s)`);
});
window.pddFuke.onBridgeDiagnostic?.(({ diagnostic }) => {
  addEvent(`probe ${diagnostic?.name || ''}`.trim(), diagnostic?.payload?.url || diagnostic?.payload?.target || '');
});
window.pddFuke.onCdpStatus?.((status) => {
  if (state.statuses.pdd) {
    state.statuses.pdd = { ...state.statuses.pdd, cdpConnected: Boolean(status?.connected) };
  }
  renderStatus();
});
window.pddFuke.onWsError?.((payload) => addEvent('ws error', payload?.error || ''));
window.pddFuke.onPddError?.((message) => addEvent('pdd error', message));

bootstrap();
