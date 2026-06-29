const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createDiagnosticsSnapshot,
  parseProcessDiagnosticsOutput,
  summarizeProcesses,
  extractSendReceipts
} = require('../main/diagnostics-snapshot');

const SAMPLE_PROCESS_OUTPUT = `
[explorer.exe] pid=8616 ppid=8520 session=1 tokenSession=1
  user=user\\26799 elevated=false elevationType=Limited integrity=Medium (8192) authId=00000000:0002e6bc
  exe=C:\\Windows\\Explorer.EXE
  created=2026-06-23 06:45:38.226
  title=(empty)

[fuke-helper.exe] pid=40412 ppid=7456 session=1 tokenSession=1
  user=user\\26799 elevated=true elevationType=Full integrity=High (12288) authId=00000000:0002e411
  exe=(empty)
  created=2026-06-23 12:46:13.698
  title=(empty)

[AliWorkbench.exe] pid=40668 ppid=40412 session=1 tokenSession=1
  user=user\\26799 elevated=false elevationType=Limited integrity=Medium (8192) authId=00000000:0002e6bc
  exe=C:\\Users\\26799\\AppData\\Local\\huihui\\qn\\9.63.20\\AliWorkbench.exe
  created=2026-06-23 12:46:15.362
  title=(empty)
  modules=QnExtend-9.63.20.dll@D:\\Program Files\\fuke\\assets\\inject\\QnExtend-9.63.20.dll

[AliRender.exe] pid=10088 ppid=40668 session=1 tokenSession=1
  user=user\\26799 elevated=false elevationType=Limited integrity=Medium (8192) authId=00000000:0002e6bc
  exe=C:\\Users\\26799\\AppData\\Local\\huihui\\qn\\9.63.20\\9.63.20N\\AliRender.exe
  created=2026-06-23 12:46:15.530
  title=(empty)
  modules=(empty)
`;

test('process diagnostics output parser extracts token and parent chain fields', () => {
  const processes = parseProcessDiagnosticsOutput(SAMPLE_PROCESS_OUTPUT);

  assert.equal(processes.length, 4);
  assert.deepEqual(processes.find((item) => item.name === 'fuke-helper.exe'), {
    name: 'fuke-helper.exe',
    pid: 40412,
    parentPid: 7456,
    session: '1',
    tokenSession: '1',
    user: 'user\\26799',
    elevated: 'true',
    elevationType: 'Full',
    integrity: 'High (12288)',
    authId: '00000000:0002e411',
    exe: null,
    created: '2026-06-23 12:46:13.698',
    title: null
  });
  assert.deepEqual(processes.find((item) => item.name === 'AliWorkbench.exe').modules, [
    'QnExtend-9.63.20.dll@D:\\Program Files\\fuke\\assets\\inject\\QnExtend-9.63.20.dll'
  ]);
});

test('process summary chooses helper parent of main AliWorkbench', () => {
  const summary = summarizeProcesses(parseProcessDiagnosticsOutput(SAMPLE_PROCESS_OUTPUT));

  assert.equal(summary.helperMode, 'fuke-helper');
  assert.equal(summary.helper.pid, 40412);
  assert.equal(summary.workbench.pid, 40668);
  assert.equal(summary.workbench.modules.length, 1);
  assert.equal(summary.renderCount, 1);
});

test('send receipt parser keeps latest QN send status details first', () => {
  const receipts = extractSendReceipts(`
2026-06-23T04:44:10.333Z [INFO] sample statusLabel=失败, responseCode=1, nativeMethod=send_text_message, ccode=buyer-1, content=失败内容
2026-06-23T04:47:10.146Z [INFO] sample statusLabel=成功, ccode=buyer-2, content=成功内容
`);

  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].status, '成功');
  assert.equal(receipts[0].ccode, 'buyer-2');
  assert.equal(receipts[1].responseCode, '1');
  assert.equal(receipts[1].nativeMethod, 'send_text_message');
});

test('diagnostics snapshot combines process tool output and recent send receipts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-diagnostics-'));
  const logPath = path.join(root, 'main.log');
  fs.writeFileSync(logPath, '2026-06-23T04:47:10.146Z [INFO] statusLabel=成功, ccode=buyer-2, content=ok\n', 'utf8');
  const toolPath = path.join(root, 'ProcessDiagnostics.exe');
  fs.writeFileSync(toolPath, '', 'utf8');

  const snapshot = await createDiagnosticsSnapshot({
    processToolPath: toolPath,
    logPath,
    now: () => 123,
    execFileImpl: async () => ({ stdout: SAMPLE_PROCESS_OUTPUT })
  });

  assert.equal(snapshot.time, 123);
  assert.equal(snapshot.processTool.ok, true);
  assert.equal(snapshot.summary.helperMode, 'fuke-helper');
  assert.equal(snapshot.sendReceipts[0].status, '成功');
});
