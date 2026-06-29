const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { looksLikePddShopName, pickBestPddShopName, createPddBridgeScript, startPddBridgeServer } = require('../main/pdd-bridge-runtime');

function getText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body }));
    }).on('error', reject);
  });
}

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

test('pdd bridge server can select QN lite bridge by option', async () => {
  const server = await startPddBridgeServer({ wsPort: 4567, qnBridgeMode: 'lite' });
  try {
    const response = await getText(server.qnUrl);

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /qn-bridge-lite/);
  } finally {
    await server.close();
  }
});
