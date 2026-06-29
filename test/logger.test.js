const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileLogger } = require('../main/logger');

test('file logger writes main process logs under local app data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-fuke-logs-'));
  const logger = createFileLogger({ localAppData: root });

  logger.log('[pdd:launch] launch requested');
  logger.error('[cdp:error]', new Error('connect ECONNREFUSED'));

  const logPath = path.join(root, 'pdd-fuke', 'logs', 'main.log');
  const content = fs.readFileSync(logPath, 'utf8');

  assert.match(content, /\[INFO\] \[pdd:launch\] launch requested/);
  assert.match(content, /\[ERROR\] \[cdp:error\] Error: connect ECONNREFUSED/);
});
