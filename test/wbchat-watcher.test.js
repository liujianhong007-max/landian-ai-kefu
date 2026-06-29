const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanWbChatFiles, WbChatWatcher } = require('../main/wbchat-watcher');

function writeFile(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('scanWbChatFiles discovers message and session files across account folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-wbchat-'));
  writeFile(path.join(root, 'account-a', 'message.db-wal'), 'a');
  writeFile(path.join(root, 'account-a', 'session.db-wal'), 'b');
  writeFile(path.join(root, 'account-b', 'message.db'), 'c');
  writeFile(path.join(root, 'account-b', 'ignored.txt'), 'd');

  const files = scanWbChatFiles(root);

  assert.deepEqual(files.map((file) => path.basename(file.path)).sort(), [
    'message.db',
    'message.db-wal',
    'session.db-wal'
  ]);
  assert.deepEqual(new Set(files.map((file) => file.sourceId)), new Set(['account-a', 'account-b']));
});

test('WbChatWatcher emits deduplicated file change diagnostics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-wbchat-'));
  const messageWal = path.join(root, 'account-a', 'message.db-wal');
  writeFile(messageWal, 'first');

  const events = [];
  const watcher = new WbChatWatcher({ root, onChange: (event) => events.push(event) });

  watcher.scanOnce();
  watcher.scanOnce();
  fs.appendFileSync(messageWal, 'second');
  watcher.scanOnce();

  assert.equal(events.length, 2);
  assert.equal(events[0].sourceId, 'account-a');
  assert.equal(events[0].name, 'message.db-wal');
  assert.equal(events[1].size, 'firstsecond'.length);
});
