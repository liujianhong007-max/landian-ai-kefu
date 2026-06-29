'use strict';

// ============================================================
// 版本管理页面逻辑
// ============================================================

const PLATFORM_NAMES = {
  pdd: '拼多多',
  qn: '千牛',
  dy: '抖音',
  ks: '快手',
  jd: '京东'
};

let currentPlatform = 'pdd';
let isDownloading = false;
let downloadStartTime = 0;
let lastDownloadedSize = 0;
let lastProgressTime = 0;
let currentPhase = 'download'; // 'download' | 'extract'

// ============================================================
// DOM 引用
// ============================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  tabs: $('.vm-tabs'),
  content: $('#versionContent'),
  storageStats: $('#storageStats'),
  downloadProgress: $('#downloadProgress'),
  progressLabel: $('#progressLabel'),
  progressPercent: $('#progressPercent'),
  progressFill: $('#progressFill'),
  progressSpeed: $('#progressSpeed'),
  progressEta: $('#progressEta'),
  progressPhase: $('#progressPhase'),
  btnRefresh: $('#btnRefreshManifest'),
  btnCleanOld: $('#btnCleanOld'),
  btnClose: $('#btnClose')
};

// ============================================================
// API 封装（通过 preload 暴露的 pddFuke）
// ============================================================
const api = window.pddFuke || {};

// OSS 版本管理专用 API（需要 preload 注册）
async function callApi(method, ...args) {
  if (typeof api[method] === 'function') {
    return api[method](...args);
  }
  // 回退：通过 ipcRenderer 直接调用
  const { ipcRenderer } = require('electron');
  const channelMap = {
    getManifest: 'oss:get-manifest',
    refreshManifest: 'oss:refresh-manifest',
    queryVersions: 'oss:query-versions',
    downloadVersion: 'oss:download-version',
    ensureRecommendation: 'oss:ensure-recommendation',
    getLocalVersions: 'oss:get-local-versions',
    getStorageStats: 'oss:get-storage-stats',
    cleanVersion: 'oss:clean-version',
    cleanOldVersions: 'oss:clean-old-versions'
  };
  const channel = channelMap[method];
  if (!channel) throw new Error(`Unknown API method: ${method}`);
  return ipcRenderer.invoke(channel, ...args);
}

// ============================================================
// Toast 提示
// ============================================================
function showToast(message, type = 'info') {
  const existing = document.querySelector('.vm-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `vm-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

// ============================================================
// 存储统计
// ============================================================
async function updateStorageStats() {
  try {
    const stats = await callApi('getStorageStats');
    els.storageStats.innerHTML = `📁 本地存储：${stats.totalSizeFormatted || '0 B'}（${stats.totalFiles || 0} 个版本）`;
  } catch (err) {
    els.storageStats.innerHTML = '📁 本地存储：获取失败';
  }
}

// ============================================================
// 渲染版本列表
// ============================================================
async function renderVersions(platform) {
  els.content.innerHTML = '<div class="vm-loading">加载中...</div>';

  try {
    const versions = await callApi('queryVersions', platform);
    if (!versions || versions.length === 0) {
      els.content.innerHTML = `
        <div class="vm-empty">
          <div class="vm-empty-icon">📭</div>
          <div class="vm-empty-text">${PLATFORM_NAMES[platform] || platform} 暂无可用版本</div>
        </div>`;
      return;
    }

    let html = '';
    for (const v of versions) {
      const isRecommended = v.recommendation;
      const sizeStr = v.size > 0 ? formatFileSize(v.size) : '未知大小';
      const cardClass = [
        'vm-version-card',
        isRecommended ? 'recommended' : '',
        v.downloaded ? 'downloaded' : ''
      ].filter(Boolean).join(' ');

      html += `
        <div class="${cardClass}" data-version="${v.version}">
          <div class="vm-version-badge">
            ${isRecommended ? '<span class="vm-version-tag recommended">⭐ 推荐</span>' : ''}
            ${v.downloaded ? '<span class="vm-version-tag downloaded-tag">✅ 已下载</span>' : ''}
          </div>
          <div class="vm-version-info">
            <div class="vm-version-number">v${v.version}</div>
            <div class="vm-version-meta">
              <span>📦 ${sizeStr}</span>
              ${v.sha256 ? `<span>🔒 SHA256: ${v.sha256.substring(0, 16)}...</span>` : ''}
            </div>
          </div>
          <div class="vm-version-actions">
            ${v.downloaded
              ? `<button class="vm-btn vm-btn-outline vm-btn-sm btn-redownload" data-platform="${platform}" data-version="${v.version}">重新下载</button>
                 <button class="vm-btn vm-btn-outline vm-btn-danger vm-btn-sm btn-delete" data-platform="${platform}" data-version="${v.version}">删除</button>`
              : `<button class="vm-btn vm-btn-primary vm-btn-sm btn-download" data-platform="${platform}" data-version="${v.version}" ${isDownloading ? 'disabled' : ''}>下载</button>`
            }
          </div>
        </div>`;
    }
    els.content.innerHTML = html;

    // 绑定事件
    bindVersionActions();
  } catch (err) {
    els.content.innerHTML = `
      <div class="vm-empty">
        <div class="vm-empty-icon">❌</div>
        <div class="vm-empty-text">加载失败：${err.message}</div>
      </div>`;
  }
}

// ============================================================
// 绑定版本卡片操作按钮
// ============================================================
function bindVersionActions() {
  // 下载按钮
  $$('.btn-download').forEach((btn) => {
    btn.addEventListener('click', () => {
      const platform = btn.dataset.platform;
      const version = btn.dataset.version;
      startDownload(platform, version);
    });
  });

  // 重新下载按钮
  $$('.btn-redownload').forEach((btn) => {
    btn.addEventListener('click', () => {
      const platform = btn.dataset.platform;
      const version = btn.dataset.version;
      startDownload(platform, version);
    });
  });

  // 删除按钮
  $$('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const platform = btn.dataset.platform;
      const version = btn.dataset.version;
      try {
        await callApi('cleanVersion', platform, version);
        showToast(`已删除 ${PLATFORM_NAMES[platform]} v${version}`, 'success');
        await updateStorageStats();
        await renderVersions(currentPlatform);
      } catch (err) {
        showToast(`删除失败：${err.message}`, 'error');
      }
    });
  });
}

