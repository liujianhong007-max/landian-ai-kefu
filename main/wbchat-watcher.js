'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WBCHAT_ROOT = path.join(
  'C:\\Users\\Public\\Documents',
  'PDD',
  'WorkbenchDB',
  'WBChat',
  'Data'
);
const WATCHED_NAMES = new Set(['message.db', 'message.db-wal', 'session.db', 'session.db-wal']);
const noopLogger = { log() {}, error() {} };

function scanWbChatFiles(root = DEFAULT_WBCHAT_ROOT) {
  if (!fs.existsSync(root)) return [];

  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const sourceId = entry.name;
    const sourceRoot = path.join(root, sourceId);
    for (const name of WATCHED_NAMES) {
      const filePath = path.join(sourceRoot, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        result.push({
          sourceId,
          name,
          path: filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          mtime: stat.mtime.toISOString()
        });
      } catch {
        // File can disappear while PDD is rotating WAL files; ignore and rescan later.
      }
    }
  }

  return result.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

class WbChatWatcher {
  constructor({ root = DEFAULT_WBCHAT_ROOT, intervalMs = 1000, onChange = () => {}, logger = noopLogger } = {}) {
    this.root = root;
    this.intervalMs = intervalMs;
    this.onChange = onChange;
    this.logger = logger;
    this.timer = null;
    this.seen = new Map();
  }

  start() {
    if (this.timer) return;
    this.scanOnce();
    this.timer = setInterval(() => this.scanOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  scanOnce() {
    let files;
    try {
      files = scanWbChatFiles(this.root);
    } catch (error) {
      this.logger.error('[wbchat:scan-error]', error);
      return [];
    }

    const changes = [];
    for (const file of files) {
      const key = file.path;
      const signature = `${file.size}:${file.mtimeMs}`;
      if (this.seen.get(key) === signature) continue;

      this.seen.set(key, signature);
      changes.push(file);
      this.logger.log('[wbchat:file-change]', file);
      this.onChange(file);
    }

    return changes;
  }
}

module.exports = {
  DEFAULT_WBCHAT_ROOT,
  WATCHED_NAMES,
  scanWbChatFiles,
  WbChatWatcher
};
