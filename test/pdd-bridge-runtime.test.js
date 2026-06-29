const test = require('node:test');
const assert = require('node:assert/strict');

const { looksLikePddShopName, pickBestPddShopName, createPddBridgeScript } = require('../main/pdd-bridge-runtime');

test('looksLikePddShopName filters technical and non-shop labels', () => {
  assert.equal(looksLikePddShopName('正版桌游店'), true);
  assert.equal(looksLikePddShopName('霸王运动户外旗舰店'), true);
  assert.equal(looksLikePddShopName('主账号'), false);
  assert.equal(looksLikePddShopName('在线'), false);
  assert.equal(looksLikePddShopName('publicplatform'), false);
});

test('pickBestPddShopName prefers active top shop tab', () => {
  const result = pickBestPddShopName([
    { text: '正版桌游店', top: 58, left: 108, active: false },
    { text: '霸王运动户外旗舰店', top: 14, left: 34, active: true },
    { text: '主账号', top: 52, left: 118, active: false }
  ]);

  assert.equal(result, '霸王运动户外旗舰店');
});

test('createPddBridgeScript seeds websocket handshake with shop and csr query params', () => {
  const script = createPddBridgeScript(15978);

  assert.match(script, /buildHandshakeUrl/);
  assert.match(script, /params\.set\('platform', 'pdd'\)/);
  assert.match(script, /params\.set\('csrName', csrName\)/);
  assert.match(script, /params\.set\('targetId', targetId\)/);
  assert.match(script, /shopName = normalizeShopLabel\(user\?\..*\|\| user\?\.mall_name/);
  assert.match(script, /username/);
  assert.match(script, /cs_id/);
});
