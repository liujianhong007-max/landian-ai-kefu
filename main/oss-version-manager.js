'use strict';

/**
 * 版本管理器
 * 
 * 职责：
 * 1. 从云端拉取各平台工作台的版本清单
 * 2. 下载指定版本的工作台压缩包到本地
 * 3. 校验文件完整性（SHA256）
 * 4. 管理本地已下载版本缓存
 * 
 * 版本清单和安装包托管于自有服务器
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');

const streamPipeline = promisify(pipeline);
const execFileAsync = promisify(execFile);

// ============================================================
// 常量
// ============================================================

/** 本地工作台存储根目录 */
const DEFAULT_STORAGE_ROOT = path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '.', 'pdd-fuke', 'workbenches');

/** 云端版本清单 URL */
const DEFAULT_MANIFEST_URL = 'https://tm.agent.taluo.club/download/versions-manifest.json';

/** 本地版本清单缓存文件名 */
const MANIFEST_CACHE_FILE = 'versions-manifest.json';

/** 下载超时（毫秒） */
const DOWNLOAD_TIMEOUT = 30 * 60 * 1000; // 30分钟（大文件可达 500MB）

/** 并发下载数上限 */
const MAX_CONCURRENT_DOWNLOADS = 2;

// ============================================================
// 工具函数
// ============================================================

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 计算文件 SHA256
 */
function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * 格式化文件大小
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

/**
 * 从 URL 提取文件名
 */
function fileNameFromUrl(url) {
  const u = new URL(url);
  const basename = path.basename(u.pathname);
  return basename || 'download.zip';
}

/**
 * 使用 PowerShell 解压 zip（Windows 原生，无需额外依赖）
 * @param {string} zipPath - zip 文件路径
 * @param {string} extractDir - 解压目标目录
 * @param {function} [onProgress] - 进度回调 ({ extracted, total, percent, currentFile })
 * @returns {Promise<string>} 解压后的根目录路径
 */
async function extractZip(zipPath, extractDir, onProgress) {
  // 清空目标目录
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  ensureDir(extractDir);

  // 先统计总文件数（用 PowerShell 的 Expand-Archive 无法实时获取进度，
  // 所以我们用 .NET ZipFile 逐文件解压来获取进度）
  const psScript = `
$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
$total = $zip.Entries.Count
$extracted = 0
foreach ($entry in $zip.Entries) {
  $targetPath = Join-Path '${extractDir.replace(/'/g, "''")}' $entry.FullName
  $targetDir = Split-Path $targetPath -Parent
  if (!(Test-Path $targetDir)) {
    [System.IO.Directory]::CreateDirectory($targetDir) | Out-Null
  }
  if ($entry.Name -ne '') {
    try {
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
    } catch {}
  }
  $extracted++
  Write-Output ("PROGRESS:" + $extracted + "/" + $total + ":" + $entry.FullName)
}
$zip.Dispose()
Write-Output "DONE:$extracted"
`;

  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', psScript
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 20 * 60 * 1000 // 解压最多 20 分钟
    });

    let lastProgress = null;

    child.stdout.on('data', (data) => {
      const lines = data.toString().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('PROGRESS:')) {
          const [, progressStr, currentFile] = line.split(':');
          const [extracted, total] = progressStr.split('/').map(Number);
          const percent = total > 0 ? Math.round((extracted / total) * 100) : 0;
          lastProgress = { extracted, total, percent, currentFile };
          if (typeof onProgress === 'function') {
            onProgress(lastProgress);
          }
        } else if (line.startsWith('DONE:')) {
          // 解压完成
        }
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(extractDir);
      } else {
        reject(new Error(`解压失败 (exit code ${code})`));
      }
    });

    child.on('error', reject);
  });
}

/**
 * 获取解压后的工作台根目录
 * 解压后的目录通常是 extractDir/{平台名} 或 extractDir/ 直接就是内容
 */
