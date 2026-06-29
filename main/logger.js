'use strict';

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

function formatArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.toString();
  if (typeof arg === 'string') return arg;
  return util.inspect(arg, { depth: 5, breakLength: Infinity });
}

function createFileLogger(options = {}) {
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || process.cwd();
  const logPath = options.logPath || path.join(localAppData, 'pdd-fuke', 'logs', 'main.log');

  function write(level, args) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line = `${new Date().toISOString()} [${level}] ${args.map(formatArg).join(' ')}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  }

  return {
    logPath,
    log: (...args) => write('INFO', args),
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args)
  };
}

module.exports = {
  createFileLogger
};
