const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_AI_SETTINGS,
  normalizeAiSettings,
  readAiSettings,
  saveAiSettings
} = require('../main/ai-settings-store');

test('normalize ai settings keeps tmagent shape', () => {
  const normalized = normalizeAiSettings({
    enabled: false,
    baseUrl: 'http://tmagent.local/',
    merchantName: '疾风AI客服',
    tenantId: 'tenant-1',
    apiKey: 'sk-test'
  });

  assert.deepEqual(normalized, {
    provider: 'tmagent',
    enabled: false,
    baseUrl: 'http://tmagent.local/',
    merchantName: '疾风AI客服',
    tenantId: 'tenant-1',
    apiKey: 'sk-test',
    headerName: 'X-API-Key',
    shopOverrides: {}
  });
});

test('read ai settings returns defaults when file is missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-settings-'));
  const result = readAiSettings({ baseDir: tempDir });
  assert.deepEqual(result, DEFAULT_AI_SETTINGS);
});

test('save ai settings persists and read ai settings loads them back', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-settings-'));
  const saved = saveAiSettings({
    enabled: true,
    baseUrl: 'http://xingqiao.taluo.club',
    merchantName: '疾风AI客服',
    tenantId: '9901d2b1-6abc-41d7-a41e-91501b794735',
    apiKey: 'sk-HXY'
  }, { baseDir: tempDir });

  const loaded = readAiSettings({ baseDir: tempDir });

  assert.equal(saved.tenantId, '9901d2b1-6abc-41d7-a41e-91501b794735');
  assert.equal(loaded.merchantName, '疾风AI客服');
  assert.equal(loaded.apiKey, 'sk-HXY');
  assert.equal(loaded.headerName, 'X-API-Key');
  assert.deepEqual(loaded.shopOverrides, {});
});

test('normalize ai settings keeps per-shop overrides', () => {
  const normalized = normalizeAiSettings({
    enabled: true,
    shopOverrides: {
      'pdd::440745': {
        platform: 'pdd',
        shopId: '440745',
        shopName: '霸派运动户外旗舰店',
        enabled: false,
        updatedAt: 1710000000000
      }
    }
  });

  assert.equal(normalized.shopOverrides['pdd::440745'].enabled, false);
  assert.equal(normalized.shopOverrides['pdd::440745'].shopName, '霸派运动户外旗舰店');
});