function getExtractedRoot(extractDir) {
  if (!fs.existsSync(extractDir)) return null;
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  // 如果只有一个子目录，返回子目录
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1 && entries.length === 1) {
    return path.join(extractDir, dirs[0].name);
  }
  // 否则返回 extractDir 本身
  return extractDir;
}

function executableNameForPlatform(platform) {
  const key = String(platform || '').toLowerCase();
  if (key === 'pdd') return 'PddWorkbench.exe';
  if (key === 'qn') return 'AliWorkbench.exe';
  if (key === 'dy') return 'douyin.exe';
  if (key === 'ks') return 'KwaiShop.exe';
  if (key === 'jd') return 'JingMaiWorkbench.exe';
  return '';
}

function hasExtractedExecutable(extractDir, platform) {
  const executableName = executableNameForPlatform(platform);
  const root = getExtractedRoot(extractDir);
  return Boolean(executableName && root && fs.existsSync(path.join(root, executableName)));
}

// ============================================================
// 版本清单管理
// ============================================================

/**
 * 从 OSS 拉取版本清单
 * @param {object} options
 * @param {string} [options.manifestUrl] - 版本清单 URL
 * @param {number} [options.timeout=30000] - 请求超时
 * @returns {Promise<object>} 版本清单对象
 */
async function fetchManifest(options = {}) {
  const manifestUrl = options.manifestUrl || DEFAULT_MANIFEST_URL;
  const timeout = options.timeout || 30000;

  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const http = require('node:http');
    const url = new URL(manifestUrl);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      rejectUnauthorized: false,
      timeout
    }, (res) => {
      // 跟随重定向
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        fetchManifest({ ...options, manifestUrl: res.headers.location })
          .then(resolve).catch(reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`获取版本清单失败: HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const manifest = JSON.parse(data);
          resolve(manifest);
        } catch (err) {
          reject(new Error(`版本清单解析失败: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('获取版本清单超时')); });
    req.end();
  });
}

/**
 * 读取本地缓存的版本清单
 */
function readCachedManifest(storageRoot) {
  const root = storageRoot || DEFAULT_STORAGE_ROOT;
  const cachePath = path.join(root, MANIFEST_CACHE_FILE);
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 写入本地缓存的版本清单
 */
function writeCachedManifest(manifest, storageRoot) {
  const root = storageRoot || DEFAULT_STORAGE_ROOT;
  ensureDir(root);
  const cachePath = path.join(root, MANIFEST_CACHE_FILE);
  fs.writeFileSync(cachePath, JSON.stringify(manifest, null, 2), 'utf8');
}

// ============================================================
// 下载管理
// ============================================================

/** 当前活跃的下载任务 */
const activeDownloads = new Map();

/**
 * 下载文件（支持断点续传提示、进度回调）
 * @param {object} options
 * @param {string} options.url - 下载 URL
 * @param {string} options.destPath - 本地保存路径
 * @param {function} [options.onProgress] - 进度回调 ({ downloaded, total, percent })
 * @param {number} [options.timeout] - 超时时间
 * @returns {Promise<{ filePath: string, size: number }>}
 */
function downloadFile(options = {}) {
  const { url, destPath, onProgress, timeout = DOWNLOAD_TIMEOUT } = options;

  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const http = require('node:http');
    const targetUrl = new URL(url);
    const transport = targetUrl.protocol === 'https:' ? https : http;

    const req = transport.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      rejectUnauthorized: false,
      timeout
    }, (res) => {
      // 跟随重定向
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        downloadFile({ ...options, url: res.headers.location })
          .then(resolve).catch(reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}`));
        return;
      }

      const totalSize = parseInt(res.headers['content-length'] || '0', 10);
      let downloadedSize = 0;
      const destDir = path.dirname(destPath);
      ensureDir(destDir);

      const fileStream = fs.createWriteStream(destPath);

      res.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (typeof onProgress === 'function') {
          onProgress({
            downloaded: downloadedSize,
            total: totalSize,
            percent: totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0
          });
        }
      });

      streamPipeline(res, fileStream)
        .then(() => {
          const stats = fs.statSync(destPath);
          resolve({ filePath: destPath, size: stats.size });
        })
        .catch(reject);
    });

    req.on('error', (err) => reject(new Error(`下载出错: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
    req.end();
  });
}