// ============================================================
// 下载流程
// ============================================================
function setProgressPhase(phase) {
  currentPhase = phase;
  if (phase === 'extract') {
    els.downloadProgress.classList.add('extracting');
    els.progressPhase.textContent = '📦 解压中';
  } else {
    els.downloadProgress.classList.remove('extracting');
    els.progressPhase.textContent = '⏬ 下载中';
  }
}

function updateSpeedAndEta(downloaded, total) {
  const now = Date.now();
  const elapsedSec = (now - downloadStartTime) / 1000;
  if (elapsedSec < 0.5) return; // 数据太少，不显示

  // 瞬时速度（基于最近一段时间）
  const timeDelta = (now - lastProgressTime) / 1000 || 0.5;
  const sizeDelta = downloaded - lastDownloadedSize;
  const instantSpeed = sizeDelta / timeDelta; // B/s

  // 平均速度
  const avgSpeed = downloaded / elapsedSec;

  // 用加权速度（偏重瞬时速度）
  const speed = timeDelta < 2 ? avgSpeed : instantSpeed * 0.7 + avgSpeed * 0.3;

  els.progressSpeed.textContent = formatFileSize(speed) + '/s';

  // ETA
  if (speed > 0 && total > 0) {
    const remaining = total - downloaded;
    const etaSec = Math.ceil(remaining / speed);
    if (etaSec < 60) {
      els.progressEta.textContent = etaSec + '秒';
    } else if (etaSec < 3600) {
      els.progressEta.textContent = Math.floor(etaSec / 60) + '分' + (etaSec % 60) + '秒';
    } else {
      els.progressEta.textContent = Math.floor(etaSec / 3600) + '时' + Math.floor((etaSec % 3600) / 60) + '分';
    }
  }

  lastDownloadedSize = downloaded;
  lastProgressTime = now;
}

