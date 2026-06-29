const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readRendererFile(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'renderer', name), 'utf8');
}

test('launcher html uses clean Chinese labels', () => {
  const html = readRendererFile('index.html');
  assert.match(html, /<title>客服启动台<\/title>/);
  assert.match(html, />商品库<\/button>/);
  assert.match(html, />AI设置<\/button>/);
});

test('product library html uses bilingual product labels and upload button', () => {
  const html = readRendererFile('product-library.html');
  assert.match(html, /<title>商品库<\/title>/);
  assert.match(html, />上传服务器<\/button>/);
  assert.match(html, />商品概览 \/ Product overview</);
  assert.match(html, />基础信息 \/ Basic info</);
  assert.match(html, />销售信息 \/ Sales</);
  assert.match(html, />图片素材 \/ Media links</);
  assert.match(html, />SKU 汇总 \/ SKU summary</);

  const refreshIndex = html.indexOf('id="refreshProductsButton"');
  const uploadIndex = html.indexOf('id="uploadProductsButton"');
  const selectAllIndex = html.indexOf('id="selectAllProductsButton"');
  assert.notEqual(refreshIndex, -1);
  assert.notEqual(uploadIndex, -1);
  assert.notEqual(selectAllIndex, -1);
  assert.ok(refreshIndex < uploadIndex && uploadIndex < selectAllIndex);
});

test('ai settings html includes save button and clean Chinese copy', () => {
  const html = readRendererFile('ai-settings.html');
  assert.match(html, /<title>AI 设置<\/title>/);
  assert.match(html, />保存设置<\/button>/);
  assert.match(html, />请求预览</);
});