/**
 * 下载并校验工作台版本（含自动解压）
 * @param {object} options
 * @param {string} options.platform - 平台标识 (pdd/qn/dy/ks/jd)
 * @param {string} options.version - 版本号
 * @param {string} options.downloadUrl - 下载地址
 * @param {string} [options.sha256] - 预期 SHA256
 * @param {string} [options.storageRoot] - 存储根目录
 * @param {function} [options.onProgress] - 下载进度回调
 * @param {function} [options.onExtractProgress] - 解压进度回调
 * @returns {Promise<{ platform: string, version: string, filePath: string, extractedDir: string|null, size: number, sha256: string, verified: boolean }>}
 */
async function downloadAndVerify(options = {}) {
  const { platform, version, downloadUrl, sha256, storageRoot, onProgress, onExtractProgress } = options;
  const root = storageRoot || DEFAULT_STORAGE_ROOT;
  const platformDir = path.join(root, platform, version);
  const fileName = fileNameFromUrl(downloadUrl);
  const destPath = path.join(platformDir, fileName);
  const extractedDir = path.join(platformDir, 'extracted');

  // 如果已下载且校验通过，且已解压，直接返回
  if (fs.existsSync(destPath) && hasExtractedExecutable(extractedDir, platform)) {
    try {
      const fileSha256 = await computeSha256(destPath);
      if (!sha256 || fileSha256 === sha256) {
        const stats = fs.statSync(destPath);
        return {
          platform,
          version,
          filePath: destPath,
          extractedDir: getExtractedRoot(extractedDir),
          size: stats.size,
          sha256: fileSha256,
          verified: true
        };
      }
    } catch {
      // 校验失败，重新下载
    }
  }

  // 清理旧文件
  try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* ignore */ }
  try { if (fs.existsSync(extractedDir)) fs.rmSync(extractedDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // 下载
  const result = await downloadFile({ url: downloadUrl, destPath, onProgress });

  // 校验
  const fileSha256 = await computeSha256(destPath);
  const verified = !sha256 || fileSha256 === sha256;

  if (sha256 && !verified) {
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    throw new Error(`SHA256 校验失败: 预期 ${sha256}, 实际 ${fileSha256}`);
  }

  // 自动解压
  let finalExtractedDir = null;
  try {
    await extractZip(destPath, extractedDir, onExtractProgress);
    finalExtractedDir = getExtractedRoot(extractedDir);
  } catch (extractErr) {
    // 解压失败不阻塞主流程，但记录错误
    throw new Error(`解压失败: ${extractErr.message}`);
  }

  return {
    platform,
    version,
    filePath: destPath,
    extractedDir: finalExtractedDir,
    size: result.size,
    sha256: fileSha256,
    verified
  };
}

// ============================================================
// 版本查询
// ============================================================

/**
 * 获取指定平台的所有可用版本
 * @param {object} options
 * @param {string} options.platform - 平台标识
 * @param {object} [options.manifest] - 版本清单（不传则从缓存读取）
 * @param {string} [options.storageRoot] - 存储根目录
 * @returns {Array<{ version: string, downloadUrl: string, size: number, sha256: string, downloaded: boolean, localPath: string|null }>}
 */
async function getPlatformVersions(options = {}) {
  const { platform, manifest: inputManifest, storageRoot } = options;
  const root = storageRoot || DEFAULT_STORAGE_ROOT;

  let manifest = inputManifest;
  if (!manifest) {
    manifest = readCachedManifest(root);
    if (!manifest) {
      return []; // 无缓存，返回空列表
    }
  }

  if (!manifest || !manifest.platforms || !manifest.platforms[platform]) {
    return [];
  }

  const platformData = manifest.platforms[platform];
  const packages = platformData.packages || [];

  const result = [];
  for (const pkg of packages) {
    const platformDir = path.join(root, platform, pkg.version);
    const fileName = fileNameFromUrl(pkg.download_url);
    const localPath = path.join(platformDir, fileName);
    const downloaded = fs.existsSync(localPath);

    let localSize = 0;
    let localSha256 = '';
    if (downloaded) {
      try {
        const stats = fs.statSync(localPath);
        localSize = stats.size;
        localSha256 = await computeSha256(localPath);
      } catch { /* ignore */ }
    }

    result.push({
      version: pkg.version,
      downloadUrl: pkg.download_url,
      size: pkg.size || localSize || 0,
      sha256: pkg.sha256 || localSha256 || '',
      downloaded,
      localPath: downloaded ? localPath : null,
      recommendation: platformData.recommendation === pkg.version
    });
  }

  return result;
}

/**
 * 获取本地已下载的所有工作台版本
 * @param {string} [storageRoot]
 * @returns {object} { platform: { version: { filePath, size, sha256 } } }
 */
function getLocalVersions(storageRoot) {
  const root = storageRoot || DEFAULT_STORAGE_ROOT;
  const result = {};

  if (!fs.existsSync(root)) return result;

  const platforms = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const platform of platforms) {
    const platformDir = path.join(root, platform);
    const versions = fs.readdirSync(platformDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    if (versions.length > 0) {
      result[platform] = {};
      for (const version of versions) {
        const versionDir = path.join(platformDir, version);
        const files = fs.readdirSync(versionDir).filter((f) => f.endsWith('.zip'));
        if (files.length > 0) {
          const filePath = path.join(versionDir, files[0]);
          try {
            const stats = fs.statSync(filePath);
            result[platform][version] = {
              filePath,
              size: stats.size,
              mtime: stats.mtime.toISOString()
            };
          } catch { /* ignore */ }
        }
      }
    }
  }

  return result;
}

// ============================================================
// 主入口：版本管理器工厂
// ============================================================

/**
 * 创建 OSS 版本管理器实例
 * @param {object} options
 * @param {string} [options.storageRoot] - 本地存储根目录
 * @param {string} [options.manifestUrl] - 版本清单 URL
 * @param {object} [options.logger] - 日志对象
 * @returns {object} 版本管理器 API
 */
function createOssVersionManager(options = {}) {
  const storageRoot = options.storageRoot || DEFAULT_STORAGE_ROOT;
  const manifestUrl = options.manifestUrl || DEFAULT_MANIFEST_URL;
  const logger = options.logger || console;

  ensureDir(storageRoot);

  /**
   * 刷新版本清单（从 OSS 拉取最新 + 写入本地缓存）
   */
  async function refreshManifest() {
    try {
      logger.log('[oss:refresh-manifest]', '拉取版本清单...');
      const manifest = await fetchManifest({ manifestUrl });
      writeCachedManifest(manifest, storageRoot);
      logger.log('[oss:refresh-manifest]', '版本清单已更新');
      return manifest;
    } catch (err) {
      logger.log('[oss:refresh-manifest]', `OSS 拉取失败: ${err.message}`);
      // OSS 不可用 → 尝试本地缓存（上次成功拉取的）
      const cached = readCachedManifest(storageRoot);
      if (cached) {
        logger.log('[oss:refresh-manifest]', '使用本地缓存的版本清单');
        return cached;
      }
      // 缓存也没有 → 明确报错，不给用户过期数据
      throw new Error(`无法获取版本清单：${err.message}，且本地无缓存。请检查网络连接后重试。`);
    }
  }

  /**
   * 获取版本清单（优先缓存）
   */
  async function getManifest(forceRefresh = false) {
    if (!forceRefresh) {
      const cached = readCachedManifest(storageRoot);
      if (cached) return cached;
    }
    return refreshManifest();
  }

  /**
   * 查询平台可用版本
   */
  async function queryVersions(platform) {
    const manifest = await getManifest();
    return getPlatformVersions({ platform, manifest, storageRoot });
  }

  /**
   * 下载指定版本（含自动解压）
   * @param {string} platform - 平台标识
   * @param {string} version - 版本号
   * @param {function} [onProgress] - 下载进度回调
   * @param {function} [onExtractProgress] - 解压进度回调
   * @returns {Promise<object>} 下载结果（含 extractedDir）
   */
  async function downloadVersion(platform, version, onProgress, onExtractProgress) {
    const manifest = await getManifest();
    const packages = manifest.platforms?.[platform]?.packages || [];
    const pkg = packages.find((p) => p.version === version);
    if (!pkg) {
      throw new Error(`未找到平台 ${platform} 的版本 ${version}`);
    }

    logger.log('[oss:download]', { platform, version, url: pkg.download_url });
    return downloadAndVerify({
      platform,
      version,
      downloadUrl: pkg.download_url,
      sha256: pkg.sha256 || '',
      storageRoot,
      onProgress,
      onExtractProgress
    });
  }

  /**
   * 下载推荐版本（如果本地没有）
   * @param {string} platform - 平台标识
   * @param {function} [onProgress] - 下载进度回调
   * @param {function} [onExtractProgress] - 解压进度回调
   */
  async function ensureRecommendation(platform, onProgress, onExtractProgress) {
    const manifest = await getManifest();
    const platformData = manifest.platforms?.[platform];
    if (!platformData) throw new Error(`未知平台: ${platform}`);

    const recommendation = platformData.recommendation;
    if (!recommendation) throw new Error(`平台 ${platform} 没有推荐版本`);

    // 检查本地是否已有
    const localVersions = getLocalVersions(storageRoot);
    if (localVersions[platform]?.[recommendation]) {
      logger.log('[oss:ensure]', `${platform}@${recommendation} 已存在本地`);
      return { ...localVersions[platform][recommendation], platform, version: recommendation, alreadyExists: true };
    }

    return downloadVersion(platform, recommendation, onProgress, onExtractProgress);
  }

  /**
   * 获取存储统计
   */
  function getStorageStats() {
    const localVersions = getLocalVersions(storageRoot);
    let totalSize = 0;
    let totalFiles = 0;
    const platforms = {};

    for (const [platform, versions] of Object.entries(localVersions)) {
      platforms[platform] = Object.keys(versions).length;
      for (const [, info] of Object.entries(versions)) {
        totalSize += info.size || 0;
        totalFiles++;
      }
    }

    return {
      storageRoot,
      totalSize,
      totalSizeFormatted: formatBytes(totalSize),
      totalFiles,
      platforms
    };
  }

  /**
   * 清理指定版本
   */
  function cleanVersion(platform, version) {
    const versionDir = path.join(storageRoot, platform, version);
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
      logger.log('[oss:clean]', { platform, version, path: versionDir });
      return { cleaned: true, platform, version };
    }
    return { cleaned: false, platform, version, reason: 'not-found' };
  }

  /**
   * 清理所有旧版本（仅保留每个平台的推荐版本）
   */
  async function cleanOldVersions() {
    const manifest = await getManifest();
    const cleaned = [];
    const localVersions = getLocalVersions(storageRoot);

    for (const [platform, versions] of Object.entries(localVersions)) {
      const recommendation = manifest.platforms?.[platform]?.recommendation;
      for (const version of Object.keys(versions)) {
        if (version !== recommendation) {
          const result = cleanVersion(platform, version);
          cleaned.push(result);
        }
      }
    }

    return { cleaned };
  }

  return {
    storageRoot,
    getManifest,
    refreshManifest,
    queryVersions,
    downloadVersion,
    ensureRecommendation,
    getLocalVersions: () => getLocalVersions(storageRoot),
    getStorageStats,
    cleanVersion,
    cleanOldVersions
  };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  createOssVersionManager,
  DEFAULT_STORAGE_ROOT,
  DEFAULT_MANIFEST_URL,
  fetchManifest,
  readCachedManifest,
  writeCachedManifest,
  downloadFile,
  downloadAndVerify,
  extractZip,
  getExtractedRoot,
  hasExtractedExecutable,
  getPlatformVersions,
  getLocalVersions,
  computeSha256,
  formatBytes,
  fileNameFromUrl
};