async function startDownload(platform, version) {
  if (isDownloading) {
    showToast('已有下载任务进行中', 'info');
    return;
  }

  isDownloading = true;
  downloadStartTime = Date.now();
  lastDownloadedSize = 0;
  lastProgressTime = Date.now();
  updateDownloadButtons(true);

  els.downloadProgress.style.display = 'block';
  els.progressLabel.textContent = `正在下载 ${PLATFORM_NAMES[platform]} v${version}...`;
  els.progressPercent.textContent = '0%';
  els.progressFill.style.width = '0%';
  els.progressSpeed.textContent = '';
  els.progressEta.textContent = '';
  setProgressPhase('download');

  // 监听下载进度
  const { ipcRenderer } = require('electron');
  const onDownloadProgress = (_event, data) => {
    if (data.platform === platform && data.version === version) {
      els.progressPercent.textContent = data.percent + '%';
      els.progressFill.style.width = data.percent + '%';
      els.progressLabel.textContent = `正在下载 ${PLATFORM_NAMES[platform]} v${version}... ${formatFileSize(data.downloaded)} / ${formatFileSize(data.total)}`;
      updateSpeedAndEta(data.downloaded, data.total);
    }
  };

  const onExtractProgress = (_event, data) => {
    if (data.platform === platform && data.version === version) {
      if (currentPhase !== 'extract') {
        setProgressPhase('extract');
        els.progressSpeed.textContent = '';
        els.progressEta.textContent = '';
        els.progressPercent.textContent = '0%';
        els.progressFill.style.width = '0%';
      }
      els.progressPercent.textContent = data.percent + '%';
      els.progressFill.style.width = data.percent + '%';
      els.progressLabel.textContent = `正在解压 ${PLATFORM_NAMES[platform]} v${version}... ${data.extracted || 0} / ${data.total || '?'} 文件`;
    }
  };

  ipcRenderer.on('oss:download-progress', onDownloadProgress);
  ipcRenderer.on('oss:extract-progress', onExtractProgress);

  try {
    const result = await callApi('downloadVersion', platform, version);
    const extractedInfo = result.extractedDir ? ` → 已解压到 ${result.extractedDir}` : '';
    showToast(`${PLATFORM_NAMES[platform]} v${version} 下载并解压完成！${extractedInfo}`, 'success');
    await updateStorageStats();
    await renderVersions(currentPlatform);
  } catch (err) {
    showToast(`下载失败：${err.message}`, 'error');
  } finally {
    ipcRenderer.removeListener('oss:download-progress', onDownloadProgress);
    ipcRenderer.removeListener('oss:extract-progress', onExtractProgress);
    els.downloadProgress.style.display = 'none';
    els.downloadProgress.classList.remove('extracting');
    els.progressSpeed.textContent = '';
    els.progressEta.textContent = '';
    isDownloading = false;
    updateDownloadButtons(false);
  }
}

function updateDownloadButtons(disabled) {
  $$('.btn-download').forEach((btn) => { btn.disabled = disabled; });
}

// ============================================================
// 工具函数
// ============================================================
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

// ============================================================
// 事件绑定
// ============================================================

// 平台 Tab 切换
els.tabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.vm-tab');
  if (!tab) return;

  const platform = tab.dataset.platform;
  if (platform === currentPlatform) return;

  // 更新 active 状态
  $$('.vm-tab').forEach((t) => t.classList.remove('active'));
  tab.classList.add('active');

  currentPlatform = platform;
  renderVersions(platform);
});

// 刷新清单
els.btnRefresh.addEventListener('click', async () => {
  els.btnRefresh.disabled = true;
  els.btnRefresh.textContent = '⏳ 刷新中...';
  try {
    await callApi('refreshManifest');
    showToast('版本清单已刷新', 'success');
    await renderVersions(currentPlatform);
  } catch (err) {
    showToast(`刷新失败：${err.message}`, 'error');
  } finally {
    els.btnRefresh.disabled = false;
    els.btnRefresh.textContent = '🔄 刷新清单';
  }
});

// 清理旧版本
els.btnCleanOld.addEventListener('click', async () => {
  if (!confirm('确定要清理所有非推荐版本吗？此操作不可恢复。')) return;

  els.btnCleanOld.disabled = true;
  els.btnCleanOld.textContent = '⏳ 清理中...';
  try {
    const result = await callApi('cleanOldVersions');
    const count = result.cleaned?.filter((c) => c.cleaned).length || 0;
    showToast(`已清理 ${count} 个旧版本`, 'success');
    await updateStorageStats();
    await renderVersions(currentPlatform);
  } catch (err) {
    showToast(`清理失败：${err.message}`, 'error');
  } finally {
    els.btnCleanOld.disabled = false;
    els.btnCleanOld.textContent = '🗑 清理旧版';
  }
});

// 关闭窗口
els.btnClose.addEventListener('click', () => {
  window.pddFuke?.closeWindow?.() || window.close();
});

// ============================================================
// 初始化
// ============================================================
async function init() {
  await updateStorageStats();
  await renderVersions(currentPlatform);
}

init();
