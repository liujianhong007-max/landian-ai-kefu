'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { QnManager } = require('../main/qn-manager');

const logPath = path.join(process.env.LOCALAPPDATA || process.cwd(), 'pdd-fuke', 'logs', 'main.log');
const nativeHelperPath = path.join(__dirname, '..', 'helper-native', 'build', 'Release', 'fuke-helper.exe');

function latestMatch(text, pattern) {
  return [...text.matchAll(pattern)].at(-1);
}

function readCurrentBridge() {
  const log = fs.readFileSync(logPath, 'utf8');
  const bridge = latestMatch(log, /\[pdd-bridge:http-start\][\s\S]*?qnUrl: '([^']+)'/g);
  const ws = latestMatch(log, /\[ws:listening\][\s\S]*?port: (\d+)/g);
  if (!bridge || !ws) {
    throw new Error('Current Electron bridge/ws port not found in main.log');
  }
  return {
    qnUrl: bridge[1],
    wsPort: Number(ws[1])
  };
}

async function main() {
  process.env.PDD_FUKE_HELPER_ELEVATE = '1';
  const bridge = readCurrentBridge();
  console.log('[native-qn] bridge', bridge);
  console.log('[native-qn] helper', nativeHelperPath);

  const logger = {
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args)
  };
  const manager = new QnManager({
    logger,
    helperPath: nativeHelperPath,
    jsUrl: bridge.qnUrl,
    wsPort: bridge.wsPort
  });

  const status = await manager.launch();
  console.log('[native-qn] launch status', status);
  console.log('[native-qn] keeping helper alive');
  setInterval(() => {}, 60_000);
}

main().catch((error) => {
  console.error('[native-qn] failed', error);
  process.exit(1);
});
