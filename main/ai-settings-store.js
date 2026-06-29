'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_BASE_URL } = require('./tmagent-client');

const DEFAULT_AI_SETTINGS = {
  provider: 'tmagent',
  enabled: true,
  baseUrl: DEFAULT_BASE_URL,
  merchantName: '',
  tenantId: '',
  apiKey: '',
  headerName: 'X-API-Key',
  shopOverrides: {}
};

function normalizeShopOverrideKey(platform, shopId) {
  const rawPlatform = String(platform || '').trim().toLowerCase();
  const normalizedPlatform = rawPlatform === 'publicplatform'
    ? 'pdd'
    : (rawPlatform === 'taobao' ? 'qn' : rawPlatform);
  const normalizedShopId = String(shopId || '').trim();
  if (!normalizedPlatform || !normalizedShopId) return '';
  return `${normalizedPlatform}::${normalizedShopId}`;
}

function normalizeShopOverrides(input = {}) {
  const overrides = {};
  if (!input || typeof input !== 'object') return overrides;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const value = rawValue && typeof rawValue === 'object' ? rawValue : {};
    const fallbackPlatform = String(rawKey || '').split('::')[0] || '';
    const fallbackShopId = String(rawKey || '').split('::').slice(1).join('::') || '';
    const platform = String(value.platform || fallbackPlatform).trim();
    const shopId = String(value.shopId || fallbackShopId).trim();
    const key = normalizeShopOverrideKey(platform, shopId);
    if (!key) continue;
    overrides[key] = {
      platform: key.split('::')[0],
      shopId: key.split('::').slice(1).join('::'),
      shopName: String(value.shopName || '').trim(),
      enabled: value.enabled !== false,
      updatedAt: Number(value.updatedAt) || Date.now()
    };
  }
  return overrides;
}

function normalizeAiSettings(input = {}) {
  return {
    provider: 'tmagent',
    enabled: input.enabled !== false,
    baseUrl: String(input.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL,
    merchantName: String(input.merchantName || '').trim(),
    tenantId: String(input.tenantId || '').trim(),
    apiKey: String(input.apiKey || '').trim(),
    headerName: 'X-API-Key',
    shopOverrides: normalizeShopOverrides(input.shopOverrides)
  };
}

function getAiSettingsPath(options = {}) {
  return options.filePath || path.join(options.baseDir || path.join(__dirname, '..', 'config'), 'ai-settings.local.json');
}

function readAiSettings(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const filePath = getAiSettingsPath(options);

  if (!fsImpl.existsSync(filePath)) return { ...DEFAULT_AI_SETTINGS };

  try {
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeAiSettings(parsed);
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

function saveAiSettings(input, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const filePath = getAiSettingsPath(options);
  const settings = normalizeAiSettings(input);
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

module.exports = {
  DEFAULT_AI_SETTINGS,
  normalizeShopOverrideKey,
  normalizeShopOverrides,
  normalizeAiSettings,
  getAiSettingsPath,
  readAiSettings,
  saveAiSettings
};
