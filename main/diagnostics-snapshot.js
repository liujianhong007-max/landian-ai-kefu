'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DEFAULT_PROCESS_TOOL = path.join(__dirname, '..', 'tools', 'process-diagnostics', 'bin', 'ProcessDiagnostics.exe');
const DEFAULT_MAIN_LOG = path.join(process.env.LOCALAPPDATA || process.cwd(), 'pdd-fuke', 'logs', 'main.log');

function parseProcessDiagnosticsOutput(output) {
  const processes = [];
  let current = null;

  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = line.match(/^\[([^\]]+)\]\s+pid=(\d+)\s+ppid=(\d+)\s+session=([^\s]+)\s+tokenSession=([^\s]+)/);
    if (header) {
      current = {
        name: header[1],
        pid: Number(header[2]),
        parentPid: Number(header[3]),
        session: header[4],
        tokenSession: header[5]
      };
      processes.push(current);
      continue;
    }

    if (!current) continue;

    const token = line.match(/^user=(.*?)\s+elevated=(.*?)\s+elevationType=(.*?)\s+integrity=(.*?)\s+authId=(.*)$/);
    if (token) {
      current.user = emptyToNull(token[1]);
      current.elevated = emptyToNull(token[2]);
      current.elevationType = emptyToNull(token[3]);
      current.integrity = emptyToNull(token[4]);
      current.authId = emptyToNull(token[5]);
      continue;
    }

    const field = line.match(/^(exe|created|title|tokenError|processError)=(.*)$/);
    if (field) current[field[1]] = emptyToNull(field[2]);

    const modules = line.match(/^modules=(.*)$/);
    if (modules) {
      const value = emptyToNull(modules[1]);
      current.modules = value ? value.split(/\s+\|\s+/).filter(Boolean) : [];
    }
  }

  return processes;
}

function summarizeProcesses(processes) {
  const helpers = processes.filter((item) => /^(lg-helper|fuke-helper|Pdd(?:Lg|Fuke|Landian)Helper)/i.test(item.name || ''));
  const workbenches = processes.filter((item) => item.name === 'AliWorkbench.exe');
  const renders = processes.filter((item) => item.name === 'AliRender.exe');
  const helperByPid = new Map(helpers.map((item) => [item.pid, item]));
  const mainWorkbench = workbenches.find((item) => helperByPid.has(item.parentPid)) || workbenches[0] || null;
  const helper = mainWorkbench ? helperByPid.get(mainWorkbench.parentPid) : helpers.at(-1) || null;

  return {
    helper: helper ? summarizeProcess(helper) : null,
    workbench: mainWorkbench ? summarizeProcess(mainWorkbench) : null,
    renderCount: renders.length,
    helperMode: helper ? helper.name.replace(/\.exe$/i, '') : 'unknown'
  };
}

function extractSendReceipts(logText, limit = 10) {
  const lines = String(logText || '').split(/\r?\n/);
  const receipts = [];

  for (const line of lines) {
    if (!/statusLabel=|nativeMethod=send_text_message|responseCode=/.test(line)) continue;
    const status = matchValue(line, /statusLabel=([^,\s]+)/);
    const responseCode = matchValue(line, /responseCode=([^,\s]+)/);
    const nativeMethod = matchValue(line, /nativeMethod=([^,\s]+)/);
    const ccode = matchValue(line, /ccode=([^,\s]+)/);
    const content = matchValue(line, /content=([^'}]+)/);
    receipts.push({
      at: matchValue(line, /^(\S+)/) || '',
      status: status || (/失败/.test(line) ? '失败' : (/成功/.test(line) ? '成功' : '')),
      responseCode: responseCode || '',
      nativeMethod: nativeMethod || '',
      ccode: ccode || '',
      content: String(content || '').slice(0, 120)
    });
  }

  return receipts.slice(-limit).reverse();
}

function extractRecentEvents(logText, limit = 12) {
  const patterns = [
    /\[helper:start\]/,
    /\[helper:hello\]/,
    /\[qn:launch/,
    /\[ws:client-connected\]/,
    /\[auto-reply:sent\]/,
    /\[auto-reply:qn-switch\]/,
    /statusLabel=/
  ];

  return String(logText || '')
    .split(/\r?\n/)
    .filter((line) => patterns.some((pattern) => pattern.test(line)))
    .slice(-limit)
    .map((line) => line.slice(0, 260))
    .reverse();
}

async function createDiagnosticsSnapshot(options = {}) {
  const processToolPath = options.processToolPath || DEFAULT_PROCESS_TOOL;
  const logPath = options.logPath || DEFAULT_MAIN_LOG;
  const execFileImpl = options.execFileImpl || execFileAsync;
  const now = options.now || (() => Date.now());

  let processOutput = '';
  let processError = null;
  try {
    if (!fs.existsSync(processToolPath)) throw new Error(`ProcessDiagnostics.exe not found: ${processToolPath}`);
    const result = await execFileImpl(processToolPath, [], {
      windowsHide: true,
      timeout: options.timeoutMs || 8000,
      maxBuffer: 1024 * 1024
    });
    processOutput = result.stdout || '';
  } catch (error) {
    processError = error.message || String(error);
    processOutput = error.stdout || '';
  }

  const logText = readTail(logPath, options.logBytes || 256 * 1024);
  const processes = parseProcessDiagnosticsOutput(processOutput);

  return {
    time: now(),
    processTool: {
      ok: !processError,
      path: processToolPath,
      error: processError
    },
    summary: summarizeProcesses(processes),
    processes,
    sendReceipts: extractSendReceipts(logText),
    recentEvents: extractRecentEvents(logText)
  };
}

function readTail(filePath, maxBytes) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function summarizeProcess(process) {
  return {
    name: process.name,
    pid: process.pid,
    parentPid: process.parentPid,
    user: process.user,
    elevated: process.elevated,
    elevationType: process.elevationType,
    integrity: process.integrity,
    authId: process.authId,
    created: process.created,
    modules: process.modules || []
  };
}

function emptyToNull(value) {
  const text = String(value || '').trim();
  return text === '(empty)' || text === '(unknown)' ? null : text;
}

function matchValue(text, pattern) {
  const match = String(text || '').match(pattern);
  return match ? match[1] : '';
}

module.exports = {
  createDiagnosticsSnapshot,
  parseProcessDiagnosticsOutput,
  summarizeProcesses,
  extractSendReceipts,
  extractRecentEvents,
  readTail
};
