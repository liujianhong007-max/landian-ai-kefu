'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LAUNCH_SETTINGS = {
  pdd: {
    exePath: '',
    helperPath: '',
    dllPath: ''
  },
  qn: {
    exePath: '',
    helperPath: '',
    dllPath: '',
    injectMode: '',
    launchCooldownMs: 60000
  },
  qnBridge: 'fuke'
};

function cleanString(value) {
  return String(value || '').trim();
}

function normalizeCooldownMs(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LAUNCH_SETTINGS.qn.launchCooldownMs;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LAUNCH_SETTINGS.qn.launchCooldownMs;
  return Math.max(0, Math.floor(parsed));
}

function normalizeQnBridge(value) {
  const bridge = cleanString(value).toLowerCase();
  return bridge === 'lite' ? 'lite' : 'fuke';
}

function normalizeLaunchSettings(input = {}) {
  const pdd = input.pdd && typeof input.pdd === 'object' ? input.pdd : {};
  const qn = input.qn && typeof input.qn === 'object' ? input.qn : {};

  return {
    pdd: {
      exePath: cleanString(pdd.exePath),
      helperPath: cleanString(pdd.helperPath),
      dllPath: cleanString(pdd.dllPath)
    },
    qn: {
      exePath: cleanString(qn.exePath),
      helperPath: cleanString(qn.helperPath),
      dllPath: cleanString(qn.dllPath),
      injectMode: cleanString(qn.injectMode),
      launchCooldownMs: normalizeCooldownMs(qn.launchCooldownMs)
    },
    qnBridge: normalizeQnBridge(input.qnBridge)
  };
}

function getLaunchSettingsPath(options = {}) {
  return options.filePath || path.join(options.baseDir || path.join(__dirname, '..', 'config'), 'launch-settings.local.json');
}

function readLaunchSettings(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const filePath = getLaunchSettingsPath(options);

  if (!fsImpl.existsSync(filePath)) return { ...DEFAULT_LAUNCH_SETTINGS, pdd: { ...DEFAULT_LAUNCH_SETTINGS.pdd }, qn: { ...DEFAULT_LAUNCH_SETTINGS.qn } };

  try {
    return normalizeLaunchSettings(JSON.parse(fsImpl.readFileSync(filePath, 'utf8')));
  } catch {
    return { ...DEFAULT_LAUNCH_SETTINGS, pdd: { ...DEFAULT_LAUNCH_SETTINGS.pdd }, qn: { ...DEFAULT_LAUNCH_SETTINGS.qn } };
  }
}

function saveLaunchSettings(input, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const filePath = getLaunchSettingsPath(options);
  const settings = normalizeLaunchSettings(input);
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

module.exports = {
  DEFAULT_LAUNCH_SETTINGS,
  normalizeLaunchSettings,
  getLaunchSettingsPath,
  readLaunchSettings,
  saveLaunchSettings
};
