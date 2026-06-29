const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_LAUNCH_SETTINGS,
  normalizeLaunchSettings,
  readLaunchSettings,
  saveLaunchSettings
} = require('../main/launch-settings-store');

test('read launch settings returns defaults when file is missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-settings-'));
  assert.deepEqual(readLaunchSettings({ baseDir: tempDir }), DEFAULT_LAUNCH_SETTINGS);
});

test('normalize launch settings keeps only launch-related fields', () => {
  const normalized = normalizeLaunchSettings({
    pdd: {
      exePath: ' C:\\Pdd\\PddWorkbench.exe ',
      helperPath: ' C:\\tools\\PddFukeHelper.exe ',
      dllPath: ' C:\\dll\\PddExtend.dll ',
      ignored: true
    },
    qn: {
      exePath: ' C:\\Qn\\AliWorkbench.exe ',
      helperPath: ' C:\\tools\\PddFukeHelper.exe ',
      dllPath: ' C:\\dll\\QnExtend.dll ',
      injectMode: ' thread-context-w ',
      launchCooldownMs: '3000'
    },
    qnBridge: ' lite ',
    extra: 'ignored'
  });

  assert.deepEqual(normalized, {
    pdd: {
      exePath: 'C:\\Pdd\\PddWorkbench.exe',
      helperPath: 'C:\\tools\\PddFukeHelper.exe',
      dllPath: 'C:\\dll\\PddExtend.dll'
    },
    qn: {
      exePath: 'C:\\Qn\\AliWorkbench.exe',
      helperPath: 'C:\\tools\\PddFukeHelper.exe',
      dllPath: 'C:\\dll\\QnExtend.dll',
      injectMode: 'thread-context-w',
      launchCooldownMs: 3000
    },
    qnBridge: 'lite'
  });
});

test('save launch settings persists normalized settings', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-settings-'));
  const saved = saveLaunchSettings({
    pdd: { exePath: 'C:\\Pdd\\PddWorkbench.exe' },
    qn: { launchCooldownMs: -1 },
    qnBridge: 'unknown'
  }, { baseDir: tempDir });

  const loaded = readLaunchSettings({ baseDir: tempDir });

  assert.equal(saved.pdd.exePath, 'C:\\Pdd\\PddWorkbench.exe');
  assert.equal(saved.qn.launchCooldownMs, 0);
  assert.equal(saved.qnBridge, 'fuke');
  assert.deepEqual(loaded, saved);
});
