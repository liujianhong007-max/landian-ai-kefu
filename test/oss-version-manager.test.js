const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hasExtractedExecutable } = require('../main/oss-version-manager');

test('oss extracted version is unavailable when extracted directory is empty', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-extracted-'));
  const extractedDir = path.join(tempDir, 'extracted');
  fs.mkdirSync(extractedDir);

  try {
    assert.equal(hasExtractedExecutable(extractedDir, 'pdd'), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('oss extracted version is available when expected executable exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-extracted-'));
  const extractedDir = path.join(tempDir, 'extracted');
  fs.mkdirSync(extractedDir);
  fs.writeFileSync(path.join(extractedDir, 'PddWorkbench.exe'), '');

  try {
    assert.equal(hasExtractedExecutable(extractedDir, 'pdd'), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
