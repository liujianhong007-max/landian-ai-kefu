'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CACHE = {
  config: null,
  fetchedAt: 0
};

function getCachePath(options = {}) {
  return options.filePath || path.join(options.baseDir || path.join(__dirname, '..', 'config'), 'agent-config-cache.json');
}

function readCache(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const filePath = getCachePath(options);
  if (!fsImpl.existsSync(filePath)) return { ...DEFAULT_CACHE };
  try {
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CACHE };
  }
}

function writeCache(payload, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const filePath = getCachePath(options);
  const data = {
    config: payload || null,
    fetchedAt: Date.now()
  };
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}

module.exports = { DEFAULT_CACHE, getCachePath, readCache, writeCache };
