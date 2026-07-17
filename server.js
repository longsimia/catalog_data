'use strict';
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');
const zlib    = require('zlib');
const { TextDecoder } = require('util');
const { OAuth2Client } = require('google-auth-library');
const sharp   = require('sharp');
const iconv   = require('iconv-lite');

const app      = express();
const PORT     = process.env.PORT || 3000;
const ROOT     = __dirname;
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'catalog_data');
const DATA     = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : DEFAULT_DATA_DIR;
const DEFAULT_INITIAL_ADMIN_USERNAME = 'admin';
const DEFAULT_INITIAL_ADMIN_PASSWORD = 'admin123456';
const BOOTSTRAP_ADMIN_USERNAME = String(process.env.BOOTSTRAP_ADMIN_USERNAME || '').trim();
const BOOTSTRAP_ADMIN_PASSWORD = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
const UPLOADS  = path.join(DATA, 'uploads');
const TEXT_HISTORY_DIR = path.join(DATA, 'text-history');
const TEXT_HISTORY_RETENTION_MS = 72 * 60 * 60 * 1000;
const TEXT_HISTORY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const APP_TIME_ZONE = 'Asia/Taipei';
const THUMB_MAX_EDGE = 400;
const THUMB_QUALITY = 80;
const DOCX_PARSER_DEBUG = /^(?:1|true|yes|on)$/i.test(String(process.env.DOCX_PARSER_DEBUG || ''));
const PREVIEW_NOTO_FONT_LINKS = '<link rel="preconnect" href="https://fonts.googleapis.com">\n  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif:wght@300;400;600;700&family=Noto+Serif+TC:wght@300;400;600;700&family=Noto+Serif+SC:wght@300;400;600;700&family=Noto+Serif+JP:wght@300;400;600;700&family=Noto+Serif+KR:wght@300;400;600;700&display=swap" rel="stylesheet">';
const PREVIEW_SERIF_FONT_STACK = 'Georgia,"Times New Roman","Noto Serif TC","Noto Serif SC","Noto Serif JP","Noto Serif KR","Noto Serif","Songti TC","PMingLiU",serif';
const DOCX_RUN_FALLBACK_SERIF_STACK = '"Noto Serif TC","Noto Serif SC","Noto Serif JP","Noto Serif KR","Noto Serif","Microsoft JhengHei","PingFang TC",serif';
const CAT_FILE = path.join(DATA, 'catalog.json');
const CFG_FILE = path.join(DATA, 'config.json');
const VALID_COLLECTION_MODES = new Set(['scenario', 'image']);
const ROLE_PERMISSION_KEYS = [
  'onlinePreview',
  'createPreviewShare',
  'downloadFiles',
  'uploadItems',
  'editCategories',
  'editTags',
  'editItemOrder',
  'editItemInfo',
  'editTxtAttachments',
  'deleteItems'
];
const DEFAULT_COLLECTIONS = [
  { key: 'scenario', label: '資料庫', mode: 'scenario' },
  { key: 'image', label: '圖庫', mode: 'image' }
];
const MANAGE_LOCK_TTL_MS = 45 * 1000;
const PREVIEW_SHARE_ACCESS_TTL_MS = 1000 * 60 * 60 * 12;
const managePageLocks = new Map();

// 確保目錄存在
[DATA, UPLOADS].forEach(d => fs.mkdirSync(d, { recursive: true }));

const THUMB_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

// ── 工具函式 ──────────────────────────────────────
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function normalizeHttpOrigin(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

function normalizePublicShareSiteSlug(raw = '') {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

function getDefaultInitialAuthUser() {
  return {
    id: 'default-admin',
    username: DEFAULT_INITIAL_ADMIN_USERNAME,
    passwordHash: sha256(DEFAULT_INITIAL_ADMIN_PASSWORD),
    role: 'owner'
  };
}

function getBootstrapAuthUser() {
  if (!BOOTSTRAP_ADMIN_USERNAME || !BOOTSTRAP_ADMIN_PASSWORD) return null;
  return {
    id: 'bootstrap-owner',
    username: BOOTSTRAP_ADMIN_USERNAME,
    passwordHash: sha256(BOOTSTRAP_ADMIN_PASSWORD),
    role: 'owner'
  };
}

function getActiveManagePageLock(collection = 'scenario') {
  const key = sanitizeCollectionKey(collection);
  const entry = managePageLocks.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    managePageLocks.delete(key);
    return null;
  }
  return entry;
}

function setManagePageLock(collection = 'scenario', payload = {}) {
  const key = sanitizeCollectionKey(collection);
  const entry = {
    ...payload,
    collection: key,
    updatedAt: Date.now(),
    expiresAt: Date.now() + MANAGE_LOCK_TTL_MS
  };
  managePageLocks.set(key, entry);
  return entry;
}

function clearManagePageLock(collection = 'scenario', sessionId = '') {
  const key = sanitizeCollectionKey(collection);
  const entry = getActiveManagePageLock(key);
  if (!entry) return false;
  if (sessionId && entry.sessionId !== sessionId) return false;
  managePageLocks.delete(key);
  return true;
}

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function safeStatFsBytes(targetPath) {
  try {
    const stat = fs.statfsSync(targetPath);
    const blockSize = Number(stat.bsize || stat.frsize || 0);
    const totalBytes = Number(stat.blocks || 0) * blockSize;
    const freeBytes = Number(stat.bfree || 0) * blockSize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? Math.min(100, Math.max(0, Math.round((usedBytes / totalBytes) * 1000) / 10)) : 0
    };
  } catch {
    return {
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      usedPercent: 0
    };
  }
}

function scanDirSize(absPath, visitFile) {
  if (!absPath || !fs.existsSync(absPath)) return 0;
  const stack = [absPath];
  let total = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const size = fs.statSync(entryPath).size;
        total += size;
        if (visitFile) visitFile(entryPath, size);
      } catch {}
    }
  }
  return total;
}

function getHostUsageSnapshot() {
  const volume = safeStatFsBytes(DATA);
  let uploadBytes = 0;
  let thumbBytes = 0;
  const uploadsBytes = scanDirSize(UPLOADS, (entryPath, size) => {
    const rel = path.relative(UPLOADS, entryPath).split(path.sep).join('/');
    if (rel.includes('/.thumbs/') || rel.startsWith('.thumbs/')) thumbBytes += size;
    else uploadBytes += size;
  });

  let configBytes = 0;
  let otherDataBytes = 0;
  scanDirSize(DATA, (entryPath, size) => {
    const normalized = path.resolve(entryPath);
    if (normalized.startsWith(path.resolve(UPLOADS) + path.sep) || normalized === path.resolve(UPLOADS)) return;
    const rel = path.relative(DATA, entryPath).split(path.sep).join('/');
    const base = path.basename(entryPath);
    if (
      base === path.basename(CFG_FILE) ||
      base === path.basename(CAT_FILE) ||
      /^catalog-.*\.json$/i.test(base) ||
      /^trash(?:-.*)?\.json$/i.test(base) ||
      rel.startsWith('.update_state/')
    ) {
      configBytes += size;
    } else {
      otherDataBytes += size;
    }
  });

  const appBytes = uploadsBytes + configBytes + otherDataBytes;
  return {
    path: DATA,
    volume,
    app: {
      totalBytes: appBytes,
      uploadsBytes: uploadBytes,
      thumbsBytes: thumbBytes,
      configBytes,
      otherBytes: otherDataBytes
    }
  };
}

function decodeUploadFilename(name) {
  const raw = String(name || '');
  if (!raw) return '';
  if (!/[\u00C0-\u00FF]/.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(decoded)) return decoded;
    return decoded.includes('\uFFFD') ? raw : decoded;
  } catch {
    return raw;
  }
}

function normalizeDownloadFiles(item) {
  const list = Array.isArray(item.downloadFiles) ? item.downloadFiles : [];
  const normalized = list
    .filter(entry => entry && typeof entry.key === 'string' && entry.key.trim())
    .map(entry => ({
      key: entry.key,
      name: sanitizeDownloadName(decodeUploadFilename(entry.name || path.basename(entry.key)), path.basename(entry.key)),
      size: Number(entry.size) > 0 ? Number(entry.size) : undefined,
      relativePath: typeof entry.relativePath === 'string' && entry.relativePath.trim()
        ? entry.relativePath.trim().replace(/\\/g, '/')
        : undefined
    }));

  if (!normalized.length && item.downloadKey) {
    normalized.push({
      key: item.downloadKey,
      name: sanitizeDownloadName(decodeUploadFilename(item.downloadName || path.basename(item.downloadKey)), path.basename(item.downloadKey)),
      relativePath: path.basename(item.downloadKey)
    });
  }

  return normalized;
}

function getImageDownloadFiles(item = {}) {
  const downloadFileMap = new Map(normalizeDownloadFiles(item).map(file => [file.key, file]));
  const previewKeys = Array.isArray(item.previewKeys) ? item.previewKeys.filter(Boolean) : [];
  return previewKeys
    .map(key => ({
      key,
      name: sanitizeDownloadName(downloadFileMap.get(key)?.name || path.basename(key), path.basename(key)),
      relativePath: downloadFileMap.get(key)?.relativePath || downloadFileMap.get(key)?.name || path.basename(key),
      abs: path.join(UPLOADS, key)
    }))
    .filter(file => fs.existsSync(file.abs));
}

function getImageBundleFiles(item = {}) {
  const results = [];
  const seen = new Set();
  const push = file => {
    if (!file?.key || !file?.abs || seen.has(file.key) || !fs.existsSync(file.abs)) return;
    seen.add(file.key);
    results.push(file);
  };
  normalizeDownloadFiles(item).forEach(file => push({
    key: file.key,
    name: sanitizeDownloadName(file.name || path.basename(file.key), path.basename(file.key)),
    relativePath: file.relativePath || file.name || path.basename(file.key),
    abs: path.join(UPLOADS, file.key)
  }));
  getImageDownloadFiles(item).forEach(push);
  return results;
}

function getDownloadableFilesForItem(item = {}, mode = 'scenario') {
  if (mode === 'image') {
    return getImageBundleFiles(item).map((file, index) => ({
      index,
      key: file.key,
      name: sanitizeDownloadName(file.name || path.basename(file.key), path.basename(file.key)),
      relativePath: file.relativePath || path.basename(file.key),
      abs: file.abs
    }));
  }
  return normalizeDownloadFiles(item)
    .map((file, index) => ({
      index,
      key: file.key,
      name: sanitizeDownloadName(file.name || path.basename(file.key), path.basename(file.key)),
      relativePath: file.relativePath || path.basename(file.key),
      abs: path.join(UPLOADS, file.key)
    }))
    .filter(file => fs.existsSync(file.abs));
}

function normalizeItemCategories(item) {
  if (Array.isArray(item.categories)) {
    return [...new Set(item.categories.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))];
  }
  if (typeof item.category === 'string' && item.category.trim()) return [item.category.trim()];
  return [];
}

function normalizeCollectionMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return VALID_COLLECTION_MODES.has(mode) ? mode : 'scenario';
}

function normalizeCollectionLabel(value, mode = 'scenario') {
  const label = String(value || '').trim();
  if (label) return label;
  if (mode === 'image') return '圖庫';
  return '資料庫';
}

function makeCollectionKey(value, fallbackMode = 'scenario') {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (raw) return raw;
  return fallbackMode === 'scenario' ? 'scenario' : `${fallbackMode}-${Date.now().toString(36)}`;
}

function getDefaultCollectionsConfig() {
  return DEFAULT_COLLECTIONS.map(item => ({ ...item }));
}

function normalizeCollectionsConfig(rawCollections = []) {
  const source = Array.isArray(rawCollections) && rawCollections.length ? rawCollections : getDefaultCollectionsConfig();
  const list = [];
  const usedKeys = new Set();
  const scenarioSource = source.find(entry => String(entry?.key || '').trim().toLowerCase() === 'scenario')
    || source.find(entry => normalizeCollectionMode(entry?.mode) === 'scenario')
    || { key: 'scenario', label: '資料庫', mode: 'scenario', permission: 'public' };
  source.forEach(entry => {
    const rawKey = String(entry?.key || '').trim().toLowerCase();
    const requestedMode = normalizeCollectionMode(entry?.mode);
    const mode = rawKey === 'scenario'
      ? 'scenario'
      : requestedMode;
    const preferredKey = mode === 'scenario' && rawKey === 'scenario'
      ? 'scenario'
      : makeCollectionKey(entry?.key || entry?.label, mode);
    let key = preferredKey;
    let suffix = 2;
    while (usedKeys.has(key)) key = `${preferredKey}-${suffix++}`;
    usedKeys.add(key);
    list.push({
      key,
      label: normalizeCollectionLabel(entry?.label, mode),
      mode,
      permission: normalizeItemPermission(entry?.permission)
    });
  });
  if (!usedKeys.has('scenario')) {
    list.unshift({
      key: 'scenario',
      label: normalizeCollectionLabel(scenarioSource?.label, 'scenario'),
      mode: 'scenario',
      permission: normalizeItemPermission(scenarioSource?.permission)
    });
  }
  if (!list.length) list.push({ key: 'scenario', label: '資料庫', mode: 'scenario', permission: 'public' });
  return list;
}

function getCollectionsConfig(cfg = null) {
  if (cfg && Array.isArray(cfg.collections)) return normalizeCollectionsConfig(cfg.collections);
  const raw = readJSON(CFG_FILE, {});
  return normalizeCollectionsConfig(raw.collections);
}

function sanitizeCollectionKey(value, cfg = null) {
  const key = String(value || '').trim().toLowerCase();
  const collections = getCollectionsConfig(cfg);
  if (collections.some(item => item.key === key)) return key;
  return collections.find(item => item.key === 'scenario')?.key || (collections[0]?.key || 'scenario');
}

function getCollectionEntry(collection = 'scenario', cfg = null) {
  const collections = getCollectionsConfig(cfg);
  const key = sanitizeCollectionKey(collection, { collections });
  return collections.find(item => item.key === key) || collections[0] || { key: 'scenario', label: '資料庫', mode: 'scenario' };
}

function getCollectionConfig(collection = 'scenario', cfg = null) {
  const entry = getCollectionEntry(collection, cfg);
  const mode = normalizeCollectionMode(entry.mode);
  let catalogFile = CAT_FILE;
  if (entry.key === 'image') {
    catalogFile = path.join(DATA, 'catalog-image.json');
  } else if (entry.key !== 'scenario') {
    catalogFile = path.join(DATA, `catalog-${entry.key}.json`);
  }
  const label = normalizeCollectionLabel(entry.label, mode);
  return {
    key: entry.key,
    label,
    mode,
    permission: normalizeItemPermission(entry.permission),
    catalogFile,
    defaultSite: { title: label, subtitle: '', footer: `${label} · Powered by Oracle Cloud` }
  };
}

function isSubPath(target, root) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function deleteCollectionStorage(collectionKey, cfg = null) {
  const key = String(collectionKey || '').trim().toLowerCase();
  if (!key || key === 'scenario') return;
  const collCfg = getCollectionConfig(key, cfg);
  const catalogFile = path.resolve(collCfg.catalogFile);
  const uploadDir = path.resolve(path.join(UPLOADS, key));

  if (isSubPath(catalogFile, DATA) && fs.existsSync(catalogFile)) {
    fs.rmSync(catalogFile, { force: true });
  }
  if (isSubPath(uploadDir, UPLOADS) && fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

function canAccessCollectionByRole(collection, role = 'public', cfg = null) {
  const permission = normalizeItemPermission(getCollectionEntry(collection, cfg)?.permission);
  if (role === 'owner') return true;
  if (permission === 'public') return true;
  if (permission === 'authenticated') return role !== 'public';
  if (permission === 'owner_only') return false;
  if (permission.startsWith('role:')) return role === permission.slice(5);
  return false;
}

function ensureCollectionAccessOrNull(collection, role = 'public', cfg = null) {
  const resolvedCfg = cfg || readCfg();
  return canAccessCollectionByRole(collection, role, resolvedCfg)
    ? null
    : { error: '你沒有權限查看這個資料庫' };
}

function collFile(collection = 'scenario') {
  return getCollectionConfig(collection).catalogFile;
}

function trashFile(collection = 'scenario') {
  const key = sanitizeCollectionKey(collection);
  return key === 'scenario'
    ? path.join(DATA, 'trash.json')
    : path.join(DATA, `trash-${key}.json`);
}

function readTrash(collection = 'scenario') {
  const list = readJSON(trashFile(collection), []);
  const cfg = getCollectionConfig(collection);
  return Array.isArray(list)
    ? list
        .map(item => {
          const downloadFiles = normalizeDownloadFiles(item);
          const categories = normalizeItemCategories(item);
          return {
            ...normalizeItemSharedFields(item),
            permission: normalizeItemPermission(item.permission),
            categories,
            category: categories[0] || '',
            downloadFiles,
            downloadName: item.downloadName || downloadFiles[0]?.name || null,
            collection: cfg.key
          };
        })
        .sort((a, b) => Number(new Date(b?._deletedAt || 0)) - Number(new Date(a?._deletedAt || 0)))
    : [];
}

function saveTrash(items, collection = 'scenario') {
  writeJSON(trashFile(collection), Array.isArray(items) ? items : []);
}

function collUploadDir(collection = 'scenario', itemId = '') {
  const key = sanitizeCollectionKey(collection);
  return key === 'scenario'
    ? path.join(UPLOADS, itemId)
    : path.join(UPLOADS, key, itemId);
}

function buildStoredKey(collection = 'scenario', itemId = '', filename = '') {
  const key = sanitizeCollectionKey(collection);
  return key === 'scenario'
    ? `${itemId}/${filename}`
    : `${key}/${itemId}/${filename}`;
}

function isThumbEligibleImageKey(key = '') {
  return THUMB_IMAGE_EXTS.has(path.extname(String(key || '')).toLowerCase());
}

function buildThumbKey(sourceKey = '') {
  const normalized = String(sourceKey || '').replace(/\\/g, '/').trim();
  if (!normalized) return '';
  const dir = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized);
  return path.posix.join(dir === '.' ? '' : dir, '.thumbs', `${base}.webp`);
}

function getThumbAbsPath(sourceKey = '') {
  const thumbKey = buildThumbKey(sourceKey);
  return thumbKey ? path.join(UPLOADS, thumbKey) : '';
}

function getThumbUrl(sourceKey = '') {
  const thumbKey = buildThumbKey(sourceKey);
  return thumbKey ? `/thumbs/${thumbKey}` : '';
}

function getUploadPublicUrl(sourceKey = '') {
  const normalized = String(sourceKey || '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized) return '';
  return `/uploads/${normalized.split('/').map(part => encodeURIComponent(part)).join('/')}`;
}

function resolveThumbSourceFromRequestPath(rawPath = '') {
  const normalized = String(rawPath || '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized.toLowerCase().endsWith('.webp')) return '';
  const withoutExt = normalized.slice(0, -'.webp'.length);
  const marker = '/.thumbs/';
  const markerIndex = withoutExt.lastIndexOf(marker);
  if (markerIndex === -1) return '';
  const prefix = withoutExt.slice(0, markerIndex);
  const filename = withoutExt.slice(markerIndex + marker.length);
  if (!filename) return '';
  const sourceKey = prefix ? `${prefix}/${filename}` : filename;
  if (buildThumbKey(sourceKey) !== normalized) return '';
  return sourceKey;
}

async function ensureThumbForKey(sourceKey = '', options = {}) {
  const key = String(sourceKey || '').trim();
  if (!key || !isThumbEligibleImageKey(key)) return '';
  const sourceAbs = path.join(UPLOADS, key);
  if (!fs.existsSync(sourceAbs)) return '';
  const thumbAbs = getThumbAbsPath(key);
  if (!thumbAbs) return '';

  const sourceStat = fs.statSync(sourceAbs);
  if (!options.force && fs.existsSync(thumbAbs)) {
    const thumbStat = fs.statSync(thumbAbs);
    if (thumbStat.size > 0 && thumbStat.mtimeMs >= sourceStat.mtimeMs) return thumbAbs;
  }

  fs.mkdirSync(path.dirname(thumbAbs), { recursive: true });
  try {
    await sharp(sourceAbs, { failOn: 'none' })
      .rotate()
      .resize({
        width: THUMB_MAX_EDGE,
        height: THUMB_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: THUMB_QUALITY })
      .toFile(thumbAbs);
  } catch (error) {
    try { fs.rmSync(thumbAbs, { force: true }); } catch {}
    const stderr = String(error?.message || '').trim();
    if (stderr) console.warn(`[thumb] ${key}: ${stderr}`);
    return '';
  }
  return thumbAbs;
}

async function ensureThumbsForKeys(keys = [], options = {}) {
  const seen = new Set();
  for (const key of (Array.isArray(keys) ? keys : [])) {
    const value = String(key || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    await ensureThumbForKey(value, options);
  }
}

function collectThumbSourceKeys(item = {}) {
  const keys = new Set();
  (Array.isArray(item.previewKeys) ? item.previewKeys : []).forEach(key => {
    if (isThumbEligibleImageKey(key)) keys.add(key);
  });
  normalizeDownloadFiles(item).forEach(file => {
    if (isThumbEligibleImageKey(file?.key)) keys.add(file.key);
  });
  return [...keys];
}

async function backfillThumbsForCollection(collection = 'scenario') {
  const cat = readCat(collection);
  const keys = new Set();
  (Array.isArray(cat.items) ? cat.items : []).forEach(item => {
    collectThumbSourceKeys(item).forEach(key => keys.add(key));
  });
  await ensureThumbsForKeys([...keys]);
}
function normalizeRelativePath(relativePath, fallback = 'download.bin') {
  const raw = String(relativePath || '').replace(/\\/g, '/').trim();
  const source = raw || fallback;
  if (/^[a-zA-Z]:/.test(source) || source.startsWith('/')) {
    throw new Error('Invalid relative path');
  }
  const parts = source.split('/').filter(Boolean);
  if (!parts.length) return sanitizeDownloadName(fallback, 'download.bin');
  const safeParts = parts.map((part, idx) => {
    const decoded = decodeUploadFilename(part);
    if (decoded === '.' || decoded === '..') throw new Error('Invalid relative path');
    const safe = sanitizeDownloadName(decoded, idx === parts.length - 1 ? fallback : 'folder').replace(/^\.+$/, '_');
    return safe || (idx === parts.length - 1 ? sanitizeDownloadName(fallback, 'download.bin') : 'folder');
  });
  const normalized = path.posix.normalize(safeParts.join('/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Invalid relative path');
  }
  return normalized;
}
function resolveUploadTargetPath(uploadDir, relativePath) {
  const destPath = path.resolve(uploadDir, relativePath.split('/').join(path.sep));
  const rel = path.relative(uploadDir, destPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid relative path');
  return destPath;
}

function withCollection(url, collection = 'scenario') {
  const key = sanitizeCollectionKey(collection);
  if (!url) return '';
  if (key === 'scenario') return url;
  return `${url}${url.includes('?') ? '&' : '?'}c=${encodeURIComponent(key)}`;
}

function getC(req) {
  return sanitizeCollectionKey(
    req?.query?.c ||
    req?.body?.c ||
    req?.params?.c ||
    req?.headers?.['x-catalog-collection']
  );
}

function normalizeItemSharedFields(item) {
  const subtitle = typeof item?.subtitle === 'string'
    ? item.subtitle.trim()
    : (typeof item?.translatedTitle === 'string' ? item.translatedTitle.trim() : '');
  const creator = typeof item?.creator === 'string'
    ? item.creator.trim()
    : (typeof item?.author === 'string' ? item.author.trim() : '');
  const sourceUrl = typeof item?.sourceUrl === 'string'
    ? item.sourceUrl.trim()
    : (typeof item?.originalUrl === 'string' ? item.originalUrl.trim() : '');
  const coverFocusX = Number.isFinite(Number(item?.coverFocusX)) ? Math.max(0, Math.min(100, Number(item.coverFocusX))) : 50;
  const coverFocusY = Number.isFinite(Number(item?.coverFocusY)) ? Math.max(0, Math.min(100, Number(item.coverFocusY))) : 50;
  return {
    ...item,
    subtitle,
    translatedTitle: subtitle,
    creator,
    author: creator,
    sourceUrl,
    originalUrl: sourceUrl,
    coverFocusX,
    coverFocusY
  };
}

function getDefaultCatalog(collection = 'scenario') {
  const cfg = getCollectionConfig(collection);
  return {
    items: [],
    tags: [],
    categories: [],
    sc: { ...cfg.defaultSite }
  };
}

const readCat = (collection = 'scenario') => {
  const cfg = getCollectionConfig(collection);
  const cat = readJSON(collFile(cfg.key), getDefaultCatalog(cfg.key));
  cat.items = (cat.items || []).map(item => {
    const downloadFiles = normalizeDownloadFiles(item);
    const categories = normalizeItemCategories(item);
    return {
      ...normalizeItemSharedFields(item),
      permission: normalizeItemPermission(item.permission),
      categories,
      category: categories[0] || '',
      downloadFiles,
      downloadName: item.downloadName || downloadFiles[0]?.name || null,
      collection: cfg.key
    };
  });
  cat.tags = Array.isArray(cat.tags) ? cat.tags.filter(Boolean) : [];
  cat.categories = Array.isArray(cat.categories) ? cat.categories.filter(Boolean) : [];
  cat.sc = {
    ...cfg.defaultSite,
    ...(cat.sc && typeof cat.sc === 'object' ? cat.sc : {})
  };
  return cat;
};
const saveCat = (d, collection = 'scenario') => writeJSON(collFile(collection), d);
function normalizeUserUiPrefs(rawPrefs = {}) {
  const source = rawPrefs && typeof rawPrefs === 'object' ? rawPrefs : {};
  const normalized = {};
  Object.entries(source).forEach(([userId, prefs]) => {
    if (typeof userId !== 'string' || !userId.trim()) return;
    const manageDiscOrderByCollection = {};
    const rawOrders = prefs?.manageDiscOrderByCollection;
    if (rawOrders && typeof rawOrders === 'object') {
      Object.entries(rawOrders).forEach(([collectionKey, order]) => {
        const safeKey = sanitizeCollectionKey(collectionKey);
        if (!Array.isArray(order)) return;
        const ids = [...new Set(order.filter(id => typeof id === 'string' && id.trim()))];
        manageDiscOrderByCollection[safeKey] = ids;
      });
    }
    normalized[userId.trim()] = { manageDiscOrderByCollection };
  });
  return normalized;
}

function getUserUiPrefs(cfg = null) {
  return normalizeUserUiPrefs(cfg?.userUiPrefs || {});
}

function makeAuthUserId() {
  return `usr-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeGoogleEmail(email) {
  const raw = String(email || '').trim().toLowerCase();
  if (!raw) return '';
  const at = raw.indexOf('@');
  if (at <= 0 || at === raw.length - 1) return raw;
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') {
    local = local.split('+')[0].replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

function normalizeAuthUsers(rawUsers = [], fallbackPwdHash = '') {
  const list = Array.isArray(rawUsers) ? rawUsers : [];
  const normalized = list
    .map((user, idx) => ({
      id: typeof user?.id === 'string' && user.id.trim() ? user.id.trim() : `usr-legacy-${idx + 1}`,
      username: typeof user?.username === 'string' ? user.username.trim() : '',
      passwordHash: typeof user?.passwordHash === 'string' ? user.passwordHash : '',
      role: sanitizeRoleKey(user?.role) || (idx === 0 ? 'owner' : 'admin'),
      googleEmail: typeof user?.googleEmail === 'string' ? user.googleEmail.trim().toLowerCase() : '',
      googleOnly: !!user?.googleOnly
    }))
    .filter(user => user.username);
  if (normalized.some(user => user.passwordHash)) return normalized;
  if (typeof fallbackPwdHash === 'string' && fallbackPwdHash) {
    return [{
      ...getDefaultInitialAuthUser(),
      passwordHash: fallbackPwdHash
    }];
  }
  return [getDefaultInitialAuthUser()];
  if (normalized.length) return normalized;
  return [{
    id: 'default-admin',
    username: '管理員',
    passwordHash: typeof fallbackPwdHash === 'string' ? fallbackPwdHash : '',
    role: 'owner'
  }];
}

function normalizeItemPermission(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'public' || raw === '公開') return 'public';
  if (raw === 'authenticated' || raw === '僅登入可見') return 'authenticated';
  if (raw === 'owner_admin' || raw === '僅站主及管理員可見' || raw === '僅群主及管理員可見') return 'role:admin';
  if (raw === 'owner_only' || raw === '僅站主可見' || raw === '僅群主可見') return 'owner_only';
  if (value === 'authenticated') return 'authenticated';
  if (value === 'owner_admin') return 'role:admin';
  if (value === 'owner_only') return 'owner_only';
  const roleKey = sanitizeRoleKey(raw.replace(/^role:/, ''));
  if (roleKey && roleKey !== 'owner') return `role:${roleKey}`;
  return 'public';
}

function getDefaultRoleConfig() {
  return {
    owner: {
      label: '群主',
      permissions: {
        onlinePreview: true,
        createPreviewShare: true,
        downloadFiles: true,
        uploadItems: true,
        editCategories: true,
        editTags: true,
        editItemOrder: true,
        editItemInfo: true,
        editTxtAttachments: true,
        deleteItems: true
      }
    },
    admin: {
      label: '管理員',
      permissions: {
        onlinePreview: true,
        createPreviewShare: true,
        downloadFiles: true,
        uploadItems: true,
        editCategories: true,
        editTags: true,
        editItemOrder: true,
        editItemInfo: true,
        editTxtAttachments: true,
        deleteItems: true
      }
    }
  };
}

function sanitizeRoleKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeRolePermissions(srcPermissions = {}, fallbackPermissions = getDefaultRoleConfig().admin.permissions) {
  return {
    onlinePreview: srcPermissions?.onlinePreview === undefined ? fallbackPermissions.onlinePreview : !!srcPermissions.onlinePreview,
    createPreviewShare: srcPermissions?.createPreviewShare === undefined ? fallbackPermissions.createPreviewShare : !!srcPermissions.createPreviewShare,
    downloadFiles: srcPermissions?.downloadFiles === undefined ? fallbackPermissions.downloadFiles : !!srcPermissions.downloadFiles,
    uploadItems: srcPermissions?.uploadItems === undefined ? fallbackPermissions.uploadItems : !!srcPermissions.uploadItems,
    editCategories: srcPermissions?.editCategories === undefined ? fallbackPermissions.editCategories : !!srcPermissions.editCategories,
    editTags: srcPermissions?.editTags === undefined ? fallbackPermissions.editTags : !!srcPermissions.editTags,
    editItemOrder: srcPermissions?.editItemOrder === undefined ? fallbackPermissions.editItemOrder : !!srcPermissions.editItemOrder,
    editItemInfo: srcPermissions?.editItemInfo === undefined ? fallbackPermissions.editItemInfo : !!srcPermissions.editItemInfo,
    editTxtAttachments: srcPermissions?.editTxtAttachments === undefined ? fallbackPermissions.editTxtAttachments : !!srcPermissions.editTxtAttachments,
    deleteItems: srcPermissions?.deleteItems === undefined ? fallbackPermissions.deleteItems : !!srcPermissions.deleteItems
  };
}

function normalizeRoleConfig(rawConfig = {}) {
  const defaults = getDefaultRoleConfig();
  const buildRole = (key, fallbackDef = defaults.admin) => {
    const src = rawConfig?.[key] && typeof rawConfig[key] === 'object' ? rawConfig[key] : {};
    const def = defaults[key] || fallbackDef;
    return {
      label: typeof src.label === 'string' && src.label.trim() ? src.label.trim() : def.label,
      permissions: normalizeRolePermissions(src.permissions, def.permissions)
    };
  };
  const normalized = {
    owner: buildRole('owner')
  };
  Object.keys(rawConfig || {}).forEach(key => {
    const roleKey = sanitizeRoleKey(key);
    if (!roleKey || roleKey === 'owner' || normalized[roleKey]) return;
    normalized[roleKey] = buildRole(roleKey, defaults[roleKey] || defaults.admin);
  });
  return normalized;
}

function getDefaultNonOwnerRoleKey(roleConfig = {}) {
  return Object.keys(roleConfig || {}).find(key => key !== 'owner') || '';
}

function getGlobalRoleConfig(cfg) {
  return normalizeRoleConfig(cfg?.roleConfig || {});
}

function getAccessibleRoleKeysForCollection(collection = 'scenario', cfg = null) {
  const resolvedCfg = cfg || readCfg();
  const global = getGlobalRoleConfig(resolvedCfg);
  const allKeys = Object.keys(global);
  const permission = normalizeItemPermission(getCollectionEntry(collection, resolvedCfg)?.permission);
  if (permission === 'public' || permission === 'authenticated') return allKeys;
  if (permission === 'owner_only') return ['owner'];
  if (permission.startsWith('role:')) {
    const role = permission.slice(5);
    return ['owner', ...allKeys.filter(key => key === role && key !== 'owner')];
  }
  return ['owner'];
}

function getRoleConfig(cfg, collection = 'scenario') {
  const resolvedCfg = cfg || readCfg();
  const global = getGlobalRoleConfig(resolvedCfg);
  const key = sanitizeCollectionKey(collection, { collections: getCollectionsConfig(resolvedCfg) });
  const rawByCollection = resolvedCfg?.collectionRoleConfig && typeof resolvedCfg.collectionRoleConfig === 'object'
    ? resolvedCfg.collectionRoleConfig[key]
    : null;
  if (!rawByCollection || typeof rawByCollection !== 'object') return global;
  const merged = {};
  const allRoleKeys = [...new Set([...Object.keys(global), ...Object.keys(rawByCollection || {})])];
  allRoleKeys.forEach(roleKey => {
    const globalRole = global[roleKey] || normalizeRoleConfig({ [roleKey]: rawByCollection[roleKey] || {} })[roleKey];
    const rawRole = rawByCollection?.[roleKey] && typeof rawByCollection[roleKey] === 'object' ? rawByCollection[roleKey] : {};
    merged[roleKey] = {
      label: globalRole?.label || rawRole?.label || roleKey,
      permissions: normalizeRolePermissions(rawRole.permissions, globalRole?.permissions || getDefaultRoleConfig().admin.permissions)
    };
  });
  return merged;
}

function getVisibleRoleConfig(cfg, collection = 'scenario') {
  const resolvedCfg = cfg || readCfg();
  const roleConfig = getRoleConfig(resolvedCfg, collection);
  const allowed = new Set(getAccessibleRoleKeysForCollection(collection, resolvedCfg));
  const filtered = {};
  Object.keys(roleConfig).forEach(roleKey => {
    if (allowed.has(roleKey)) filtered[roleKey] = roleConfig[roleKey];
  });
  return filtered;
}

function canAccessItemByRole(item, role = 'public') {
  const permission = normalizeItemPermission(item?.permission);
  if (role === 'owner') return true;
  if (permission === 'public') return true;
  if (permission === 'authenticated') return role !== 'public';
  if (permission === 'owner_only') return false;
  if (permission.startsWith('role:')) return role === permission.slice(5);
  return false;
}

function hasRolePermission(user, permissionKey, collection = 'scenario') {
  if (!user) return false;
  if (user.role === 'owner') return true;
  const cfg = readCfg();
  const roleConfig = getVisibleRoleConfig(cfg, collection);
  return !!roleConfig[user.role]?.permissions?.[permissionKey];
}

function canEditTxtPreview(user, collection = 'scenario') {
  return hasRolePermission(user, 'editTxtAttachments', collection);
}

function getViewerRole(req) {
  const authUser = req?.authUser || verifyToken(getTokenFromReq(req));
  return authUser?.role || 'public';
}

const readCfg = () => {
  const cfg = readJSON(CFG_FILE, {
    pwdHash: '',
    authSecret: '',
    users: [],
    roleConfig: getDefaultRoleConfig(),
    collectionRoleConfig: {},
    previewShareLinks: {},
    collections: getDefaultCollectionsConfig(),
    userUiPrefs: {},
    googleClientId: '',
    uploadOrigin: '',
    publicShareOrigin: '',
    publicShareSiteSlug: ''
  });
  let dirty = false;
  if (typeof cfg.pwdHash !== 'string') {
    cfg.pwdHash = '';
    dirty = true;
  }
  if (typeof cfg.googleClientId !== 'string') {
    cfg.googleClientId = '';
    dirty = true;
  }
  const normalizedUploadOrigin = normalizeHttpOrigin(cfg.uploadOrigin);
  if (cfg.uploadOrigin !== normalizedUploadOrigin) {
    cfg.uploadOrigin = normalizedUploadOrigin;
    dirty = true;
  }
  const normalizedPublicShareOrigin = normalizeHttpOrigin(cfg.publicShareOrigin);
  if (cfg.publicShareOrigin !== normalizedPublicShareOrigin) {
    cfg.publicShareOrigin = normalizedPublicShareOrigin;
    dirty = true;
  }
  const normalizedPublicShareSiteSlug = normalizePublicShareSiteSlug(cfg.publicShareSiteSlug);
  if (cfg.publicShareSiteSlug !== normalizedPublicShareSiteSlug) {
    cfg.publicShareSiteSlug = normalizedPublicShareSiteSlug;
    dirty = true;
  }
  if (!cfg.authSecret) {
    cfg.authSecret = crypto.randomBytes(32).toString('hex');
    dirty = true;
  }
  const users = normalizeAuthUsers(cfg.users, cfg.pwdHash);
  if (JSON.stringify(cfg.users || []) !== JSON.stringify(users)) {
    cfg.users = users;
    dirty = true;
  }
  const roleConfig = getGlobalRoleConfig(cfg);
  if (JSON.stringify(cfg.roleConfig || {}) !== JSON.stringify(roleConfig)) {
    cfg.roleConfig = roleConfig;
    dirty = true;
  }
  if (!cfg.collectionRoleConfig || typeof cfg.collectionRoleConfig !== 'object' || Array.isArray(cfg.collectionRoleConfig)) {
    cfg.collectionRoleConfig = {};
    dirty = true;
  }
  if (!cfg.previewShareLinks || typeof cfg.previewShareLinks !== 'object' || Array.isArray(cfg.previewShareLinks)) {
    cfg.previewShareLinks = {};
    dirty = true;
  }
  const collections = getCollectionsConfig(cfg);
  if (JSON.stringify(cfg.collections || []) !== JSON.stringify(collections)) {
    cfg.collections = collections;
    dirty = true;
  }
  const previewShareLinks = normalizePreviewShareLinks(cfg.previewShareLinks, cfg);
  if (JSON.stringify(cfg.previewShareLinks || {}) !== JSON.stringify(previewShareLinks)) {
    cfg.previewShareLinks = previewShareLinks;
    dirty = true;
  }
  const userUiPrefs = getUserUiPrefs(cfg);
  if (JSON.stringify(cfg.userUiPrefs || {}) !== JSON.stringify(userUiPrefs)) {
    cfg.userUiPrefs = userUiPrefs;
    dirty = true;
  }
  if (dirty) writeJSON(CFG_FILE, cfg);
  return cfg;
};
const saveCfg = d => writeJSON(CFG_FILE, { ...readCfg(), ...d });

// ── Session Token（簽章式，後端重啟後仍可驗證）─
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

function safeEq(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function getAuthUserById(cfg, id) {
  const bootstrapUser = getBootstrapAuthUser();
  if (bootstrapUser && bootstrapUser.id === id) return bootstrapUser;
  return normalizeAuthUsers(cfg?.users, cfg?.pwdHash).find(user => user.id === id) || null;
}

function getAuthUserByUsername(cfg, username) {
  const target = String(username || '').trim();
  if (!target) return null;
  const bootstrapUser = getBootstrapAuthUser();
  if (bootstrapUser && bootstrapUser.username === target) return bootstrapUser;
  return normalizeAuthUsers(cfg?.users, cfg?.pwdHash).find(user => user.username === target) || null;
}

function getAuthUserByCredentials(cfg, username, password) {
  const user = getAuthUserByUsername(cfg, username);
  if (!user) return null;
  return user.passwordHash === sha256(password || '') ? user : null;
}

function makeToken(user) {
  const cfg = readCfg();
  const body = Buffer.from(JSON.stringify({
    iat: Date.now(),
    rnd: crypto.randomBytes(8).toString('hex'),
    uid: user?.id || '',
    username: user?.username || ''
  })).toString('base64url');
  const sig = sign(body, cfg.authSecret);
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const cfg = readCfg();
  const expected = sign(body, cfg.authSecret);
  if (!safeEq(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!(Number(payload.iat) > 0 && (Date.now() - Number(payload.iat)) <= TOKEN_TTL_MS)) return null;
    const user = getAuthUserById(cfg, payload.uid) || getAuthUserByUsername(cfg, payload.username);
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      iat: Number(payload.iat)
    };
  } catch {
    return null;
  }
}

function getTokenFromReq(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ')
    ? h.slice(7)
    : (req.headers['x-token'] || '');
}

function sanitizeCatalogForPublic(cat) {
  return {
    ...cat,
    items: (cat.items || []).map(item => ({
      ...item,
      downloadKey: null,
      downloadName: null,
      downloadFiles: [],
      downloadUrl: null
    }))
  };
}

function filterCatalogForViewer(cat, role = 'public') {
  const items = (cat.items || [])
    .filter(item => canAccessItemByRole(item, role))
    .map(item => ({
      ...item,
      permission: normalizeItemPermission(item.permission)
    }));

  const tagOrder = Array.isArray(cat.tags) ? cat.tags : [];
  const catOrder = Array.isArray(cat.categories) ? cat.categories : [];

  const rawTags = [...new Set(items.flatMap(item =>
    Array.isArray(item.tags) ? item.tags : []).filter(Boolean))];
  const rawCats = [...new Set(items.flatMap(item =>
    Array.isArray(item.categories) ? item.categories :
    (item.category ? [item.category] : [])).filter(Boolean))];

  const visibleTags = [
    ...tagOrder.filter(t => rawTags.includes(t)),
    ...rawTags.filter(t => !tagOrder.includes(t))
  ];
  const visibleCategories = [
    ...catOrder.filter(c => rawCats.includes(c)),
    ...rawCats.filter(c => !catOrder.includes(c))
  ];

  const result = {
    ...cat,
    items,
    tags: role === 'public'
      ? visibleTags
      : [...tagOrder, ...rawTags.filter(t => !tagOrder.includes(t))],
    categories: role === 'public'
      ? visibleCategories
      : [...catOrder, ...rawCats.filter(c => !catOrder.includes(c))]
  };

  // 只有未登入訪客才清除下載相關欄位
  if (role === 'public') return sanitizeCatalogForPublic(result);
  return result;
}

const auth = (req, res, next) => {
  const t = getTokenFromReq(req);
  const user = verifyToken(t);
  if (!user) return res.status(401).json({ error: '未授權，請重新登入' });
  req.authUser = user;
  next();
};

function getUploadItemId(req) {
  return req.params.itemId || req.params.id;
}

function getUploadCollection(req) {
  return getC(req);
}

function sanitizeDownloadName(name, fallback = 'download') {
  const raw = String(name || '').trim();
  const cleaned = raw.replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function makeAsciiDownloadFallback(name) {
  const parsed = path.parse(String(name || 'download'));
  const asciiBase = parsed.name
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[<>:"/\\|?*]/g, '');
  const ext = parsed.ext || '';
  return `${asciiBase || 'download'}${ext}`;
}

function setDownloadHeaders(res, filename) {
  const safeName = sanitizeDownloadName(filename, 'download');
  const asciiFallback = makeAsciiDownloadFallback(safeName);
  const encoded = encodeURIComponent(safeName).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`);
}

function setInlinePdfHeaders(res, filename) {
  const safeName = sanitizeDownloadName(filename, 'preview.pdf').replace(/\.[^.]+$/, '') + '.pdf';
  const asciiFallback = makeAsciiDownloadFallback(safeName);
  const encoded = encodeURIComponent(safeName).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`);
}

function getExt(name) {
  return path.extname(String(name || '')).toLowerCase();
}

const PREVIEWABLE_MEDIA_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime'
};

function getPreviewMediaMimeType(ext = '') {
  return PREVIEWABLE_MEDIA_MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function getPreviewableFiles(item, collection = 'scenario', cfg = null) {
  const mode = getCollectionConfig(collection, cfg).mode;
  const files = mode === 'image'
    ? getImageBundleFiles(item)
    : normalizeDownloadFiles(item).map(file => ({
        ...file,
        abs: path.join(UPLOADS, file.key)
      }));
  const results = [];
  const seen = new Set();
  const supported = new Set(['.pdf', '.txt', '.docx', '.html', '.htm', ...Object.keys(PREVIEWABLE_MEDIA_MIME)]);

  files.forEach(file => {
    const ext = getExt(file.name || file.key);
    if (!supported.has(ext)) return;
    const key = file.key || `${file.name}:${ext}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      ...file,
      ext,
      abs: file.abs || path.join(UPLOADS, file.key)
    });
  });
  return results;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getZipEntryBuffer(zipPath, entryName) {
  const buf = fs.readFileSync(zipPath);
  const centralSig = 0x02014b50;
  const localSig = 0x04034b50;
  const endSig = 0x06054b50;
  let endOffset = -1;

  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === endSig) {
      endOffset = i;
      break;
    }
  }
  if (endOffset < 0) throw new Error('Invalid docx zip structure.');

  const centralDirOffset = buf.readUInt32LE(endOffset + 16);
  const totalEntries = buf.readUInt16LE(endOffset + 10);
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== centralSig) throw new Error('Invalid central directory record.');
    const compression = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const fileNameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const fileName = buf.slice(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    if (fileName === entryName) {
      if (buf.readUInt32LE(localHeaderOffset) !== localSig) throw new Error('Invalid local file header.');
      const localNameLength = buf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buf.slice(dataStart, dataStart + compressedSize);
      if (compression === 0) return compressed;
      if (compression === 8) return zlib.inflateRawSync(compressed);
      throw new Error(`Unsupported docx compression method: ${compression}`);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error(`Missing ${entryName} in docx file.`);
}

function extractDocxText(absPath) {
  const xml = getZipEntryBuffer(absPath, 'word/document.xml').toString('utf8');
  const paragraphs = [];
  const paragraphMatches = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];

  paragraphMatches.forEach(block => {
    let text = block
      .replace(/<w:tab\b[^/>]*\/>/g, '\t')
      .replace(/<w:br\b[^/>]*\/>/g, '\n')
      .replace(/<w:cr\b[^/>]*\/>/g, '\n');
    const runs = text.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g) || [];
    const line = runs
      .map(run => decodeXmlEntities(run.replace(/<\/?w:t\b[^>]*>/g, '')))
      .join('');
    paragraphs.push(line);
  });

  return paragraphs.join('\n\n').trim();
}

function getDocxMimeType(target) {
  const ext = path.extname(String(target || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function getDocxRelationships(absPath) {
  try {
    const xml = getZipEntryBuffer(absPath, 'word/_rels/document.xml.rels').toString('utf8');
    const rels = {};
    const re = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Type="([^"]+)"[^>]*Target="([^"]+)"(?:[^>]*TargetMode="([^"]+)")?[^>]*\/>/g;
    let match;
    while ((match = re.exec(xml))) {
      rels[match[1]] = {
        type: decodeXmlEntities(match[2]),
        target: decodeXmlEntities(match[3]),
        external: /External/i.test(match[4] || '')
      };
    }
    return rels;
  } catch {
    return {};
  }
}

function getDocxMediaMap(absPath, rels) {
  const images = {};
  Object.entries(rels || {}).forEach(([id, target]) => {
    if (!/media\//i.test(target?.target || '')) return;
    const normalized = target.target.replace(/^\/+/, '').replace(/^word\//, '');
    const entryName = `word/${normalized}`;
    try {
      const buf = getZipEntryBuffer(absPath, entryName);
      images[id] = `data:${getDocxMimeType(target.target)};base64,${buf.toString('base64')}`;
    } catch {}
  });
  return images;
}

function getDocxXmlSnippet(xml, center, radius = 180) {
  const source = String(xml || '');
  const start = Math.max(0, Number(center || 0) - radius);
  const end = Math.min(source.length, Number(center || 0) + radius);
  return source
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim();
}

function collectTopLevelDocxBlock(source, start, tag) {
  const openMatch = source.slice(start).match(new RegExp(`^<w:${tag}\\b[^>]*\\/?>`, 'i'));
  if (!openMatch) return null;
  if (/\/>$/.test(openMatch[0])) {
    return { end: start + openMatch[0].length, malformed: false };
  }

  let depth = 1;
  let pos = start + openMatch[0].length;
  const tagRe = new RegExp(`<(/?)w:${tag}\\b[^>]*?(/?)>`, 'gi');
  tagRe.lastIndex = pos;
  let next;

  while (depth > 0 && (next = tagRe.exec(source))) {
    const isClosing = next[1] === '/';
    const isSelfClosing = next[2] === '/';
    if (isSelfClosing) {
      pos = tagRe.lastIndex;
      continue;
    }
    depth += isClosing ? -1 : 1;
    pos = tagRe.lastIndex;
  }

  if (depth !== 0) return { end: start + openMatch[0].length, malformed: true };
  return { end: pos, malformed: false };
}

function getTopLevelDocxBlocks(xml, tags = ['p', 'tbl'], diagnostics = null) {
  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  const source = bodyMatch ? bodyMatch[1] : xml;
  const blocks = [];
  let i = 0;

  while (i < source.length) {
    const start = source.indexOf('<w:', i);
    if (start < 0) break;
    const tagMatch = source.slice(start).match(/^<w:(p|tbl)\b[^>]*>/);
    if (!tagMatch || !tags.includes(tagMatch[1])) {
      i = start + 3;
      continue;
    }

    const tag = tagMatch[1];
    const block = collectTopLevelDocxBlock(source, start, tag);
    if (block && !block.malformed) {
      blocks.push({ tag, xml: source.slice(start, block.end) });
      i = block.end;
    } else {
      if (Array.isArray(diagnostics)) {
        diagnostics.push({
          type: 'unclosed-top-level-block',
          tag,
          offset: start,
          blockCount: blocks.length,
          sourceLength: source.length,
          snippet: getDocxXmlSnippet(source, start)
        });
      }
      i = start + 3;
    }
  }

  return blocks;
}

function sanitizeDocxAnchor(name) {
  const raw = String(name || '').trim();
  if (!raw || raw.startsWith('_')) return '';
  return raw.replace(/[^\w\-:.]/g, '_');
}

function getDocxParagraphMeta(block) {
  const pPr = block.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] || '';
  const heading = Number((pPr.match(/<w:pStyle\b[^>]*w:val="Heading([1-6])"/i) || [])[1] || 0);
  const styleName = (pPr.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/i) || [])[1] || '';
  const align = (pPr.match(/<w:jc\b[^>]*w:val="([^"]+)"/i) || [])[1] || '';
  const indentLeftTwip = Number((pPr.match(/<w:ind\b[^>]*w:left="(\d+)"/i) || [])[1] || 0);
  const spacingBeforeTwip = Number((pPr.match(/<w:spacing\b[^>]*w:before="(\d+)"/i) || [])[1] || 0);
  const spacingAfterTwip = Number((pPr.match(/<w:spacing\b[^>]*w:after="(\d+)"/i) || [])[1] || 0);
  const lineTwip = Number((pPr.match(/<w:spacing\b[^>]*w:line="(\d+)"/i) || [])[1] || 0);
  return {
    heading: heading >= 1 && heading <= 6 ? heading : 0,
    align,
    isToc: /^TOC\d+$/i.test(styleName),
    indentLeftTwip,
    spacingBeforeTwip,
    spacingAfterTwip,
    lineTwip
  };
}

function getDocxRunStyle(runXml) {
  const rPr = runXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] || '';
  const color = ((rPr.match(/<w:color\b[^>]*w:val="([0-9A-Fa-f]{6})"/) || [])[1] || '').toUpperCase();
  const fontAscii = (rPr.match(/<w:rFonts\b[^>]*w:ascii="([^"]+)"/) || [])[1] || '';
  const fontEastAsia = (rPr.match(/<w:rFonts\b[^>]*w:eastAsia="([^"]+)"/) || [])[1] || '';
  const fontHintRaw = fontEastAsia || fontAscii;
  const fontHint = fontHintRaw === '新細明體' ? 'Georgia' : fontHintRaw;
  const sizeHalfPoints = Number((rPr.match(/<w:sz\b[^>]*w:val="(\d+)"/) || [])[1] || 0);
  const styles = [];
  if (isDocxTogglePropertyEnabled(rPr, 'b')) styles.push('font-weight:700');
  if (isDocxTogglePropertyEnabled(rPr, 'i')) styles.push('font-style:italic');
  if (/<w:u\b[^>]*w:val="(?!none)[^"]+"/.test(rPr) || /<w:u(?:\b[^>]*)?\/>/.test(rPr)) styles.push('text-decoration:underline');
  if (color) styles.push(`color:#${color}`);
  if (sizeHalfPoints > 0) styles.push(`font-size:${(sizeHalfPoints / 2).toFixed(1).replace(/\.0$/, '')}pt`);
  if (fontHint) styles.push(`font-family:${JSON.stringify(fontHint)},${DOCX_RUN_FALLBACK_SERIF_STACK}`);
  return styles.join(';');
}

function isDocxTogglePropertyEnabled(xml, tagName) {
  const re = new RegExp(`<w:${tagName}\\b([^>]*)/>|<w:${tagName}\\b([^>]*)>([\\s\\S]*?)</w:${tagName}>`, 'i');
  const match = re.exec(String(xml || ''));
  if (!match) return false;
  const attrs = `${match[1] || ''} ${match[2] || ''} ${match[3] || ''}`;
  const valMatch = attrs.match(/\bw:val="([^"]+)"/i);
  if (!valMatch) return true;
  return !/^(?:0|false|off)$/i.test(valMatch[1].trim());
}

function renderDocxRunInner(runXml, mediaMap) {
  const parts = [];
  const tokenRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^/>]*\/>|<w:br\b[^/>]*\/>|<w:cr\b[^/>]*\/>|<w:drawing\b[\s\S]*?<\/w:drawing>/g;
  let match;
  while ((match = tokenRe.exec(runXml))) {
    if (match[1] != null) {
      parts.push(escapeXml(decodeXmlEntities(match[1])));
      continue;
    }
    if (match[0].startsWith('<w:tab')) {
      parts.push('&nbsp;&nbsp;&nbsp;&nbsp;');
      continue;
    }
    if (match[0].startsWith('<w:br') || match[0].startsWith('<w:cr')) {
      parts.push('<br>');
      continue;
    }
    if (match[0].startsWith('<w:drawing')) {
      const embed = match[0].match(/r:embed="([^"]+)"/);
      const src = embed ? mediaMap[embed[1]] : '';
      if (src) parts.push(`<img class="docx-image" src="${src}" alt="">`);
    }
  }
  return parts.join('');
}

function renderDocxRun(runXml, mediaMap) {
  const inner = renderDocxRunInner(runXml, mediaMap);
  if (!inner) return '';
  const style = getDocxRunStyle(runXml);
  if (style) return `<span style="${escapeXml(style)}">${inner}</span>`;
  return inner;
}

function getDocxNodeInnerXml(xml, tagName) {
  const source = String(xml || '');
  const startRe = new RegExp(`^<${tagName}\\b[^>]*>`, 'i');
  const endRe = new RegExp(`</${tagName}>$`, 'i');
  return source.replace(startRe, '').replace(endRe, '');
}

function renderDocxHyperlink(xml, mediaMap, rels) {
  const anchor = sanitizeDocxAnchor((xml.match(/w:anchor="([^"]+)"/) || [])[1] || '');
  const relId = (xml.match(/r:id="([^"]+)"/) || [])[1] || '';
  const rel = rels[relId];
  const href = anchor ? `#${anchor}` : (rel?.target || '');
  const innerXml = getDocxNodeInnerXml(xml, 'w:hyperlink');
  if (!href) return renderDocxInline(innerXml, mediaMap, rels);
  const attrs = rel?.external ? ' target="_blank" rel="noopener noreferrer"' : '';
  const label = renderDocxInline(innerXml, mediaMap, rels) || escapeXml(href);
  return `<a class="docx-link" href="${escapeXml(href)}"${attrs}>${label}</a>`;
}

function renderDocxInline(xml, mediaMap, rels) {
  const parts = [];
  const tokenRe = /<w:bookmarkStart\b[^>]*w:name="([^"]+)"[^>]*\/>|<w:hyperlink\b[\s\S]*?<\/w:hyperlink>|<w:r\b[\s\S]*?<\/w:r>|<w:fldSimple\b[\s\S]*?<\/w:fldSimple>|<w:lastRenderedPageBreak\/>/g;
  let match;
  while ((match = tokenRe.exec(xml))) {
    const token = match[0];
    if (match[1] != null) {
      const id = sanitizeDocxAnchor(match[1]);
      if (id) parts.push(`<span id="${escapeXml(id)}" class="docx-anchor"></span>`);
      continue;
    }
    if (token.startsWith('<w:hyperlink')) {
      parts.push(renderDocxHyperlink(token, mediaMap, rels));
      continue;
    }
    if (token.startsWith('<w:fldSimple')) {
      parts.push(renderDocxInline(getDocxNodeInnerXml(token, 'w:fldSimple'), mediaMap, rels));
      continue;
    }
    if (token.startsWith('<w:lastRenderedPageBreak')) {
      parts.push('<span class="docx-page-divider" aria-hidden="true"></span>');
      continue;
    }
    parts.push(renderDocxRun(token, mediaMap));
  }
  return parts.join('');
}

function decodeDocxHtmlText(html) {
  return decodeXmlEntities(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
  );
}

function renderDocxParagraphBlocks(block, mediaMap, rels) {
  const meta = getDocxParagraphMeta(block);
  const inlineHtml = renderDocxInline(block, mediaMap, rels);
  const tag = meta.heading ? `h${meta.heading}` : 'p';
  const classes = ['docx-paragraph'];
  if (!meta.heading) classes.push('docx-body-paragraph');
  if (meta.heading) classes.push(`docx-heading-${meta.heading}`);
  if (meta.isToc) classes.push('docx-toc-entry');
  if (meta.align) classes.push(`docx-align-${meta.align}`);
  const plainText = decodeDocxHtmlText(inlineHtml);
  const hasImage = /<img\b/i.test(inlineHtml);
  const isEmpty = !plainText.trim() && !hasImage;
  if (isEmpty) classes.push('docx-empty');
  const paragraphStyles = [];
  if (meta.indentLeftTwip > 0) paragraphStyles.push(`padding-left:${(meta.indentLeftTwip / 567).toFixed(3)}cm`);
  if (meta.spacingBeforeTwip > 0) paragraphStyles.push(`margin-top:${(meta.spacingBeforeTwip / 567).toFixed(3)}cm`);
  if (meta.spacingAfterTwip > 0) paragraphStyles.push(`margin-bottom:${(meta.spacingAfterTwip / 567).toFixed(3)}cm`);
  if (meta.lineTwip > 0) paragraphStyles.push(`line-height:${Math.max(1.2, meta.lineTwip / 240).toFixed(2)}`);
  const styleAttr = paragraphStyles.length ? ` style="${paragraphStyles.join(';')}"` : '';
  const html = `<${tag} class="${classes.join(' ')}" data-empty="${isEmpty ? 'true' : 'false'}"${styleAttr}>${inlineHtml || '&nbsp;'}</${tag}>`;
  return [{
    type: 'paragraph',
    html,
    splittable: false,
    meta: {
      ...meta,
      isEmpty,
      hasImage,
      textLength: plainText.trim().length,
      hasCustomSpacing: meta.spacingBeforeTwip > 0 || meta.spacingAfterTwip > 0 || meta.lineTwip > 0
    }
  }];
}

function renderDocxTable(block, mediaMap, rels) {
  const rows = block.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
  const body = rows.map(row => {
    const cells = row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || [];
    const cols = cells.map(cell => {
      const innerBlocks = getTopLevelDocxBlocks(cell, ['p']);
      const html = innerBlocks
        .flatMap(entry => renderDocxParagraphBlocks(entry.xml, mediaMap, rels))
        .filter(entry => entry.type === 'paragraph')
        .map(entry => entry.html)
        .join('');
      return `<td>${html || '<p class="docx-paragraph docx-empty">&nbsp;</p>'}</td>`;
    }).join('');
    return `<tr>${cols}</tr>`;
  }).join('');
  return `<div class="docx-table-wrap"><table class="docx-table">${body}</table></div>`;
}

function getDominantRoundedMetric(values, step = 0.05) {
  const stats = new Map();
  values.forEach(value => {
    if (!Number.isFinite(value) || value <= 0) return;
    const rounded = Math.round(value / step) * step;
    const key = rounded.toFixed(2);
    stats.set(key, (stats.get(key) || 0) + 1);
  });
  let winner = 0;
  let count = 0;
  stats.forEach((value, key) => {
    if (value > count) {
      count = value;
      winner = Number(key);
    }
  });
  return { value: winner, count };
}

function detectDocxLayoutMode(blocks) {
  const paragraphs = (blocks || [])
    .filter(block => block?.type === 'paragraph' && block.meta)
    .map(block => block.meta);
  const bodyParagraphs = paragraphs.filter(meta =>
    !meta.heading &&
    !meta.isToc &&
    !meta.hasImage &&
    meta.textLength > 0
  );
  if (bodyParagraphs.length < 4) return 'preserve';

  const lineValues = bodyParagraphs
    .map(meta => meta.lineTwip > 0 ? Number((meta.lineTwip / 240).toFixed(2)) : 0)
    .filter(Boolean);
  const dominantLine = getDominantRoundedMetric(lineValues, 0.05);
  const matchingLineCount = bodyParagraphs.filter(meta => {
    if (!(meta.lineTwip > 0) || !(dominantLine.value > 0)) return true;
    const current = meta.lineTwip / 240;
    return Math.abs(current - dominantLine.value) <= 0.16;
  }).length;
  const customSpacingCount = bodyParagraphs.filter(meta =>
    meta.spacingBeforeTwip > 240 ||
    meta.spacingAfterTwip > 240 ||
    meta.indentLeftTwip > 720 ||
    (meta.align && meta.align !== 'left')
  ).length;
  const compactLineCount = bodyParagraphs.filter(meta => meta.lineTwip > 0 && (meta.lineTwip / 240) < 1.9).length;

  const lineConsistency = matchingLineCount / bodyParagraphs.length;
  const customSpacingRatio = customSpacingCount / bodyParagraphs.length;
  const compactLineRatio = compactLineCount / bodyParagraphs.length;

  if (
    lineConsistency >= 0.8 &&
    customSpacingRatio <= 0.18 &&
    compactLineRatio >= 0.55
  ) {
    return 'reading';
  }
  return 'preserve';
}

function extractDocxHtmlBlocks(absPath) {
  const documentXml = getZipEntryBuffer(absPath, 'word/document.xml').toString('utf8');
  const rels = getDocxRelationships(absPath);
  const mediaMap = getDocxMediaMap(absPath, rels);
  const blocks = [];
  const diagnostics = [];

  getTopLevelDocxBlocks(documentXml, ['p', 'tbl'], diagnostics).forEach(entry => {
    if (entry.tag === 'p') {
      blocks.push(...renderDocxParagraphBlocks(entry.xml, mediaMap, rels));
      return;
    }
    if (entry.tag === 'tbl') {
      blocks.push({ type: 'table', html: renderDocxTable(entry.xml, mediaMap, rels), splittable: false });
    }
  });

  if (diagnostics.length) {
    const first = diagnostics[0];
    console.warn(
      `[docx] block extraction truncated for ${path.basename(absPath)} after ${first.blockCount} blocks at offset ${first.offset}/${first.sourceLength} near: ${first.snippet}`
    );
  } else if (DOCX_PARSER_DEBUG) {
    console.log(`[docx] parsed ${path.basename(absPath)} into ${blocks.length} preview blocks`);
  }

  return {
    blocks,
    layoutMode: detectDocxLayoutMode(blocks),
    diagnostics
  };
}

function decodeTextBuffer(buf) {
  if (!buf?.length) return { text: '', encoding: 'utf8', bom: null };
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { text: buf.slice(3).toString('utf8'), encoding: 'utf8', bom: 'utf8' };
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return { text: buf.slice(2).toString('utf16le'), encoding: 'utf16le', bom: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1] ?? 0;
      swapped[i - 1] = buf[i];
    }
    return { text: swapped.toString('utf16le'), encoding: 'utf16be', bom: 'utf16be' };
  }

  const utf8 = buf.toString('utf8');
  let utf8Strict = null;
  try {
    utf8Strict = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {}
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  const utf16ZeroCount = [...buf].filter((byte, idx) => idx % 2 === 1 && byte === 0).length;
  if (utf16ZeroCount > buf.length / 6) {
    return { text: buf.toString('utf16le').replace(/^\uFEFF/, ''), encoding: 'utf16le', bom: null };
  }
  // If the buffer is valid UTF-8, prefer it directly instead of letting
  // legacy encodings win via heuristic scoring on Japanese/CJK text.
  if (utf8Strict !== null) {
    return { text: utf8Strict.replace(/^\uFEFF/, ''), encoding: 'utf8', bom: null };
  }
  const COMMON_CJK_CHARS = [
    '的一是在不了有人我他這個們來到時大地為子中你說生國年著就那和要她出也得裡後自以會家可下而過天去能對小多然於心學之都好看起發當沒成只如事把還用第樣道想作種開美總從無情己面最女但現前些所同日手又行意動方期它頭經長兒回位分愛老因很給名法間斯知世什兩次使身者被高已親其進此話常與活正感以及让讓點應'
  ].join('');
  const COMMON_CJK_WORDS = [
    '機制', '設計', '說明', '規則', '資料', '角色', '場景', '內容',
    '檔案', '編輯', '歷史', '版本', '測試', '輸入', '輸出', '空白',
    '段落', '符號', '格式', '尋找', '取代'
  ];
  const COMMON_JP_WORDS = [
    'シナリオ', 'ハンドアウト', 'キャラクター', 'セッション', 'シーン', '情報',
    '探索者', '目星', '聞き耳', 'アイデア', 'SAN', '推奨', '概要',
    '導入', '終了', '秘匿', '公開', '技能', '時間', '人数'
  ];
  const COMMON_JP_KANJI = [
    '本', '文', '問', '死', '定', '義', '告', '知', '年', '月', '日', '時', '間',
    '人', '物', '場', '合', '前', '後', '上', '下', '中', '大', '小', '出', '入',
    '見', '行', '来', '気', '心', '名', '何', '事', '者', '生', '会', '話', '家',
    '手', '目', '耳', '情', '報', '探', '索', '者', '導', '入', '終', '了', '公',
    '開', '技', '能', '設', '定', '役', '割', '相', '手', '部', '屋', '扉', '声'
  ];
  const COMMON_JP_CHARS = 'のにをたがでてとしれさあるいるもするからなこととしていくられるへるやだですます';
  const COMMON_CJK_CHAR_RE = new RegExp('[' + COMMON_CJK_CHARS + ']', 'gu');
  const HAN_RE = /\p{Script=Han}/gu;
  const HIRAGANA_KATAKANA_RE = /[\u3040-\u30FF]/gu;
  const PRINTABLE_RE = /[\t\n\r\u0020-\u007E\u00A0-\u024F\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/gu;
  const SUSPICIOUS_RE = /[ □ ▲△◆◇○◎●☆★※〒→←↑↓╳╱╲]|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu;
  const MOJIBAKE_RE = /[螟譛縺繧繝莠蜈逕荳莉驛鬮鞜魍鮖籖]/gu;
  function scoreDecodedText(text, encoding) {
    const value = String(text || '');
    if (!value) return Number.NEGATIVE_INFINITY;
    const length = value.length || 1;
    const replacement = (value.match(/\uFFFD/g) || []).length;
    const suspicious = (value.match(SUSPICIOUS_RE) || []).length;
    const hanCount = (value.match(HAN_RE) || []).length;
    const kanaCount = (value.match(HIRAGANA_KATAKANA_RE) || []).length;
    const commonCharCount = (value.match(COMMON_CJK_CHAR_RE) || []).length;
    const commonJpCharCount = [...COMMON_JP_CHARS].reduce((count, char) => count + (value.includes(char) ? 1 : 0), 0);
    const commonJpKanjiCount = COMMON_JP_KANJI.reduce((count, char) => count + (value.includes(char) ? 1 : 0), 0);
    const commonWordCount = COMMON_CJK_WORDS.reduce((count, word) => count + (value.includes(word) ? 1 : 0), 0);
    const commonJpWordCount = COMMON_JP_WORDS.reduce((count, word) => count + (value.includes(word) ? 1 : 0), 0);
    const mojibakeCount = (value.match(MOJIBAKE_RE) || []).length;
    const printableCount = (value.match(PRINTABLE_RE) || []).length;
    const looksJapanese = kanaCount >= Math.max(2, length * 0.015) || commonJpWordCount > 0;
    const effectiveJpKanjiCount = looksJapanese ? commonJpKanjiCount : 0;
    const commonHanRatio = hanCount > 0 ? (commonCharCount + effectiveJpKanjiCount) / hanCount : 0;
    let score = 0;
    score += printableCount / length * 30;
    score += commonCharCount / Math.max(1, hanCount) * 34;
    score += commonWordCount * 3;
    score += Math.min(hanCount / length, 0.85) * 12;
    score += Math.min(kanaCount / length, 0.45) * 18;
    score += commonJpCharCount * 0.8;
    score += effectiveJpKanjiCount * 0.45;
    score += commonJpWordCount * 4;
    score -= replacement * 25;
    score -= suspicious * 6;
    score -= mojibakeCount * 1.6;
    if (/utf-?8|utf8/i.test(encoding) && replacementCount <= Math.max(1, Math.floor(buf.length / 160))) score += 8;
    if (/utf-?8|utf8/i.test(encoding) && utf8Strict !== null) score += 20;
    if (kanaCount >= Math.max(6, length * 0.05) && !/shift_jis|cp932|euc-jp|utf-?8/i.test(encoding)) score -= 18;
    if ((hanCount > 0 || kanaCount > 0) && commonCharCount === 0 && commonWordCount === 0 && commonJpWordCount === 0 && commonJpCharCount === 0) score -= 10;
    if (hanCount >= 24 && kanaCount <= 1 && commonWordCount === 0 && commonJpWordCount === 0 && commonHanRatio < 0.16) score -= 26;
    if (/big5|cp950|gb18030/i.test(encoding) && hanCount >= 24 && kanaCount <= 1 && commonHanRatio < 0.2) score -= 12;
    return score;
  }

  const candidates = [];
  function pushCandidate(text, encoding) {
    const decoded = String(text || '').replace(/^\uFEFF/, '');
    if (!decoded || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded)) return;
    candidates.push({ text: decoded, encoding, bom: null, score: scoreDecodedText(decoded, encoding) });
  }

  pushCandidate(utf8Strict ?? utf8, 'utf8');
  for (const encoding of ['big5', 'cp950', 'gb18030', 'shift_jis', 'cp932', 'euc-jp', 'utf16le']) {
    try {
      pushCandidate(iconv.decode(buf, encoding), encoding);
    } catch {}
  }
  for (const encoding of ['big5', 'gb18030', 'shift_jis', 'euc-jp']) {
    try {
      pushCandidate(new TextDecoder(encoding, { fatal: true }).decode(buf), encoding);
    } catch {}
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    const isJpEncoding = encoding => /shift_jis|cp932|euc-jp/i.test(String(encoding || ''));
    const isCnEncoding = encoding => /big5|cp950|gb18030/i.test(String(encoding || ''));
    const countKana = text => (String(text || '').match(HIRAGANA_KATAKANA_RE) || []).length;
    const countJpWords = text => COMMON_JP_WORDS.reduce((count, word) => count + (String(text || '').includes(word) ? 1 : 0), 0);
    const top = candidates[0];
    const bestJp = candidates.find(candidate => isJpEncoding(candidate.encoding));
    if (bestJp && isCnEncoding(top.encoding)) {
      const topKana = countKana(top.text);
      const jpKana = countKana(bestJp.text);
      const topJpWords = countJpWords(top.text);
      const jpJpWords = countJpWords(bestJp.text);
      const jpClearlyMoreJapanese =
        jpKana >= Math.max(6, topKana + 4) ||
        jpJpWords >= Math.max(2, topJpWords + 1);
      const scoreCloseEnough = bestJp.score >= top.score - 18;
      if (jpClearlyMoreJapanese && scoreCloseEnough) {
        return { text: bestJp.text, encoding: bestJp.encoding, bom: null };
      }
    }
    return { text: top.text, encoding: top.encoding, bom: null };
  }
  return { text: utf8.replace(/\uFFFD/g, ''), encoding: 'utf8', bom: null };
}

const MANUAL_TEXT_ENCODINGS = ['utf8', 'utf16le', 'utf16be', 'big5', 'cp950', 'gb18030', 'shift_jis', 'cp932', 'euc-jp'];
const TEXT_ENCODING_FAMILIES = ['jp-auto', 'zh-hant-auto', 'zh-hans-auto'];

function normalizeTextEncodingChoice(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return '';
  if (TEXT_ENCODING_FAMILIES.includes(raw)) return raw;
  if (raw === 'utf-8') return 'utf8';
  if (raw === 'utf-16le') return 'utf16le';
  if (raw === 'utf-16be') return 'utf16be';
  if (raw === 'sjis') return 'shift_jis';
  return MANUAL_TEXT_ENCODINGS.includes(raw) ? raw : '';
}

function decodeTextBufferWithEncoding(buf, encoding) {
  const normalizedEncoding = normalizeTextEncodingChoice(encoding);
  if (!normalizedEncoding) return decodeTextBuffer(buf);
  if (normalizedEncoding === 'jp-auto' || normalizedEncoding === 'zh-hant-auto' || normalizedEncoding === 'zh-hans-auto') {
    const candidates = normalizedEncoding === 'jp-auto'
      ? ['cp932', 'shift_jis', 'euc-jp']
      : normalizedEncoding === 'zh-hant-auto'
        ? ['cp950', 'big5']
        : ['gb18030'];
    const JP_WORDS = ['シナリオ', 'ハンドアウト', '探索者', '情報', '導入', '終了', '公開', '秘匿', '技能', '時間'];
    const JP_CHARS = 'のにをたがでてとしれさあるいるもするからなこととしていくられるへるやだですます';
    const CJK_WORDS = ['設定', '內容', '說明', '角色', '資料', '規則', '場景', '檔案', '編輯', '版本'];
    const PRINTABLE_RE = /[\t\n\r\u0020-\u007E\u00A0-\u024F\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/gu;
    const SUSPICIOUS_RE = /[ □ ▲△◆◇○◎●☆★※〒→←↑↓╳╱╲]|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu;
    const KANA_RE = /[\u3040-\u30FF]/gu;
    const scoreFamilyText = (text, family) => {
      const value = String(text || '');
      if (!value) return Number.NEGATIVE_INFINITY;
      const length = value.length || 1;
      const printable = (value.match(PRINTABLE_RE) || []).length;
      const suspicious = (value.match(SUSPICIOUS_RE) || []).length;
      if (family === 'jp-auto') {
        const kana = (value.match(KANA_RE) || []).length;
        const jpWords = JP_WORDS.reduce((count, word) => count + (value.includes(word) ? 1 : 0), 0);
        const jpChars = [...JP_CHARS].reduce((count, char) => count + (value.includes(char) ? 1 : 0), 0);
        return printable / length * 18 + kana * 1.8 + jpWords * 10 + jpChars * 0.6 - suspicious * 12;
      }
      const cjkWords = CJK_WORDS.reduce((count, word) => count + (value.includes(word) ? 1 : 0), 0);
      return printable / length * 18 + cjkWords * 6 - suspicious * 12;
    };
    let best = null;
    for (const candidate of candidates) {
      try {
        const text = iconv.decode(buf, candidate).replace(/^\uFEFF/, '');
        const score = scoreFamilyText(text, normalizedEncoding);
        if (!best || score > best.score) best = { text, encoding: candidate, bom: null, score };
      } catch {}
    }
    if (best) return { text: best.text, encoding: best.encoding, bom: best.bom };
  }
  if (normalizedEncoding === 'utf8') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
    const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF ? 'utf8' : null;
    return { text, encoding: 'utf8', bom };
  }
  if (normalizedEncoding === 'utf16le') {
    const hasBom = buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE;
    const text = (hasBom ? buf.slice(2) : buf).toString('utf16le').replace(/^\uFEFF/, '');
    return { text, encoding: 'utf16le', bom: hasBom ? 'utf16le' : null };
  }
  if (normalizedEncoding === 'utf16be') {
    const hasBom = buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF;
    const source = hasBom ? buf.slice(2) : buf;
    const swapped = Buffer.allocUnsafe(source.length);
    for (let i = 0; i < source.length; i += 2) {
      swapped[i] = source[i + 1] ?? 0;
      swapped[i + 1] = source[i] ?? 0;
    }
    return { text: swapped.toString('utf16le').replace(/^\uFEFF/, ''), encoding: 'utf16be', bom: hasBom ? 'utf16be' : null };
  }
  return { text: iconv.decode(buf, normalizedEncoding).replace(/^\uFEFF/, ''), encoding: normalizedEncoding, bom: null };
}

function readTextFile(absPath, preferredEncoding = '') {
  return decodeTextBufferWithEncoding(fs.readFileSync(absPath), preferredEncoding);
}

function ensureHtmlPreviewCharset(htmlText = '') {
  const html = String(htmlText || '');
  if (!html) return html;
  if (/<meta[^>]+charset\s*=/i.test(html) || /<meta[^>]+http-equiv\s*=\s*["']content-type["'][^>]*charset=/i.test(html)) {
    return html;
  }
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b([^>]*)>/i, match => `${match}\n<meta charset="utf-8">`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, match => `${match}\n<head><meta charset="utf-8"></head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}

function encodeTextBuffer(text, meta = {}) {
  const normalized = String(text || '');
  if (meta.encoding === 'utf16be') {
    const le = Buffer.from(normalized, 'utf16le');
    const body = Buffer.allocUnsafe(le.length);
    for (let i = 0; i < le.length; i += 2) {
      body[i] = le[i + 1] ?? 0;
      body[i + 1] = le[i];
    }
    return meta.bom === 'utf16be' ? Buffer.concat([Buffer.from([0xFE, 0xFF]), body]) : body;
  }
  if (meta.encoding === 'utf16le') {
    const body = Buffer.from(normalized, 'utf16le');
    return meta.bom === 'utf16le' ? Buffer.concat([Buffer.from([0xFF, 0xFE]), body]) : body;
  }
  if (['big5', 'cp950', 'gb18030', 'cp932', 'shift_jis', 'euc-jp'].includes(meta.encoding)) {
    return iconv.encode(normalized, meta.encoding);
  }
  const body = Buffer.from(normalized, 'utf8');
  return meta.bom === 'utf8' ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]) : body;
}

function getFileTimeMeta(absPath) {
  const stat = fs.statSync(absPath);
  const createdAt = stat.birthtime instanceof Date && !Number.isNaN(stat.birthtime.getTime())
    ? stat.birthtime
    : (stat.ctime instanceof Date ? stat.ctime : stat.mtime);
  const updatedAt = stat.mtime instanceof Date ? stat.mtime : createdAt;
  return { createdAt, updatedAt };
}

function formatDateTimeToSecond(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function getTextEditMeta(item, fileKey, absPath) {
  const fileTimes = getFileTimeMeta(absPath);
  const savedMeta = item?.textEditMeta && typeof item.textEditMeta === 'object'
    ? item.textEditMeta[fileKey]
    : null;
  const savedAt = savedMeta?.savedAt ? new Date(savedMeta.savedAt) : fileTimes.updatedAt;
  const cfg = readCfg();
  const savedById = typeof savedMeta?.savedById === 'string' ? savedMeta.savedById.trim() : '';
  const savedByUser = savedById ? getAuthUserById(cfg, savedById) : null;
  return {
    createdAt: fileTimes.createdAt,
    savedAt: Number.isNaN(savedAt?.getTime?.()) ? fileTimes.updatedAt : savedAt,
    savedBy: savedByUser?.username || (typeof savedMeta?.savedBy === 'string' ? savedMeta.savedBy.trim() : '')
  };
}

function getTextHistoryPath(collection, itemId, fileKey) {
  const collectionKey = sanitizeCollectionKey(collection || 'scenario');
  const itemKey = String(itemId || 'item').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'item';
  const fileName = path.posix.basename(String(fileKey || 'document.txt'));
  const safeBase = sanitizeDownloadName(path.parse(fileName).name || 'document', 'document');
  const digest = sha256(`${collectionKey}:${itemKey}:${fileKey || ''}`).slice(0, 16);
  return path.join(TEXT_HISTORY_DIR, collectionKey, `${itemKey}__${safeBase}__${digest}.json`);
}

function readTextHistoryVersions(collection, itemId, fileKey) {
  const historyPath = getTextHistoryPath(collection, itemId, fileKey);
  if (!fs.existsSync(historyPath)) return [];
  const raw = readJSON(historyPath, {});
  return Array.isArray(raw?.versions) ? raw.versions : [];
}

function writeTextHistoryVersions(collection, itemId, fileKey, versions) {
  const historyPath = getTextHistoryPath(collection, itemId, fileKey);
  if (!Array.isArray(versions) || !versions.length) {
    if (fs.existsSync(historyPath)) fs.unlinkSync(historyPath);
    return;
  }
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  writeJSON(historyPath, { versions });
}

function appendTextHistoryVersion(collection, item, fileKey, entry) {
  const versions = readTextHistoryVersions(collection, item?.id, fileKey);
  const last = versions.length ? versions[versions.length - 1] : null;
  const nextEntry = {
    id: crypto.randomUUID(),
    savedAt: entry.savedAt,
    savedById: entry.savedById || '',
    savedBy: entry.savedBy || '',
    mode: entry.mode === 'auto' ? 'auto' : 'manual',
    filename: entry.filename || path.posix.basename(fileKey || 'document.txt'),
    text: typeof entry.text === 'string' ? entry.text : ''
  };
  if (
    last &&
    last.text === nextEntry.text &&
    last.filename === nextEntry.filename
  ) {
    last.savedAt = nextEntry.savedAt;
    last.savedById = nextEntry.savedById;
    last.savedBy = nextEntry.savedBy;
    last.mode = nextEntry.mode;
    writeTextHistoryVersions(collection, item?.id, fileKey, versions);
    return versions;
  }
  versions.push(nextEntry);
  writeTextHistoryVersions(collection, item?.id, fileKey, versions);
  return versions;
}

function moveTextHistoryVersions(collection, itemId, fromFileKey, toFileKey) {
  if (!fromFileKey || !toFileKey || fromFileKey === toFileKey) return;
  const fromPath = getTextHistoryPath(collection, itemId, fromFileKey);
  if (!fs.existsSync(fromPath)) return;
  const versions = readTextHistoryVersions(collection, itemId, fromFileKey);
  writeTextHistoryVersions(collection, itemId, toFileKey, versions);
  if (fs.existsSync(fromPath)) fs.unlinkSync(fromPath);
}

function listTextHistoryFiles(dirPath = TEXT_HISTORY_DIR) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTextHistoryFiles(abs));
      continue;
    }
    if (entry.isFile() && abs.toLowerCase().endsWith('.json')) files.push(abs);
  }
  return files;
}

function pruneExpiredTextHistoryFiles(now = Date.now()) {
  const removed = [];
  for (const historyPath of listTextHistoryFiles()) {
    const raw = readJSON(historyPath, {});
    const versions = Array.isArray(raw?.versions) ? raw.versions : [];
    if (!versions.length) {
      try { fs.unlinkSync(historyPath); removed.push(historyPath); } catch {}
      continue;
    }
    const lastVersion = versions[versions.length - 1] || {};
    const lastSavedAtMs = Number(new Date(lastVersion.savedAt || 0));
    if (!Number.isFinite(lastSavedAtMs) || now - lastSavedAtMs < TEXT_HISTORY_RETENTION_MS) continue;
    try {
      fs.unlinkSync(historyPath);
      removed.push(historyPath);
    } catch {}
  }
  return removed;
}

function formatReadOnlyMeta(options = {}) {
  const label = escapeXml(options.label || '');
  const updatedAtLabel = escapeXml(options.updatedAtLabel || '');
  const updatedByLabel = escapeXml(options.updatedByLabel || '');
  if (!label && !updatedAtLabel && !updatedByLabel) return '';
  return `<div class="meta-times">
    <span id="metaLabelWrap"${label ? '' : ' style="display:none"'}><span id="metaLabelText">${label}</span></span>
    <span class="meta-dot" id="metaDotPrimary"${label && updatedAtLabel ? '' : ' style="display:none"'} aria-hidden="true"></span>
    <time id="updatedAtText">${updatedAtLabel}</time>
    <span class="meta-dot" id="updatedDot"${updatedAtLabel && updatedByLabel ? '' : ' style="display:none"'} aria-hidden="true"></span>
    <span id="updatedByWrap"${updatedByLabel ? '' : ' style="display:none"'}><span id="updatedByText">${updatedByLabel}</span></span>
  </div>`;
}

/*
function getPreviewSourceText(file) {
  if (!file?.abs || !fs.existsSync(file.abs)) throw new Error('找不到預覽來源檔案');
  if (file.ext === '.txt') {
    return fs.readFileSync(file.abs, 'utf8');
  }
  if (file.ext === '.docx') {
    return extractDocxText(file.abs);
  }
  throw new Error('這個檔案格式目前不支援線上閱覽');
}

function normalizePreviewText(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  return raw || '這份文件沒有可顯示的文字內容。';
}

*/
function getPreviewSourceText(file, preferredEncoding = '') {
  if (!file?.abs || !fs.existsSync(file.abs)) throw new Error('Preview source file was not found.');
  if (file.ext === '.txt') {
    return readTextFile(file.abs, preferredEncoding).text;
  }
  if (file.ext === '.docx') {
    return extractDocxText(file.abs);
  }
  throw new Error('This file type is not supported for online preview.');
}

function normalizePreviewText(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  return raw || 'This document does not contain readable text for preview.';
}

function renderDocxPreviewPage(item, file, blocks = [], options = {}) {
  const previewLabel = getPreviewLabel(file);
  const docxMainTitleRaw = path.parse(file?.name || path.basename(file?.key || 'document')).name || previewLabel;
  const docxMetaTitleRaw = item?.translatedTitle || item?.title || docxMainTitleRaw;
  const pageTitle = escapeXml(docxMainTitleRaw);
  const docxMetaTitle = escapeXml(docxMetaTitleRaw);
  const kind = 'Docx 文件閱覽';
  const docxLayoutMode = options.layoutMode === 'reading' ? 'reading' : 'preserve';
  const blockHtml = blocks.map((block, idx) => {
    if (block.type === 'pagebreak') return `<hr class="docx-page-divider" data-idx="${idx}">`;
    return `<div class="docx-block" data-kind="${escapeXml(block.type)}" data-idx="${idx}">${block.html}</div>`;
  }).join('');
  const scrollMemoryScript = renderPreviewScrollMemoryScript(options.scrollMemoryKey || '');

  const noContextMenuScript = options.disableContextMenu ? `\n  ${getNoContextMenuScript()}` : '';
  const openccScript = `\n  <script src="/vendor/opencc-js/full.js"></script>`;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  ${PREVIEW_NOTO_FONT_LINKS}
  <style>
    :root{
      --bg:#fff;--text:#222;--muted:#777;--line:#e8e8e8;--link:#2f6db5;
    }
    html[data-theme="dark"]{
      --bg:#111118;--text:#ece7df;--muted:#9a958d;--line:#2a2a34;--link:#8fb6ff;
    }
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:var(--bg);color:var(--text)}
    body{
      font-family:${PREVIEW_SERIF_FONT_STACK};
      text-rendering:optimizeLegibility;
      -webkit-font-smoothing:antialiased;
      transition:background .2s ease,color .2s ease;
    }
    .page{width:min(100%,720px);margin:0 auto;padding:48px 24px 72px}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}
    .brand{font-size:13px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;white-space:nowrap}
    .actions{display:flex;align-items:center;gap:10px}
    .action-btn{
      border:none;background:transparent;color:var(--muted);padding:0 2px;
      font:inherit;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;height:30px;line-height:1
    }
    .action-btn:hover{color:var(--text)}
    .icon-btn{
      width:30px;height:30px;border:none;background:transparent;color:var(--muted);
      display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0
    }
    .icon-btn:hover{color:var(--text)}
    .icon{width:18px;height:18px;display:block}
    .meta{margin-bottom:18px}
    .title{margin:0;font-size:28px;line-height:1.32;font-weight:700;letter-spacing:.01em}
    .article{
      font-size:16px;line-height:1.92;letter-spacing:.01em;word-break:break-word;
    }
    .docx-block + .docx-block{margin-top:0}
.docx-paragraph{margin:0;white-space:pre-wrap;word-break:break-word;line-height:1.92;font-size:16px}
    .docx-heading-1,.docx-heading-2,.docx-heading-3,.docx-heading-4,.docx-heading-5,.docx-heading-6{font-family:inherit;font-weight:700;line-height:1.35}
    .docx-heading-1,.docx-heading-2{margin:2.4em 0 .9em;font-size:28px}
    .docx-heading-3{margin:2.1em 0 .85em;font-size:24px}
    .docx-heading-4{margin:1.8em 0 .8em;font-size:20px}
    .docx-heading-5,.docx-heading-6{font-size:1rem}
    .docx-align-center{text-align:center}
    .docx-align-right{text-align:right}
    .docx-align-both{text-align:justify}
    .docx-toc-entry{font-size:1rem}
    .docx-empty{opacity:.55}
    .docx-reading-layout .docx-body-paragraph{
      margin-top:0 !important;
      margin-bottom:0 !important;
      line-height:1.92 !important;
    }
    .docx-reading-layout .docx-body-paragraph[data-empty="true"]{
      min-height:1.92em;
    }
    .docx-image{display:block;max-width:100%;height:auto;margin:1.5em auto;border-radius:0;cursor:zoom-in}
    .docx-table-wrap{overflow-x:auto;margin:0 0 1.2em}
    .docx-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:15px;line-height:1.7}
    .docx-table td,.docx-table th{border:1px solid var(--line);padding:10px 12px;vertical-align:top}
    .docx-table p{margin:0 0 .7em}
    .docx-table p:last-child{margin-bottom:0}
    .docx-link,.article a{color:var(--link);text-decoration:none}
    .docx-link:hover,.article a:hover{text-decoration:underline}
    .docx-anchor{display:block;position:relative;top:-8px;visibility:hidden}
    .docx-page-divider{border:none;border-top:1px solid var(--line);margin:2em 0}
    .article blockquote{margin:1.8em 0;padding-left:18px;border-left:3px solid #d7d7d7;color:#444}
    html[data-theme="dark"] .article blockquote{border-left-color:#8f8679;color:#d2cbc2}
    .docx-zoom{position:fixed;inset:0;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.72);z-index:999}
    .docx-zoom.on{display:flex}
    .docx-zoom img{max-width:min(96vw,1400px);max-height:92vh;object-fit:contain;border:1px solid rgba(255,255,255,.18);background:#000}
    .divider{height:1px;background:var(--line);margin:0 0 36px}
    .footer{margin-top:44px;padding-top:14px;border-top:1px solid var(--line);font-size:14px;color:var(--muted);text-align:center}
    @media (max-width: 720px){
      .page{padding:30px 20px 48px}
      .docx-heading-1,.docx-heading-2{font-size:24px}
      .docx-heading-3{font-size:20px}
      .docx-table{font-size:14px}
    }
  </style>
  <script>
    (() => {
      const mode = localStorage.getItem('theme-mode') === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = mode;
      document.addEventListener('DOMContentLoaded', () => {
        document.body.dataset.theme = mode;
      });
    })();
  </script>
</head>
<body>
  <main class="page">
    <div class="topbar">
      <div class="brand">${docxMetaTitle}</div>
      <div class="actions">
        <button class="action-btn" id="docxCnToTwpBtn" type="button" title="简体中文 轉 繁體中文">简转繁</button>
        <button class="icon-btn" id="theme-btn" type="button" aria-label="切換顯示模式" title="切換顯示模式"></button>
      </div>
    </div>
    <header class="meta">
      <h1 class="title">${pageTitle}</h1>
    </header>
    <div class="divider" aria-hidden="true"></div>
    <article class="article ${docxLayoutMode === 'reading' ? 'docx-reading-layout' : 'docx-preserve-layout'}">${blockHtml || '<p class="docx-paragraph docx-empty">&nbsp;</p>'}</article>
    <div class="footer">Read-only preview.</div>
  </main>
  <div class="docx-zoom" id="docxZoom" aria-hidden="true"><img id="docxZoomImg" alt=""></div>
  ${openccScript}
  <script>
    const themeIcon = kind => kind === 'moon'
      ? '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>'
      : '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3"/></svg>';

    function applyTheme(theme) {
      const mode = theme === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = mode;
      document.body.dataset.theme = mode;
      localStorage.setItem('theme-mode', mode);
      const btn = document.getElementById('theme-btn');
      if (btn) btn.innerHTML = mode === 'light' ? themeIcon('moon') : themeIcon('sun');
    }

    function toggleTheme() {
      const next = (document.body.dataset.theme || 'dark') === 'light' ? 'dark' : 'light';
      applyTheme(next);
    }
    const zoom = document.getElementById('docxZoom');
    const zoomImg = document.getElementById('docxZoomImg');
    const article = document.querySelector('.article');
    const docxCnToTwpBtn = document.getElementById('docxCnToTwpBtn');
    const openccReady = typeof OpenCC !== 'undefined' && typeof OpenCC.Converter === 'function';
    const cnToTwp = openccReady ? OpenCC.Converter({ from: 'cn', to: 'twp' }) : null;
    let docxConverted = false;
    let docxTextNodes = null;

    function getDocxTextNodes() {
      if (docxTextNodes) return docxTextNodes;
      const nodes = [];
      if (!article) return nodes;
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let current;
      while ((current = walker.nextNode())) {
        nodes.push({ node: current, original: current.nodeValue });
      }
      docxTextNodes = nodes;
      return nodes;
    }

    function toggleDocxCnToTwp() {
      if (!cnToTwp) {
        window.alert('繁簡轉換元件尚未載入。');
        return;
      }
      const nodes = getDocxTextNodes();
      nodes.forEach(entry => {
        entry.node.nodeValue = docxConverted ? entry.original : cnToTwp(entry.original);
      });
      docxConverted = !docxConverted;
      if (docxCnToTwpBtn) docxCnToTwpBtn.textContent = docxConverted ? '顯示原文' : '简转繁';
    }

    function openZoom(src) {
      if (!zoom || !zoomImg || !src) return;
      zoomImg.src = src;
      zoom.classList.add('on');
      zoom.setAttribute('aria-hidden', 'false');
    }

    function closeZoom() {
      if (!zoom || !zoomImg) return;
      zoom.classList.remove('on');
      zoom.setAttribute('aria-hidden', 'true');
      zoomImg.src = '';
    }

    docxCnToTwpBtn?.addEventListener('click', toggleDocxCnToTwp);
    document.getElementById('theme-btn')?.addEventListener('click', toggleTheme);
    applyTheme(localStorage.getItem('theme-mode') === 'dark' ? 'dark' : 'light');
    document.querySelectorAll('.docx-image').forEach(img => {
      img.addEventListener('click', () => openZoom(img.src));
    });
    zoom?.addEventListener('click', closeZoom);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeZoom();
    });
  </script>
  ${scrollMemoryScript}
  ${noContextMenuScript}
</body>
</html>`;
}

function splitTextNavigationBlocks(text = '') {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const blocks = [];
  let offset = 0;
  let blockStart = -1;
  let blockLines = [];
  let blockEnd = -1;
  const pushBlock = () => {
    if (blockStart < 0 || !blockLines.length) return;
    const textValue = blockLines.join('\n');
    const firstLine = blockLines.find(line => line.trim()) || '';
    blocks.push({
      index: blocks.length,
      start: blockStart,
      end: blockEnd,
      text: textValue,
      label: firstLine.replace(/\s+/g, ' ').trim() || `第 ${blocks.length + 1} 段`,
      lineCount: blockLines.length
    });
    blockStart = -1;
    blockLines = [];
    blockEnd = -1;
  };
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const lineStart = offset;
    const hasBreak = idx < lines.length - 1;
    offset += line.length + (hasBreak ? 1 : 0);
    if (line.trim()) {
      if (blockStart < 0) blockStart = lineStart;
      blockLines.push(line);
      blockEnd = offset - (hasBreak ? 1 : 0);
      continue;
    }
    pushBlock();
  }
  pushBlock();
  return blocks;
}

function renderTxtReadOnlyBlocksHtml(text = '') {
  const blocks = splitTextNavigationBlocks(text);
  if (!blocks.length) return `<div class="txt-block txt-block-empty" data-block-index="0"></div>`;
  return blocks.map(block => `<section class="txt-block" data-block-index="${block.index}"><span class="txt-block-anchor" id="txt-block-${block.index}"></span>${escapeXml(block.text)}</section>`).join('');
}

function renderPreviewScrollMemoryScript(storageKey, options = {}) {
  const key = String(storageKey || '').trim();
  if (!key) return '';
  return `<script>(()=>{const storageKey=${JSON.stringify(`preview-scroll:${key}`)},targetSelector=${JSON.stringify(options.targetSelector || '')};let saveTimer=0;function getTarget(){return targetSelector?document.querySelector(targetSelector):null}function readState(){try{const raw=sessionStorage.getItem(storageKey);return raw?JSON.parse(raw):null}catch{return null}}function writeState(){try{const payload={scrollY:window.scrollY||window.pageYOffset||0};const target=getTarget();if(target)payload.targetScrollTop=target.scrollTop||0;sessionStorage.setItem(storageKey,JSON.stringify(payload));}catch{}}function scheduleSave(){if(saveTimer)window.clearTimeout(saveTimer);saveTimer=window.setTimeout(writeState,80)}function restoreState(){const state=readState();if(!state)return;const target=getTarget();const targetScrollTop=Number(state?.targetScrollTop);const windowScrollY=Number(state?.scrollY);let attempts=0;function apply(){attempts+=1;if(target&&Number.isFinite(targetScrollTop))target.scrollTop=targetScrollTop;if(Number.isFinite(windowScrollY))window.scrollTo(0,Math.max(0,windowScrollY));if(attempts<8)requestAnimationFrame(apply)}requestAnimationFrame(apply)}window.addEventListener('scroll',scheduleSave,{passive:true});window.addEventListener('beforeunload',writeState);window.addEventListener('pagehide',writeState);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')writeState()});window.addEventListener('load',restoreState);restoreState();})();</script>`;
}

function renderTextPreviewPage(item, file, text, options = {}) {
  const isTxt = file.ext === '.txt';
  const previewLabel = getPreviewLabel(file);
  const fileNameRaw = String(file?.name || path.basename(file?.key || 'document'));
  const txtMainTitleRaw = path.parse(fileNameRaw).name || previewLabel;
  const txtMetaTitleRaw = item?.translatedTitle || item?.title || txtMainTitleRaw;
  const pageTitle = escapeXml(isTxt ? txtMainTitleRaw : previewLabel);
  const normalizedText = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawBody = escapeXml(normalizedText);
  const displayBody = rawBody || escapeXml(normalizePreviewText(text));
  const canEditTxt = !!options.canEditTxt;
  const txtReadOnlyBlocksHtml = isTxt && !canEditTxt ? renderTxtReadOnlyBlocksHtml(normalizedText) : '';
  const scrollMemoryScript = renderPreviewScrollMemoryScript(options.scrollMemoryKey || '', {
    targetSelector: isTxt && canEditTxt ? '#editor' : ''
  });
  const metaHtml = formatReadOnlyMeta({
    label: txtMetaTitleRaw,
    updatedAtLabel: options.updatedAtLabel || '',
    updatedByLabel: options.updatedByLabel || ''
  });
  const noContextMenuScript = options.disableContextMenu ? `\n  ${getNoContextMenuScript()}` : '';
  const filenameValue = escapeXml(path.parse(fileNameRaw).name || fileNameRaw);
  const selectedEncoding = normalizeTextEncodingChoice(options.selectedEncoding) || 'auto';
  const detectedEncoding = normalizeTextEncodingChoice(options.detectedEncoding) || 'utf8';
  const getEncodingLabel = encoding => {
    switch (encoding) {
      case 'utf8': return 'UTF-8';
      case 'utf16le': return 'UTF-16 LE';
      case 'utf16be': return 'UTF-16 BE';
      case 'big5': return '繁體中文（Big5）';
      case 'cp950': return '繁體中文（CP950）';
      case 'gb18030': return '簡體中文（GB18030）';
      case 'shift_jis': return '日文（Shift_JIS）';
      case 'cp932': return '日文（CP932）';
      case 'euc-jp': return '日文（EUC-JP）';
      default: return String(encoding || '').toUpperCase();
    }
  };
  const getEncodingToggleLabel = encoding => encoding === 'auto'
    ? `自動偵測（${String(detectedEncoding || 'utf8').toUpperCase()}）`
    : getEncodingLabel(encoding);
  const encodingOptionsHtml = isTxt ? [
    `<option value="auto"${selectedEncoding === 'auto' ? ' selected' : ''}>自動偵測（${escapeXml(String(detectedEncoding || 'utf8').toUpperCase())}）</option>`,
    `<optgroup label="Unicode">`,
    ...['utf8', 'utf16le', 'utf16be'].map(encoding => `<option value="${escapeXml(encoding)}"${selectedEncoding === encoding ? ' selected' : ''}>${escapeXml(getEncodingLabel(encoding))}</option>`),
    `</optgroup>`,
    `<optgroup label="日文">`,
    ...['cp932', 'shift_jis', 'euc-jp'].map(encoding => `<option value="${escapeXml(encoding)}"${selectedEncoding === encoding ? ' selected' : ''}>${escapeXml(getEncodingLabel(encoding))}</option>`),
    `</optgroup>`,
    `<optgroup label="中文">`,
    ...['big5', 'cp950', 'gb18030'].map(encoding => `<option value="${escapeXml(encoding)}"${selectedEncoding === encoding ? ' selected' : ''}>${escapeXml(getEncodingLabel(encoding))}</option>`),
    `</optgroup>`
  ].join('') : '';
  const encodingMenuGroups = isTxt ? [
    {
      label: '',
      options: [
        { value: 'auto', label: getEncodingToggleLabel('auto') }
      ]
    },
    {
      label: 'Unicode',
      options: ['utf8', 'utf16le', 'utf16be'].map(encoding => ({ value: encoding, label: getEncodingLabel(encoding) }))
    },
    {
      label: '日文',
      options: ['cp932', 'shift_jis', 'euc-jp'].map(encoding => ({ value: encoding, label: getEncodingLabel(encoding) }))
    },
    {
      label: '中文',
      options: ['big5', 'cp950', 'gb18030'].map(encoding => ({ value: encoding, label: getEncodingLabel(encoding) }))
    }
  ] : [];
  const encodingMenuHtml = isTxt ? encodingMenuGroups.map(group => `
    <div class="encoding-menu-group">
      ${group.options.map(option => `<button type="button" class="encoding-menu-item${selectedEncoding === option.value ? ' is-active' : ''}" data-encoding-value="${escapeXml(option.value)}">${escapeXml(option.label)}</button>`).join('')}
    </div>
  `).join('') : '';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  ${PREVIEW_NOTO_FONT_LINKS}
  <style>
    :root{--bg:#fff;--text:#222;--muted:#777;--line:#e8e8e8;--link:#2f6db5;--panel:#fbfbfb}
    html[data-theme="dark"]{--bg:#111118;--text:#ece7df;--muted:#9a958d;--line:#2a2a34;--link:#8fb6ff;--panel:#171720}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:var(--bg);color:var(--text)}
    body{font-family:${PREVIEW_SERIF_FONT_STACK};text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;transition:background .2s ease,color .2s ease}
    .page{width:min(100%,760px);margin:0 auto;padding:58px 24px 72px}
    .meta{margin-bottom:18px}
    .meta-head{display:flex;align-items:stretch;justify-content:space-between;gap:24px}
    .meta-main{flex:1;min-width:0}
    .meta-side{display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;gap:18px}
    .title-wrap{flex:1;min-width:0}
    .title{margin:0;font-size:28px;line-height:1.32;font-weight:700;letter-spacing:.01em}
    .filename-input{width:100%;margin:0;padding:0;border:none;background:transparent;color:var(--text);font:inherit;font-size:28px;line-height:1.32;font-weight:700;letter-spacing:.01em;outline:none}
    .meta-times{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:18px;font-size:15px;color:var(--muted)}
    .meta-times time,.meta-times #metaLabelWrap,.meta-times #metaLabelText,.meta-times #updatedByWrap,.meta-times #updatedByText{display:inline;white-space:nowrap}
    .meta-dot{width:3px;height:3px;border-radius:999px;background:currentColor;opacity:.55}
    .actions{display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
    .icon-btn{width:30px;height:30px;border:none;background:transparent;color:var(--muted);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
    .icon-btn:hover{color:var(--text)}
    .icon{width:18px;height:18px;display:block}
    .action-btn{border:none;background:transparent;color:var(--muted);padding:0 2px;font:inherit;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;height:30px;line-height:1}
    .action-btn:hover{color:var(--text)}
    .action-btn:disabled{opacity:.55;cursor:default}
    .encoding-field{display:flex;align-items:center;gap:10px;margin:2px 0 10px}
    .encoding-field label{font-size:15px;line-height:1.9;color:var(--muted);white-space:nowrap}
    .encoding-menu-wrap{position:relative;display:inline-block;width:156px;max-width:100%}
    .encoding-toggle{display:inline-flex;align-items:center;gap:5px;width:100%;max-width:100%;border:none;background:transparent;color:var(--muted);padding:0;font:inherit;font-size:15px;line-height:1.35;text-align:left;cursor:pointer}
    .encoding-toggle:hover,.encoding-toggle[aria-expanded="true"]{color:var(--text)}
    .encoding-toggle-caret{display:inline-block;font-size:11px;line-height:1;transform:translateY(1px) rotate(0deg);transition:transform .22s ease;order:-1}
    .encoding-toggle[aria-expanded="true"] .encoding-toggle-caret{transform:translateY(1px) rotate(180deg)}
    .encoding-select{position:absolute;pointer-events:none;opacity:0;width:1px;height:1px;inset:auto}
    .encoding-menu{position:fixed;top:0;left:0;width:var(--encoding-menu-width,160px);padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 18px 48px rgba(0,0,0,.18);z-index:140;opacity:0;transform:translateY(-6px);transform-origin:top left;max-height:0;overflow:hidden;pointer-events:none;transition:opacity .2s ease,transform .22s ease,max-height .22s ease,padding-top .22s ease,padding-bottom .22s ease,border-color .22s ease}
    .encoding-menu.is-open{opacity:1;transform:translateY(0);max-height:520px;pointer-events:auto}
    .encoding-menu-group + .encoding-menu-group{margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
    .encoding-menu-item{display:block;width:100%;border:none;background:transparent;color:var(--muted);padding:4px 0;font:inherit;font-size:12px;line-height:1.35;text-align:left;cursor:pointer}
    .encoding-menu-item:hover,.encoding-menu-item.is-active{color:var(--text)}
    .article{font-size:16px;line-height:1.92;letter-spacing:.01em;word-break:break-word}
    .article-body,.editor{margin:0;white-space:pre-wrap;word-break:break-word;line-height:1.92;font-size:16px;font-family:inherit;letter-spacing:.01em}
    .txt-body{display:grid;gap:1.15em}
    .txt-block{position:relative;white-space:pre-wrap;word-break:break-word;scroll-margin-top:28px}
    .txt-block-empty{min-height:1.92em}
    .txt-block-anchor{display:block;position:relative;top:-12px;visibility:hidden}
    .editor{display:block;width:100%;min-height:0;border:none;outline:none;resize:none;overflow:hidden;background:transparent;color:inherit;padding:0}
    .status{min-height:22px;margin-top:20px;color:var(--muted);font-size:14px}
    .status[data-state="error"]{color:#a33d2d}
    .status[data-state="success"]{color:#2d7a54}
    .modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:60}
    .modal.on{display:flex}
    .modal-bg{position:absolute;inset:0;background:rgba(0,0,0,.65)}
    .modal-card{position:relative;z-index:1;width:min(92vw,420px);max-height:calc(100dvh - 32px);overflow:auto;background:var(--bg);border:1px solid var(--line);padding:20px 22px;border-radius:18px}
    .modal-card h3{margin:0 0 10px;font-size:20px;line-height:1.35;color:var(--text)}
    .modal-card p{margin:0;color:var(--muted);font-size:14px;line-height:1.7}
    .floating-modal{display:none;pointer-events:none;align-items:stretch;justify-content:stretch}
    .floating-modal.on{display:block}
    .floating-modal .modal-bg{display:none}
    .floating-window{position:fixed;top:96px;right:40px;left:auto;transform:none;z-index:80;width:min(88vw,280px);border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:0 18px 48px rgba(0,0,0,.18);pointer-events:auto;overflow:visible}
    .floating-window.dragging{user-select:none}
    .window-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line);cursor:move;background:var(--panel)}
    .window-head h3{margin:0;font-size:16px;line-height:1.3}
    .window-close{border:none;background:transparent;color:var(--muted);font:inherit;font-size:20px;line-height:1;cursor:pointer;padding:0 2px}
    .window-close:hover{color:var(--text)}
    .window-body{padding:14px 16px 16px}
    .format-modal-card{width:min(88vw,260px)}
    .format-grid{display:grid;grid-template-columns:max-content;gap:10px;margin-top:6px;justify-content:start}
    .toc-window{width:min(88vw,320px)}
    .toc-list{display:grid;gap:6px;max-height:min(62dvh,520px);overflow:auto;padding-right:2px}
    .toc-entry{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;border:none;background:transparent;color:var(--text);text-align:left;padding:2px 0;cursor:grab;transition:color .18s ease,opacity .18s ease}
    .toc-entry:hover .toc-entry-title,.toc-entry.is-active .toc-entry-title{color:var(--link)}
    .toc-entry.dragging{opacity:.45}
    .toc-entry-main{min-width:0;text-align:left}
    .toc-entry-title{display:block;font-size:14px;line-height:1.6;word-break:break-word}
    .toc-entry-actions{display:flex;align-items:center;gap:4px;opacity:.72}
    .toc-entry:hover .toc-entry-actions,.toc-entry.is-active .toc-entry-actions{opacity:1}
    .toc-entry-actions button{border:none;background:transparent;color:var(--muted);padding:2px 4px;font:inherit;font-size:12px;line-height:1.2;cursor:pointer}
    .toc-entry-actions button:hover{color:var(--text)}
    .toc-entry-actions .toc-delete-btn:hover{color:#a33d2d}
    .toc-empty{color:var(--muted);font-size:14px;line-height:1.7}
    .format-action-btn{display:inline-block;justify-self:start;align-self:start;width:auto;min-height:auto;padding:0;border:none;background:transparent;color:var(--muted);font:inherit;font-size:15px;line-height:1.9;text-align:left;cursor:pointer;transition:color .18s ease}
    .format-action-btn:hover{color:var(--text);background:transparent}
    .format-action-btn-wide{grid-column:1 / -1}
    .modal-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:18px}
    .modal-actions button{border:1px solid var(--line);background:transparent;color:var(--text);border-radius:999px;padding:8px 14px;font:inherit;cursor:pointer}
    .confirm-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:18px}
    .confirm-actions button{border:1px solid var(--line);background:transparent;color:var(--text);border-radius:999px;padding:8px 14px;font:inherit;cursor:pointer}
    .confirm-actions .confirm-danger{background:var(--text);border-color:var(--text);color:var(--bg)}
    .confirm-actions .confirm-danger:hover{opacity:.92}
    .find-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;flex-wrap:nowrap}
    .find-actions button{min-width:0;padding:8px 10px;font-size:14px;white-space:nowrap}
    .find-grid{display:grid;gap:12px;margin-top:18px}
    .find-grid label{display:grid;gap:6px;font-size:14px;color:var(--muted)}
    .find-grid input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);font:inherit;outline:none}
    .find-grid input:focus{border-color:var(--link)}
    .history-modal-card{width:min(96vw,1080px)}
    .history-detail-modal-card{width:min(96vw,1080px);padding:0;overflow:hidden}
    .history-layout{display:grid;grid-template-columns:260px minmax(0,1fr);gap:16px;margin-top:18px;align-items:start}
    .history-list{border:1px solid var(--line);border-radius:16px;padding:8px;background:var(--panel);overflow:auto;max-height:min(64dvh,520px)}
    .history-entry{width:100%;border:none;background:transparent;color:var(--text);text-align:left;padding:12px 10px;border-radius:12px;cursor:pointer}
    .history-entry:hover,.history-entry.active{background:rgba(127,127,127,.12)}
    .history-entry small{display:block;color:var(--muted);margin-top:4px}
    .history-view{display:grid;gap:12px}
    .history-detail-shell{display:flex;flex-direction:column;max-height:calc(100dvh - 32px);background:var(--bg)}
    .history-detail-topbar{display:flex;align-items:center;gap:12px;padding:16px 18px;background:#050505;color:#fff}
    .history-detail-topbar h3{margin:0;font-size:20px;line-height:1.35;color:inherit}
    .history-back-btn{border:none;background:transparent;color:inherit;font:inherit;font-size:30px;line-height:1;cursor:pointer;padding:0 4px}
    .history-detail-body{flex:1;overflow:auto;padding:18px;background:var(--bg)}
    .history-detail-footer{padding:16px 18px 18px;border-top:1px solid var(--line);background:var(--bg)}
    .history-restore-btn{display:block;width:100%;border:none;border-radius:10px;padding:15px 18px;background:#2f95e8;color:#fff;font:inherit;font-size:15px;cursor:pointer;box-shadow:0 10px 24px rgba(47,149,232,.22)}
    .history-restore-btn:disabled{opacity:.55;cursor:default;box-shadow:none}
    .history-meta{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center}
    .history-meta strong{font-size:16px}
    .history-record-pane{border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden}
    .history-inline-view{display:grid;gap:12px}
    .history-compare-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
    .history-compare-pane{display:grid}
    .history-pane-title{padding:10px 14px;border-bottom:1px solid var(--line);font-size:14px;color:var(--muted)}
    .diff-pane{border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden}
    .diff-head{padding:10px 14px;border-bottom:1px solid var(--line);font-size:14px;color:var(--muted)}
    .diff-body{max-height:min(52dvh,460px);overflow:auto;padding:12px 14px;font-family:"Cascadia Mono","Consolas","Courier New",monospace;font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
    .history-record-body{max-height:none;min-height:min(52dvh,460px);padding:18px 18px 22px;font-family:inherit;font-size:16px;line-height:1.92;white-space:pre-wrap;word-break:break-word;color:var(--text)}
    .diff-line{display:block;padding:1px 4px;border-radius:6px}
    .diff-line-with-sign{display:grid;grid-template-columns:24px minmax(0,1fr);align-items:start;column-gap:8px}
    .diff-sign{display:inline-block;font-weight:700;color:var(--muted);text-align:center;line-height:1.92}
    .diff-line-with-sign .diff-mark,.diff-line-with-sign .diff-plain{display:block}
    .diff-plain{display:block}
    .diff-compare{display:grid;gap:8px}
    .diff-compare-current{display:grid;grid-template-columns:24px minmax(0,1fr);column-gap:8px;align-items:start;color:var(--muted)}
    .diff-compare-label{display:inline-block;text-align:center;line-height:1.92}
    .diff-mark{background:rgba(255,215,0,.22);border-radius:5px;padding:0 1px}
    .diff-empty{color:var(--muted)}
    .history-ellipsis{display:block;padding:8px 4px;color:var(--muted);font-size:28px;line-height:1;letter-spacing:.18em}
    .divider{height:1px;background:var(--line);margin:0 0 36px}
    .footer{margin-top:44px;padding-top:14px;border-top:1px solid var(--line);font-size:14px;color:var(--muted);text-align:center}
    .article blockquote{margin:1.8em 0;padding-left:18px;border-left:3px solid #d7d7d7;color:#444}
    html[data-theme="dark"] .article blockquote{border-left-color:#8f8679;color:#d2cbc2}
    .article a{color:var(--link);text-decoration:none}
    .article a:hover{text-decoration:underline}
    @media (max-width: 720px){.history-layout{grid-template-columns:minmax(0,1fr)}.history-inline-view{display:none}.history-detail-modal{align-items:stretch;justify-content:stretch}.history-detail-modal .modal-bg{display:none}.history-detail-modal-card{width:100vw;max-height:100dvh;border:none;border-radius:0}.history-detail-shell{max-height:100dvh}.history-detail-topbar{padding:18px 18px 16px}.history-detail-body{padding:16px 16px 24px}.history-detail-footer{padding:14px 16px calc(18px + env(safe-area-inset-bottom))}.history-meta{display:grid;gap:6px;align-items:start}.history-record-body{padding:16px 16px 20px;font-size:16px;line-height:1.88}}
    @media (max-width: 720px){.page{padding:40px 20px 48px}.meta-head{gap:12px;flex-direction:column}.meta-side{width:100%;align-items:flex-start;gap:12px}.actions{width:100%;justify-content:flex-start}.encoding-field{flex-wrap:wrap;align-items:flex-start}.encoding-toggle,.encoding-menu-item{font-size:12px}.filename-input,.title,.article,.article-body,.editor{font-size:16px;line-height:1.88}.format-grid{grid-template-columns:max-content}.format-action-btn-wide{grid-column:auto}}
  </style>
  <script>
    (() => {
      const mode = localStorage.getItem('theme-mode') === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = mode;
      document.addEventListener('DOMContentLoaded', () => { document.body.dataset.theme = mode; });
    })();
  </script>
</head>
<body>
  <main class="page">
    <header class="meta">
      <div class="meta-head">
        <div class="meta-main">
          <div class="title-wrap">
            ${isTxt && canEditTxt ? `<input id="filenameInput" class="filename-input" type="text" value="${filenameValue}" spellcheck="false" aria-label="TXT 檔名">` : `<h1 class="title">${pageTitle}</h1>`}
          </div>
          ${metaHtml}
        </div>
        <div class="meta-side">
          <div class="actions">
            ${isTxt && canEditTxt ? `<button type="button" class="action-btn" id="redoBtn" title="重做（Ctrl+Shift+Z）" style="display:none">重做</button>` : ''}
            ${isTxt && canEditTxt ? `<button type="button" class="action-btn" id="undoBtn" title="復原（Ctrl+Z）" style="display:none">復原</button>` : ''}
            ${isTxt && canEditTxt ? `<span id="historySlot"></span>` : ''}
            ${isTxt && !canEditTxt ? `<button type="button" class="action-btn" id="tocBtn" title="目錄">目錄</button>` : ''}
            ${isTxt && canEditTxt ? `<button type="button" class="action-btn" id="formatBtn" title="格式化排版">格式化</button>` : ''}
            ${isTxt && canEditTxt ? `<button type="button" class="action-btn" id="saveBtn" title="儲存目前變更">儲存</button>` : ''}
            <button class="icon-btn" id="theme-btn" type="button" aria-label="切換顯示模式" title="切換顯示模式"></button>
          </div>
        </div>
      </div>
    </header>
    <div class="divider" aria-hidden="true"></div>
    <article class="article">
      ${isTxt ? (canEditTxt ? `<textarea id="editor" class="editor" spellcheck="false">${rawBody}</textarea><div class="status" id="saveStatus" aria-live="polite"></div>` : `<div class="article-body txt-body" id="txtBody">${txtReadOnlyBlocksHtml || displayBody}</div>`) : `<pre class="article-body">${displayBody}</pre>`}
    </article>
    <div class="footer">${canEditTxt ? 'Editable preview.' : 'Read-only preview.'}</div>
  </main>
  ${isTxt ? `<div class="modal floating-modal" id="tocModal" aria-hidden="true"><div class="modal-bg" id="tocModalBg"></div><section class="floating-window toc-window" id="tocWindow" role="dialog" aria-labelledby="tocModalTitle"><div class="window-head" id="tocDragHandle"><h3 id="tocModalTitle">目錄</h3><button type="button" class="window-close" id="tocCloseBtn" aria-label="關閉">×</button></div><div class="window-body"><div id="tocEmpty" class="toc-empty" style="display:none">目前沒有可跳轉的目錄項目。</div><div id="tocList" class="toc-list"></div><div class="modal-actions" style="margin-top:14px"><button type="button" id="tocClearBtn">清空</button><button type="button" id="tocRefreshBtn">重新掃描</button>${canEditTxt ? `<button type="button" id="tocAddBtn">新增目前段落</button>` : ''}</div></div></section></div>` : ''}
  ${isTxt && canEditTxt ? `<div class="modal floating-modal" id="formatModal" aria-hidden="true"><div class="modal-bg" id="formatModalBg"></div><section class="floating-window format-modal-card" id="formatWindow" role="dialog" aria-labelledby="formatModalTitle"><div class="window-head" id="formatDragHandle"><h3 id="formatModalTitle">格式化排版</h3><button type="button" class="window-close" id="formatCloseBtn" aria-label="關閉">×</button></div><div class="window-body"><div class="encoding-field"><label for="encodingToggleBtn">切換編碼</label><div class="encoding-menu-wrap"><button type="button" id="encodingToggleBtn" class="encoding-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="encodingMenu"><span id="encodingToggleLabel">${escapeXml(getEncodingToggleLabel(selectedEncoding))}</span><span class="encoding-toggle-caret" aria-hidden="true">▾</span></button><select id="encodingSelect" class="encoding-select" aria-label="TXT 編碼" tabindex="-1">${encodingOptionsHtml}</select><div id="encodingMenu" class="encoding-menu" role="menu">${encodingMenuHtml}</div></div></div><div class="format-grid"><button type="button" class="format-action-btn format-action-btn-wide" data-action="open_toc">目錄</button><button type="button" class="format-action-btn format-action-btn-wide" data-action="find_replace">尋找與取代</button><button type="button" class="format-action-btn" data-action="indent_add">插入段首縮排</button><button type="button" class="format-action-btn" data-action="indent_remove">去除段首縮排</button><button type="button" class="format-action-btn" data-action="keep_blank_line">在段落與段落間保留一個空行</button><button type="button" class="format-action-btn" data-action="trim_blank_lines">去除段落與段落間所有的空行</button><button type="button" class="format-action-btn" data-action="punct_fullwidth">半形符號轉全形符號</button><button type="button" class="format-action-btn" data-action="cn_to_twp">简体中文 轉 繁體中文</button><button type="button" class="format-action-btn" data-action="t_to_cn">繁體中文 轉 简体中文</button><button type="button" class="format-action-btn" data-action="cjk_spacing">在中英文之間插入空白</button></div></div></section></div>` : ''}
  ${isTxt && canEditTxt ? `<div class="modal floating-modal" id="findReplaceModal" aria-hidden="true"><div class="modal-bg" id="findReplaceModalBg"></div><section class="floating-window" id="findReplaceWindow" role="dialog" aria-labelledby="findReplaceTitle"><div class="window-head" id="findDragHandle"><h3 id="findReplaceTitle">尋找與取代</h3><button type="button" class="window-close" id="findReplaceCloseBtn" aria-label="關閉">×</button></div><div class="window-body"><div class="find-grid"><label>尋找<input id="findInput" type="text" autocomplete="off" spellcheck="false"></label><label>取代成<input id="replaceInput" type="text" autocomplete="off" spellcheck="false"></label></div><p id="findSummary" class="diff-empty" style="margin:10px 0 0">請先輸入要尋找的文字。</p><div class="modal-actions find-actions"><button type="button" id="findNextBtn">下一筆</button><button type="button" id="replaceOneBtn">取代</button><button type="button" id="replaceAllBtn">全取代</button></div></div></section></div>` : ''}
  ${isTxt && canEditTxt ? `<div class="modal" id="historyModal" aria-hidden="true"><div class="modal-bg" id="historyModalBg"></div><div class="modal-card history-modal-card" role="dialog" aria-modal="true" aria-labelledby="historyModalTitle"><h3 id="historyModalTitle">編輯記錄</h3><p>桌機可直接查看版本記錄；手機點擊版本後會開啟詳情。</p><div class="history-layout"><div class="history-list" id="historyList"></div><div class="history-inline-view"><div class="history-meta"><strong id="historyInlineVersionTitle">尚未選擇版本</strong><span id="historyInlineVersionMeta" class="diff-empty"></span></div><div class="history-compare-grid"><section class="history-record-pane history-compare-pane"><div class="history-pane-title">版本記錄</div><div class="history-record-body" id="historyInlineVersionDiff"></div></section><section class="history-record-pane history-compare-pane"><div class="history-pane-title">目前內文</div><div class="history-record-body" id="historyInlineCurrentDiff"></div></section></div><div class="modal-actions" style="margin-top:0"><button type="button" id="historyInlineRestoreBtn">還原到此版本</button></div></div></div><div class="modal-actions"><button type="button" id="historyClearBtn">清空編輯記錄</button><button type="button" id="historyCloseBtn">關閉</button></div></div></div>` : ''}
  ${isTxt && canEditTxt ? `<div class="modal history-detail-modal" id="historyDetailModal" aria-hidden="true"><div class="modal-bg" id="historyDetailModalBg"></div><div class="modal-card history-detail-modal-card" role="dialog" aria-modal="true" aria-labelledby="historyDetailModalTitle"><div class="history-detail-shell"><div class="history-detail-topbar"><button type="button" class="history-back-btn" id="historyDetailCloseBtn" aria-label="返回">←</button><h3 id="historyDetailModalTitle">歷史詳情</h3></div><div class="history-detail-body"><div class="history-view"><div class="history-meta"><strong id="historyVersionTitle">尚未選擇版本</strong><span id="historyVersionMeta" class="diff-empty"></span></div><section class="history-record-pane"><div class="diff-head">版本記錄</div><div class="history-record-body" id="historyVersionDiff"></div></section></div></div><div class="history-detail-footer"><button type="button" class="history-restore-btn" id="historyRestoreBtn">還原到此版本</button></div></div></div></div>` : ''}
  ${isTxt && canEditTxt ? `<div class="modal" id="historyClearConfirmModal" aria-hidden="true"><div class="modal-bg" id="historyClearConfirmModalBg"></div><div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="historyClearConfirmTitle"><h3 id="historyClearConfirmTitle">清空編輯記錄</h3><p>確定要清空這份 TXT 的全部編輯記錄嗎？</p><div class="confirm-actions"><button type="button" id="historyClearCancelBtn">取消</button><button type="button" class="confirm-danger" id="historyClearConfirmBtn">確定</button></div></div></div>` : ''}
  ${isTxt && canEditTxt ? `<div class="modal" id="leaveModal" aria-hidden="true"><div class="modal-bg" id="leaveModalBg"></div><div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="leaveModalTitle"><h3 id="leaveModalTitle">尚未儲存變更</h3><p>這份 TXT 還有尚未儲存的內容。若現在離開，本次修改可能不會保留。</p><div class="modal-actions"><button type="button" id="leaveStayBtn">留在此頁</button><button type="button" id="leaveConfirmBtn">仍要離開</button></div></div></div>` : ''}
  <script>
    const themeIcon = kind => kind === 'moon'
      ? '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>'
      : '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3"/></svg>';
    function applyTheme(theme){const mode=theme==='light'?'light':'dark';document.documentElement.dataset.theme=mode;document.body.dataset.theme=mode;localStorage.setItem('theme-mode',mode);const btn=document.getElementById('theme-btn');if(btn)btn.innerHTML=mode==='light'?themeIcon('moon'):themeIcon('sun');}
    function toggleTheme(){const next=(document.body.dataset.theme||'dark')==='light'?'dark':'light';applyTheme(next);}
    document.getElementById('theme-btn')?.addEventListener('click',toggleTheme);
    applyTheme(localStorage.getItem('theme-mode')==='dark'?'dark':'light');
  </script>
  ${isTxt && canEditTxt ? `<script src="/vendor/opencc-js/full.js"></script>` : ''}
  ${scrollMemoryScript}
  ${isTxt ? `<script>(()=>{const tocBtn=document.getElementById('tocBtn'),tocModal=document.getElementById('tocModal'),tocModalBg=document.getElementById('tocModalBg'),tocCloseBtn=document.getElementById('tocCloseBtn'),tocList=document.getElementById('tocList'),tocEmpty=document.getElementById('tocEmpty'),tocRefreshBtn=document.getElementById('tocRefreshBtn'),tocClearBtn=document.getElementById('tocClearBtn'),tocAddBtn=document.getElementById('tocAddBtn'),tocWindow=document.getElementById('tocWindow'),tocDragHandle=document.getElementById('tocDragHandle'),editor=document.getElementById('editor'),txtBody=document.getElementById('txtBody');const tocStorageKey='preview-toc:'+location.pathname+'?'+location.search;let tocEntries=[],activeTocEntryId='',manualTocEntries=[],tocOrderIds=[],draggedTocEntryId='';function normalizeTocText(text){return String(text||'').replace(/\\r\\n/g,'\\n').replace(/\\r/g,'\\n');}function buildRawTocEntries(text){const normalized=normalizeTocText(text);const lines=normalized.split('\\n');const entries=[];let offset=0,start=-1,entryLines=[],end=-1;function pushEntry(){if(start<0||!entryLines.length)return;const firstLine=(entryLines.find(line=>line.trim())||'').replace(/\\s+/g,' ').trim();entries.push({sourceIndex:entries.length,start,end,label:firstLine||('第 '+(entries.length+1)+' 段'),lineCount:entryLines.length,text:entryLines.join('\\n')});start=-1;entryLines=[];end=-1;}for(let idx=0;idx<lines.length;idx+=1){const line=lines[idx],lineStart=offset,hasBreak=idx<lines.length-1;offset+=line.length+(hasBreak?1:0);if(line.trim()){if(start<0)start=lineStart;entryLines.push(line);end=offset-(hasBreak?1:0);continue;}pushEntry();}pushEntry();return entries;}function isExcludedLabel(label){const text=String(label||'').trim();if(!text)return true;if(/^[【《「〔\\(（][^【《「〔\\(（\\]】》」〕\\)）]*[】》」〕\\)）]$/.test(text))return true;if(/^[\\s　]*[【《「〔\\(（]/.test(text))return true;return false;}function isSceneLikeLabel(label){const text=String(label||'').trim();if(!text||isExcludedLabel(text))return false;const solidSymRe=/^[\\s　]*[■□●○◆◇★☆▲△▼▽▶▷◀◁◉◈◦•※✦✧✩✪✫✬✭✮✯✰◐◑◒◓◔◕⬛⬜🔲🔳▪▫◎〇]/u;const dateRe=/\\d{1,2}[\\s　]*[月\\/\\-.]\\s*\\d{1,2}|\\d{4}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{1,2}|星期[一二三四五六七日天]|週[一二三四五六日天]|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon\\.?|Tue\\.?|Wed\\.?|Thu\\.?|Fri\\.?|Sat\\.?|Sun\\.?|(?:^|\\s)(?:[AP]M)(?:\\s|$)|午前|午後|深夜|早朝|夜明け/iu;return solidSymRe.test(text)||dateRe.test(text);}function buildAutoTocEntries(text){const rawEntries=buildRawTocEntries(text);const strictEntries=rawEntries.filter(entry=>isSceneLikeLabel(entry.label));const fallbackEntries=rawEntries.filter(entry=>entry.label.replace(/[\\s　]/g,'').length>=1);const picked=(strictEntries.length?strictEntries:fallbackEntries).filter(entry=>!isExcludedLabel(entry.label)||!strictEntries.length);return picked.map(entry=>({...entry,id:'auto-'+entry.sourceIndex,kind:'auto'}));}function getSourceText(){if(editor)return editor.value||'';if(txtBody)return Array.from(txtBody.querySelectorAll('[data-block-index]')).map(node=>node.textContent||'').join('\\n\\n');return '';}function getRawEntries(){return buildRawTocEntries(getSourceText());}function findEntryByPosition(position){const rawEntries=getRawEntries();return rawEntries.find(entry=>position>=entry.start&&position<=entry.end)||rawEntries.find(entry=>position<entry.start)||rawEntries[rawEntries.length-1]||null;}function measureEditorCaret(position){if(!editor)return null;const style=window.getComputedStyle(editor);const mirror=document.createElement('div');mirror.style.position='absolute';mirror.style.visibility='hidden';mirror.style.pointerEvents='none';mirror.style.inset='0 auto auto -999999px';mirror.style.whiteSpace='pre-wrap';mirror.style.wordBreak='break-word';mirror.style.overflowWrap='break-word';mirror.style.boxSizing=style.boxSizing;mirror.style.width=editor.getBoundingClientRect().width+'px';mirror.style.padding=style.padding;mirror.style.border=style.border;mirror.style.font=style.font;mirror.style.lineHeight=style.lineHeight;mirror.style.letterSpacing=style.letterSpacing;mirror.style.tabSize=style.tabSize||'8';mirror.style.textIndent=style.textIndent;mirror.style.textTransform=style.textTransform;mirror.style.fontKerning=style.fontKerning;mirror.style.fontVariantLigatures=style.fontVariantLigatures;mirror.style.fontFeatureSettings=style.fontFeatureSettings;mirror.textContent=(editor.value||'').slice(0,Math.max(0,position));const marker=document.createElement('span');marker.textContent='\\u200b';mirror.appendChild(marker);document.body.appendChild(mirror);const top=marker.offsetTop;const height=marker.offsetHeight||(parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.8||28);mirror.remove();return Number.isFinite(top)?{top,height}:null;}function getCurrentContextEntry(){if(editor)return findEntryByPosition(editor.selectionStart??0);const visibleBlock=Array.from(txtBody?.querySelectorAll('[data-block-index]')||[]).find(node=>{const rect=node.getBoundingClientRect();return rect.top<=window.innerHeight*0.35&&rect.bottom>=window.innerHeight*0.2;});if(visibleBlock){const sourceIndex=Number(visibleBlock.getAttribute('data-block-index'));const rawEntries=getRawEntries();return rawEntries.find(entry=>entry.sourceIndex===sourceIndex)||rawEntries[0]||null;}return getRawEntries()[0]||null;}function clipLabel(label){return label.length>34?label.slice(0,34)+'…':label;}function persistTocState(){try{localStorage.setItem(tocStorageKey,JSON.stringify({manualTocEntries,activeTocEntryId,tocOrderIds}))}catch{}}function restoreTocState(){try{const raw=localStorage.getItem(tocStorageKey);if(!raw)return;const parsed=JSON.parse(raw);manualTocEntries=Array.isArray(parsed?.manualTocEntries)?parsed.manualTocEntries.filter(entry=>entry&&typeof entry.label==='string').map(entry=>({id:String(entry.id||('manual-'+Date.now())),kind:'manual',label:String(entry.label||'未命名項目'),start:Number(entry.start||0),end:Number(entry.end||0),sourceIndex:Number(entry.sourceIndex||0),lineCount:Number(entry.lineCount||1),text:String(entry.text||'')})):[];activeTocEntryId=typeof parsed?.activeTocEntryId==='string'?parsed.activeTocEntryId:'';tocOrderIds=Array.isArray(parsed?.tocOrderIds)?parsed.tocOrderIds.map(id=>String(id||'')).filter(Boolean):[];}catch{manualTocEntries=[];activeTocEntryId='';tocOrderIds=[];}}function setActiveTocEntry(entryId){activeTocEntryId=typeof entryId==='string'?entryId:'';tocList?.querySelectorAll('[data-toc-id]').forEach(btn=>btn.classList.toggle('is-active',btn.dataset.tocId===activeTocEntryId));persistTocState();}function renameTocEntry(entryId){const entry=tocEntries.find(item=>item.id===entryId);if(!entry)return;const nextLabel=(window.prompt('重新命名目錄：',entry.label||'')||'').trim();if(!nextLabel)return;entry.label=nextLabel;if(entry.kind==='manual'){const manual=manualTocEntries.find(item=>item.id===entryId);if(manual)manual.label=nextLabel;}renderToc();setActiveTocEntry(entryId);persistTocState();}function deleteTocEntry(entryId){const entry=tocEntries.find(item=>item.id===entryId);if(!entry)return;if(!window.confirm('要刪除這個目錄項目嗎？'))return;if(entry.kind==='manual'){manualTocEntries=manualTocEntries.filter(item=>item.id!==entryId);}else{manualTocEntries.push({...entry,id:'hidden-'+entry.id,kind:'hidden',label:entry.label});}tocOrderIds=tocOrderIds.filter(id=>id!==entryId);rebuildToc();}function isHiddenAutoEntry(entry){return manualTocEntries.some(item=>item.kind==='hidden'&&item.id==='hidden-'+entry.id);}function syncTocOrder(){const validIds=tocEntries.map(entry=>entry.id);tocOrderIds=tocOrderIds.filter(id=>validIds.includes(id));validIds.forEach(id=>{if(!tocOrderIds.includes(id))tocOrderIds.push(id);});const orderMap=new Map(tocOrderIds.map((id,index)=>[id,index]));tocEntries.sort((left,right)=>(orderMap.get(left.id)??Number.MAX_SAFE_INTEGER)-(orderMap.get(right.id)??Number.MAX_SAFE_INTEGER));}function moveTocEntry(dragId,targetId){if(!dragId||!targetId||dragId===targetId)return;const nextOrder=tocOrderIds.filter(id=>id!==dragId);const targetIndex=nextOrder.indexOf(targetId);if(targetIndex<0)return;nextOrder.splice(targetIndex,0,dragId);tocOrderIds=nextOrder;rebuildToc(false);}function renderToc(){if(!tocList||!tocEmpty)return;tocEmpty.style.display=tocEntries.length?'none':'block';tocList.innerHTML=tocEntries.map(entry=>'<div class=\"toc-entry'+(entry.id===activeTocEntryId?' is-active':'')+'\" data-toc-id=\"'+escapeHtml(entry.id)+'\" draggable=\"true\"><button type=\"button\" class=\"toc-entry-main\" data-role=\"jump\"><span class=\"toc-entry-title\">'+escapeHtml(clipLabel(entry.label))+'</span></button><div class=\"toc-entry-actions\"><button type=\"button\" data-role=\"rename\">改名</button><button type=\"button\" class=\"toc-delete-btn\" data-role=\"delete\">刪除</button></div></div>').join('');tocList.querySelectorAll('[data-toc-id]').forEach(row=>{const entryId=row.getAttribute('data-toc-id')||'';row.querySelector('[data-role=\"jump\"]')?.addEventListener('click',()=>navigateToTocEntry(entryId));row.querySelector('[data-role=\"rename\"]')?.addEventListener('click',event=>{event.stopPropagation();renameTocEntry(entryId)});row.querySelector('[data-role=\"delete\"]')?.addEventListener('click',event=>{event.stopPropagation();deleteTocEntry(entryId)});row.addEventListener('dragstart',event=>{draggedTocEntryId=entryId;row.classList.add('dragging');if(event.dataTransfer){event.dataTransfer.effectAllowed='move';try{event.dataTransfer.setData('text/plain',entryId)}catch{}}});row.addEventListener('dragend',()=>{draggedTocEntryId='';row.classList.remove('dragging')});row.addEventListener('dragover',event=>{if(!draggedTocEntryId||draggedTocEntryId===entryId)return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';});row.addEventListener('drop',event=>{if(!draggedTocEntryId||draggedTocEntryId===entryId)return;event.preventDefault();moveTocEntry(draggedTocEntryId,entryId);});});}function openToc(){if(!tocModal)return;tocModal.classList.add('on');tocModal.setAttribute('aria-hidden','false');tocCloseBtn?.focus();}function closeToc(){if(!tocModal)return;tocModal.classList.remove('on');tocModal.setAttribute('aria-hidden','true');}function scrollEditorPositionIntoView(position){if(!editor)return;const metrics=measureEditorCaret(position);if(!metrics)return;const rect=editor.getBoundingClientRect();const pageTarget=window.scrollY+rect.top+metrics.top-window.innerHeight*0.32;const maxPageScroll=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);window.scrollTo({top:Math.max(0,Math.min(pageTarget,maxPageScroll)),behavior:'smooth'});}function centerEditorSelection(position){scrollEditorPositionIntoView(position);}function finalizeManualTocChange(entryId){syncTocOrder();renderToc();if(tocBtn)tocBtn.style.display=tocEntries.length?'inline-flex':'none';if(entryId)activeTocEntryId=entryId;setActiveTocEntry(activeTocEntryId);}function navigateToTocEntry(entryId){const entry=tocEntries.find(item=>item.id===entryId);if(!entry)return;setActiveTocEntry(entry.id);if(editor){editor.focus();editor.setSelectionRange(entry.start,entry.start,'forward');centerEditorSelection(entry.start);}else{const target=document.getElementById('txt-block-'+entry.sourceIndex)||document.querySelector('[data-block-index=\"'+entry.sourceIndex+'\"]');target?.scrollIntoView({behavior:'smooth',block:'start'});}}function rebuildToc(includeAuto=true){const keptManuals=manualTocEntries.filter(entry=>entry.kind==='manual');const autoEntries=includeAuto?buildAutoTocEntries(getSourceText()).filter(entry=>!isHiddenAutoEntry(entry)):tocEntries.filter(entry=>entry.kind==='auto'&&!isHiddenAutoEntry(entry));tocEntries=[...keptManuals,...autoEntries];syncTocOrder();if(!tocEntries.some(entry=>entry.id===activeTocEntryId))activeTocEntryId=tocEntries[0]?.id||'';renderToc();if(tocBtn)tocBtn.style.display=tocEntries.length?'inline-flex':'none';persistTocState();}function addManualTocEntry(){const baseEntry=getCurrentContextEntry();if(!baseEntry){window.alert('目前找不到可加入的段落。');return;}const suggested=baseEntry.label||'未命名段落';const label=(window.prompt('新增目錄名稱：',suggested)||'').trim();if(!label)return;const newId='manual-'+Date.now()+'-'+manualTocEntries.length;const manualEntry={...baseEntry,id:newId,kind:'manual',label,lineCount:baseEntry.lineCount||1};manualTocEntries.push(manualEntry);tocEntries.push(manualEntry);tocOrderIds.push(newId);finalizeManualTocChange(newId);}function clearAllTocEntries(){if(!tocEntries.length){window.alert('目前沒有可清空的目錄項目。');return;}if(!window.confirm('確定要清空所有目錄項目嗎？'))return;const autoEntries=buildAutoTocEntries(getSourceText());manualTocEntries=[...autoEntries.map(entry=>({...entry,id:'hidden-'+entry.id,kind:'hidden',label:entry.label})).filter(entry=>entry.id),];activeTocEntryId='';tocOrderIds=[];rebuildToc();}function makeWindowDraggable(windowEl,handleEl){if(!windowEl||!handleEl)return;let drag=null;const onMove=event=>{if(!drag)return;const nextLeft=Math.min(Math.max(12,event.clientX-drag.offsetX),window.innerWidth-windowEl.offsetWidth-12);const nextTop=Math.min(Math.max(12,event.clientY-drag.offsetY),window.innerHeight-windowEl.offsetHeight-12);windowEl.style.left=nextLeft+'px';windowEl.style.top=nextTop+'px';windowEl.style.right='auto';windowEl.classList.add('dragging');};const onUp=()=>{drag=null;windowEl.classList.remove('dragging');window.removeEventListener('pointermove',onMove);window.removeEventListener('pointerup',onUp);};handleEl.addEventListener('pointerdown',event=>{if(event.target.closest('button'))return;const rect=windowEl.getBoundingClientRect();drag={offsetX:event.clientX-rect.left,offsetY:event.clientY-rect.top};windowEl.style.left=rect.left+'px';windowEl.style.top=rect.top+'px';windowEl.style.right='auto';window.addEventListener('pointermove',onMove);window.addEventListener('pointerup',onUp);});}tocBtn?.addEventListener('click',openToc);tocModalBg?.addEventListener('click',closeToc);tocCloseBtn?.addEventListener('click',closeToc);tocRefreshBtn?.addEventListener('click',()=>rebuildToc());tocClearBtn?.addEventListener('click',clearAllTocEntries);tocAddBtn?.addEventListener('click',addManualTocEntry);document.addEventListener('keydown',event=>{const key=event.key.toLowerCase();if(event.key==='Escape'&&tocModal?.classList.contains('on')){event.preventDefault();closeToc();return;}if(event.ctrlKey&&!event.shiftKey&&!event.altKey&&!event.metaKey&&key==='j'&&tocEntries.length){event.preventDefault();if(tocModal?.classList.contains('on'))closeToc();else openToc();return;}});makeWindowDraggable(tocWindow,tocDragHandle);if(txtBody&&'IntersectionObserver'in window){const observer=new IntersectionObserver(entries=>{const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(!visible)return;const sourceIndex=Number(visible.target.getAttribute('data-block-index'));const matched=tocEntries.find(entry=>entry.sourceIndex===sourceIndex&&entry.kind==='auto')||tocEntries.find(entry=>entry.sourceIndex===sourceIndex&&entry.kind==='manual');if(matched)setActiveTocEntry(matched.id);},{root:null,rootMargin:'-20% 0px -60% 0px',threshold:[0.15,0.35,0.55]});txtBody.querySelectorAll('[data-block-index]').forEach(node=>observer.observe(node));}restoreTocState();window.refreshTxtToc=()=>{};window.scrollTxtEditorPositionIntoView=scrollEditorPositionIntoView;rebuildToc();})();</script>` : ''}
  ${isTxt ? `<script>(()=>{const previewEditor=document.getElementById('editor');const previewFilenameInput=document.getElementById('filenameInput');if(previewEditor)previewEditor.value=previewEditor.defaultValue;if(previewFilenameInput)previewFilenameInput.value=previewFilenameInput.defaultValue;window.resizeEditor=function(){if(!previewEditor)return;const pageX=window.scrollX;const pageY=window.scrollY;const selectionStart=previewEditor.selectionStart;const selectionEnd=previewEditor.selectionEnd;previewEditor.style.height='auto';previewEditor.style.height=previewEditor.scrollHeight+'px';if(typeof selectionStart==='number'&&typeof selectionEnd==='number'){previewEditor.selectionStart=selectionStart;previewEditor.selectionEnd=selectionEnd;}window.scrollTo(pageX,pageY);requestAnimationFrame(()=>window.scrollTo(pageX,pageY));};window.resizeEditor();window.addEventListener('load',window.resizeEditor);window.addEventListener('resize',window.resizeEditor);previewEditor?.addEventListener('input',()=>window.resizeEditor());})();</script>` : ''}
  ${isTxt && canEditTxt ? `<script>
    const INDENT='\\u3000\\u3000',AUTOSAVE_MS=300000,UNDO_GROUP_IDLE_MS=900,editor=document.getElementById('editor'),formatBtn=document.getElementById('formatBtn'),undoBtn=document.getElementById('undoBtn'),redoBtn=document.getElementById('redoBtn'),historySlot=document.getElementById('historySlot'),formatModal=document.getElementById('formatModal'),formatModalBg=document.getElementById('formatModalBg'),formatWindow=document.getElementById('formatWindow'),formatDragHandle=document.getElementById('formatDragHandle'),formatCloseBtn=document.getElementById('formatCloseBtn'),formatActionBtns=Array.from(document.querySelectorAll('.format-action-btn')),tocModal=document.getElementById('tocModal'),tocCloseBtn=document.getElementById('tocCloseBtn'),findReplaceModal=document.getElementById('findReplaceModal'),findReplaceModalBg=document.getElementById('findReplaceModalBg'),findReplaceWindow=document.getElementById('findReplaceWindow'),findDragHandle=document.getElementById('findDragHandle'),findReplaceCloseBtn=document.getElementById('findReplaceCloseBtn'),findInput=document.getElementById('findInput'),replaceInput=document.getElementById('replaceInput'),findSummary=document.getElementById('findSummary'),findNextBtn=document.getElementById('findNextBtn'),replaceOneBtn=document.getElementById('replaceOneBtn'),replaceAllBtn=document.getElementById('replaceAllBtn'),historyModal=document.getElementById('historyModal'),historyModalBg=document.getElementById('historyModalBg'),historyCloseBtn=document.getElementById('historyCloseBtn'),historyClearBtn=document.getElementById('historyClearBtn'),historyDetailModal=document.getElementById('historyDetailModal'),historyDetailModalBg=document.getElementById('historyDetailModalBg'),historyDetailCloseBtn=document.getElementById('historyDetailCloseBtn'),historyRestoreBtn=document.getElementById('historyRestoreBtn'),historyInlineRestoreBtn=document.getElementById('historyInlineRestoreBtn'),historyList=document.getElementById('historyList'),historyVersionTitle=document.getElementById('historyVersionTitle'),historyVersionMeta=document.getElementById('historyVersionMeta'),historyVersionDiff=document.getElementById('historyVersionDiff'),historyInlineVersionTitle=document.getElementById('historyInlineVersionTitle'),historyInlineVersionMeta=document.getElementById('historyInlineVersionMeta'),historyInlineVersionDiff=document.getElementById('historyInlineVersionDiff'),historyInlineCurrentDiff=document.getElementById('historyInlineCurrentDiff'),historyClearConfirmModal=document.getElementById('historyClearConfirmModal'),historyClearConfirmModalBg=document.getElementById('historyClearConfirmModalBg'),historyClearCancelBtn=document.getElementById('historyClearCancelBtn'),historyClearConfirmBtn=document.getElementById('historyClearConfirmBtn'),filenameInput=document.getElementById('filenameInput'),saveBtn=document.getElementById('saveBtn'),status=document.getElementById('saveStatus'),encodingSelect=document.getElementById('encodingSelect'),encodingToggleBtn=document.getElementById('encodingToggleBtn'),encodingToggleLabel=document.getElementById('encodingToggleLabel'),encodingMenu=document.getElementById('encodingMenu'),encodingMenuItems=Array.from(document.querySelectorAll('[data-encoding-value]')),saveUrlRaw=${JSON.stringify(options.saveUrl || '')},saveUrl=saveUrlRaw?new URL(saveUrlRaw,window.location.origin).toString():'',historyUrlRaw=${JSON.stringify(options.historyUrl || '')},historyUrl=historyUrlRaw?new URL(historyUrlRaw,window.location.origin).toString():'',txtReloadUrlRaw=${JSON.stringify(options.txtReloadUrl || '')},txtReloadUrl=txtReloadUrlRaw?new URL(txtReloadUrlRaw,window.location.origin).toString():'',leaveModal=document.getElementById('leaveModal'),leaveModalBg=document.getElementById('leaveModalBg'),leaveStayBtn=document.getElementById('leaveStayBtn'),leaveConfirmBtn=document.getElementById('leaveConfirmBtn'),openccReady=typeof OpenCC!=='undefined'&&typeof OpenCC.Converter==='function',cnToTwp=openccReady?OpenCC.Converter({from:'cn',to:'twp'}):null,tToCn=openccReady?OpenCC.Converter({from:'t',to:'cn'}):null;let currentEncoding=${JSON.stringify(selectedEncoding)},lastSavedText=editor?editor.value:'',lastSavedFilename=filenameInput?filenameInput.value:'',allowLeave=false,leaveViaHistory=false,saveInFlight=false,suspendTracking=false,selectedHistoryId='',historyVersions=[],undoStack=[],redoStack=[],pendingInputState=null,inputGroupState=null,inputGroupTarget='',inputGroupTimer=0,isComposing=false,historyClearConfirmResolve=null;
    function setStatusMessage(message,state=''){if(!status)return;status.dataset.state=state;status.textContent=message||'';}
    function normalizeLineEndings(text){return String(text||'').replace(/\\r\\n/g,'\\n').replace(/\\r/g,'\\n');}
    function snapshotState(){return{text:editor?editor.value:'',filename:filenameInput?filenameInput.value:''};}
    function statesEqual(a,b){return(a?.text||'')===(b?.text||'')&&(a?.filename||'')===(b?.filename||'');}
    function hasUnsavedChanges(){return (!!editor&&editor.value!==lastSavedText)||(!!filenameInput&&filenameInput.value!==lastSavedFilename);}
    function syncDirtyState(){if(!status||status.dataset.state==='error')return;if(hasUnsavedChanges())setStatusMessage('尚有未儲存的變更。');else if(status.textContent==='尚有未儲存的變更。')setStatusMessage('');}
    function updateRedoVisibility(){if(!redoBtn)return;redoBtn.style.display=redoStack.length?'inline-flex':'none';}
    function updateUndoButtons(){if(undoBtn){const canUndo=undoStack.length>0;const keepUndoVisible=canUndo||redoStack.length>0;undoBtn.disabled=!canUndo;undoBtn.style.display=keepUndoVisible?'inline-flex':'none';}updateRedoVisibility();}
    function rememberUndoState(previousState){if(!previousState||statesEqual(previousState,snapshotState()))return;const top=undoStack.length?undoStack[undoStack.length-1]:null;if(top&&statesEqual(top,previousState))return;undoStack.push(previousState);if(undoStack.length>200)undoStack.shift();redoStack=[];updateUndoButtons();}
    function clearInputGroupTimer(){if(inputGroupTimer){window.clearTimeout(inputGroupTimer);inputGroupTimer=0;}}
    function commitPendingInputGroup(){clearInputGroupTimer();if(!inputGroupState)return;rememberUndoState(inputGroupState);inputGroupState=null;inputGroupTarget='';}
    function getFieldKey(target){if(target===filenameInput)return'filename';return'editor';}
    function isGroupedInputType(inputType){return /^(insertText|insertCompositionText|insertFromComposition|deleteContentBackward|deleteContentForward|deleteByCut|deleteByDrag)$/.test(String(inputType||''));}
    function beginInputGroup(target){const fieldKey=getFieldKey(target);if(inputGroupState&&inputGroupTarget!==fieldKey)commitPendingInputGroup();if(!inputGroupState){inputGroupState=snapshotState();inputGroupTarget=fieldKey;}}
    function scheduleInputGroupCommit(){clearInputGroupTimer();inputGroupTimer=window.setTimeout(()=>{if(isComposing)return;commitPendingInputGroup();},UNDO_GROUP_IDLE_MS);}
    function applyState(state,{focusEditor=true}={}){clearInputGroupTimer();inputGroupState=null;inputGroupTarget='';pendingInputState=null;suspendTracking=true;if(editor)editor.value=state?.text||'';if(filenameInput)filenameInput.value=state?.filename||'';resizeEditor();suspendTracking=false;syncDirtyState();updateUndoButtons();updateFindSummary();if(focusEditor)editor?.focus();}
    function applyTrackedState(nextState,successMessage,unchangedMessage='目前內容沒有變化。'){commitPendingInputGroup();const before=snapshotState();if(statesEqual(before,nextState)){setStatusMessage(unchangedMessage);return false;}rememberUndoState(before);applyState(nextState);setStatusMessage(successMessage,'success');return true;}
    function handleFieldBeforeInput(event){if(suspendTracking)return;if(event?.inputType==='historyUndo'||event?.inputType==='historyRedo')return;if(isComposing||event?.isComposing||isGroupedInputType(event?.inputType)){beginInputGroup(event?.target||editor);scheduleInputGroupCommit();pendingInputState=null;return;}commitPendingInputGroup();pendingInputState=snapshotState();}
    function handleEditorInput(){if(suspendTracking)return;const current=snapshotState();if(!isComposing&&pendingInputState&&!statesEqual(pendingInputState,current))rememberUndoState(pendingInputState);pendingInputState=null;if(inputGroupState)scheduleInputGroupCommit();resizeEditor();syncDirtyState();updateUndoButtons();updateFindSummary();}
    function handleFilenameInput(){if(suspendTracking)return;const current=snapshotState();if(!isComposing&&pendingInputState&&!statesEqual(pendingInputState,current))rememberUndoState(pendingInputState);pendingInputState=null;if(inputGroupState)scheduleInputGroupCommit();syncDirtyState();updateUndoButtons();}
    function handleCompositionStart(event){if(suspendTracking)return;isComposing=true;beginInputGroup(event?.target||editor);clearInputGroupTimer();}
    function handleCompositionEnd(){isComposing=false;scheduleInputGroupCommit();}
    function undoAction(){commitPendingInputGroup();if(!undoStack.length)return;pendingInputState=null;const current=snapshotState();const previous=undoStack.pop();redoStack.push(current);applyState(previous);setStatusMessage('已復原。','success');}
    function redoAction(){commitPendingInputGroup();if(!redoStack.length)return;pendingInputState=null;const current=snapshotState();const next=redoStack.pop();undoStack.push(current);applyState(next);setStatusMessage('已重做。','success');}
    function formatParagraphIndent(text){return normalizeLineEndings(text).split('\\n').map(line=>{if(!line.trim())return line;return line.startsWith(INDENT)?line:INDENT+line;}).join('\\n');}
    function stripParagraphIndent(text){return normalizeLineEndings(text).replace(/(^|\\n)\\u3000\\u3000/g,'$1');}
    function keepSingleBlankLineBetweenParagraphs(text){const lines=normalizeLineEndings(text).split('\\n');const cleaned=[];for(const line of lines){if(!line.trim()){if(cleaned.length&&cleaned[cleaned.length-1]!=='')cleaned.push('');continue;}cleaned.push(line);}const output=[];for(let i=0;i<cleaned.length;i+=1){const line=cleaned[i];output.push(line);if(line!==''&&i<cleaned.length-1&&cleaned[i+1]!=='')output.push('');}return output.join('\\n');}
    function trimExtraBlankLines(text){return normalizeLineEndings(text).split('\\n').filter(line=>line.trim()).join('\\n');}
    function addCjkSpacing(text){let next=normalizeLineEndings(text);next=next.replace(/([\\p{Script=Han}])([A-Za-z0-9@#&%+\\-=*_\\/\\\\|]+)/gu,'$1 $2');next=next.replace(/([A-Za-z0-9@#&%+\\-=*_\\/\\\\|]+)([\\p{Script=Han}])/gu,'$1 $2');return next.replace(/ {2,}/g,' ');}
    function halfwidthPunctuationToFullwidth(text){return Array.from(normalizeLineEndings(text)).map(ch=>{const code=ch.charCodeAt(0);if(code>=0x21&&code<=0x7E&&!/[A-Za-z0-9]/.test(ch))return String.fromCharCode(code+0xFEE0);return ch;}).join('');}
    function openModal(modal){if(!modal)return;modal.classList.add('on');modal.setAttribute('aria-hidden','false');}
    function closeModal(modal){if(!modal)return;modal.classList.remove('on');modal.setAttribute('aria-hidden','true');}
    function makeFloatingWindowDraggable(windowEl,handleEl){if(!windowEl||!handleEl)return;let drag=null;const onMove=event=>{if(!drag)return;const nextLeft=Math.min(Math.max(12,event.clientX-drag.offsetX),window.innerWidth-windowEl.offsetWidth-12);const nextTop=Math.min(Math.max(12,event.clientY-drag.offsetY),window.innerHeight-windowEl.offsetHeight-12);windowEl.style.left=nextLeft+'px';windowEl.style.top=nextTop+'px';windowEl.style.right='auto';windowEl.classList.add('dragging');};const onUp=()=>{drag=null;windowEl.classList.remove('dragging');window.removeEventListener('pointermove',onMove);window.removeEventListener('pointerup',onUp);};handleEl.addEventListener('pointerdown',event=>{if(event.target.closest('button'))return;const rect=windowEl.getBoundingClientRect();drag={offsetX:event.clientX-rect.left,offsetY:event.clientY-rect.top};windowEl.style.left=rect.left+'px';windowEl.style.top=rect.top+'px';windowEl.style.right='auto';window.addEventListener('pointermove',onMove);window.addEventListener('pointerup',onUp);});}
    function closeFormatModal(){closeEncodingMenu();closeModal(formatModal);}
    function openFormatModal(){openModal(formatModal);formatCloseBtn?.focus();}
    function getEncodingDisplayLabel(value){return value==='auto'?'自動偵測（'+String(${JSON.stringify(String(detectedEncoding || 'utf8').toUpperCase())})+'）':String(encodingSelect?.querySelector('option[value="'+CSS.escape(value)+'"]')?.textContent||value);}
    function syncEncodingMenuState(value){if(encodingSelect)encodingSelect.value=value;if(encodingToggleLabel)encodingToggleLabel.textContent=getEncodingDisplayLabel(value);encodingMenuItems.forEach(item=>item.classList.toggle('is-active',(item.dataset.encodingValue||'')===value));}
    function positionEncodingMenu(){if(!encodingMenu||!encodingToggleBtn)return;const rect=encodingToggleBtn.getBoundingClientRect();const menuWidth=Math.ceil(rect.width);encodingMenu.style.setProperty('--encoding-menu-width',menuWidth+'px');encodingMenu.style.left=Math.round(rect.left)+'px';encodingMenu.style.top=Math.round(rect.bottom+6)+'px';}
    function closeEncodingMenu(){if(encodingMenu)encodingMenu.classList.remove('is-open');if(encodingToggleBtn)encodingToggleBtn.setAttribute('aria-expanded','false');}
    function openEncodingMenu(){if(!encodingMenu||!encodingToggleBtn)return;positionEncodingMenu();encodingMenu.classList.add('is-open');encodingToggleBtn.setAttribute('aria-expanded','true');}
    function toggleEncodingMenu(){if(encodingMenu?.classList.contains('is-open'))closeEncodingMenu();else openEncodingMenu();}
    function closeFindReplaceModal(){closeModal(findReplaceModal);}
    function openFindReplaceModal(){openModal(findReplaceModal);updateFindSummary();setTimeout(()=>findInput?.focus(),0);findInput?.select();}
    function closeHistoryModal(){closeModal(historyModal);}
    function closeHistoryDetailModal(){closeModal(historyDetailModal);}
    function isMobileHistoryLayout(){return window.matchMedia('(max-width: 720px)').matches;}
    function closeHistoryClearConfirm(result=false){closeModal(historyClearConfirmModal);const resolve=historyClearConfirmResolve;historyClearConfirmResolve=null;if(typeof resolve==='function')resolve(!!result);}
    function openHistoryClearConfirm(){if(!historyClearConfirmModal)return Promise.resolve(false);openModal(historyClearConfirmModal);setTimeout(()=>historyClearCancelBtn?.focus(),0);return new Promise(resolve=>{historyClearConfirmResolve=resolve;});}
    async function openHistoryModal(){await loadHistoryVersions();if(!historyVersions.length)return;openModal(historyModal);historyCloseBtn?.focus();}
    function renderHistoryButton(){if(!historySlot)return;if(!historyVersions.length){historySlot.innerHTML='';return;}historySlot.innerHTML='<button type="button" class="action-btn" id="historyBtn" title="編輯記錄">編輯記錄</button>';document.getElementById('historyBtn')?.addEventListener('click',openHistoryModal);}
    function escapeHtml(value){return String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
    function formatHistoryMode(mode){return mode==='auto'?'自動儲存':'手動儲存';}
    function getHistorySavedAtLabel(version){return String(version?.savedAtLabel||version?.savedAt||'');}
    function countMatches(text,needle){if(!needle)return 0;let count=0,start=0;while(true){const idx=String(text||'').indexOf(needle,start);if(idx<0)break;count+=1;start=idx+Math.max(needle.length,1);}return count;}
    function getMatchOrdinal(text,needle,index){if(!needle||index<0)return 0;let count=0,start=0;while(true){const idx=String(text||'').indexOf(needle,start);if(idx<0||idx>index)break;count+=1;if(idx===index)break;start=idx+Math.max(needle.length,1);}return count;}
    function updateFindSummary(activeIndex=-1){if(!findSummary)return;const needle=String(findInput?.value||'');if(!needle){findSummary.textContent='請先輸入要尋找的文字。';return;}const total=countMatches(editor?.value||'',needle);if(!total){findSummary.textContent='目前找不到符合結果。';return;}if(activeIndex>=0){findSummary.innerHTML='共 '+total+' 筆符合結果，<br>目前選到第 '+getMatchOrdinal(editor?.value||'',needle,activeIndex)+' 筆。';return;}findSummary.textContent='共 '+total+' 筆符合結果。';}
    function centerSelectionInEditor(index){if(!editor)return;if(typeof window.scrollTxtEditorPositionIntoView==='function'){window.scrollTxtEditorPositionIntoView(index);return;}const textBefore=(editor.value||'').slice(0,Math.max(0,index));const style=window.getComputedStyle(editor);const lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.8||28;const lineCount=textBefore.split('\\n').length-1;const lineOffset=lineCount*lineHeight;const rect=editor.getBoundingClientRect();const pageTarget=window.scrollY+rect.top+lineOffset-window.innerHeight/2+lineHeight;const maxPageScroll=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);window.scrollTo({top:Math.max(0,Math.min(pageTarget,maxPageScroll)),behavior:'smooth'});}
    function splitHistoryParagraphs(text){return normalizeLineEndings(text).split('\\n').map(line=>String(line??''));}
    function splitHistoryBlocks(text){const lines=normalizeLineEndings(text).split('\\n').map(line=>String(line??''));const blocks=[];let current=[];const flush=()=>{if(!current.length)return;blocks.push(current.join('\\n'));current=[];};for(const line of lines){if(String(line).trim()){current.push(line);continue;}flush();}flush();return blocks;}
    function splitHistoryCompareBlocks(text){return normalizeLineEndings(text).split('\\n').map(line=>String(line??'')).filter(line=>String(line).trim());}
    function buildLcsMatchedIndices(left,right){const rows=Array.from({length:left.length+1},()=>Array(right.length+1).fill(0));for(let i=left.length-1;i>=0;i-=1){for(let j=right.length-1;j>=0;j-=1){rows[i][j]=left[i]===right[j]?rows[i+1][j+1]+1:Math.max(rows[i+1][j],rows[i][j+1]);}}const leftMatched=new Set(),rightMatched=new Set(),pairs=[];let i=0,j=0;while(i<left.length&&j<right.length){if(left[i]===right[j]){leftMatched.add(i);rightMatched.add(j);pairs.push([i,j]);i+=1;j+=1;continue;}if(rows[i+1][j]>=rows[i][j+1])i+=1;else j+=1;}return{leftMatched,rightMatched,pairs};}
    function isSubsequenceText(shorter,longer){let pointer=0;for(const ch of String(longer||'')){if(pointer<String(shorter||'').length&&ch===String(shorter||'')[pointer])pointer+=1;}return pointer===String(shorter||'').length;}
    function getHistoryBlockChangeSign(sourceBlock,targetBlock){const source=String(sourceBlock||'');const target=String(targetBlock||'');if(!source||!target)return'';if(source===target)return'';if(source.length<target.length&&isSubsequenceText(source,target))return'-';if(source.length>target.length&&isSubsequenceText(target,source))return'+';return'';}
    function renderHistoryBlock(sourceBlock,sign='',compareBlock=''){const lines=String(sourceBlock??'').split('\\n');const diffHtml=(sign==='+'||sign==='-')?lines.map((line,index)=>'<span class="diff-line diff-line-with-sign"><span class="diff-sign">'+(index===0?sign:'')+'</span><mark class="diff-mark">'+escapeHtml(line||' ')+'</mark></span>').join(''):lines.map(line=>'<span class="diff-line"><mark class="diff-mark">'+escapeHtml(line||' ')+'</mark></span>').join('');const compareText=String(compareBlock||'').trim();if(!compareText)return diffHtml;return '<div class="diff-compare">'+diffHtml+'<div class="diff-compare-current"><span class="diff-compare-label">現</span><span class="diff-plain">'+escapeHtml(compareText)+'</span></div></div>';}
    function renderHighlightedHistoryHtml(sourceText,targetText){const left=splitHistoryCompareBlocks(sourceText);const right=splitHistoryCompareBlocks(targetText);const{leftMatched,rightMatched,pairs}=buildLcsMatchedIndices(left,right);const rightByLeft=new Map(pairs.map(([li,ri])=>[li,ri]));const pairLefts=pairs.map(([li])=>li);function findCompareBlock(leftIndex){let before=-1,after=-1;for(const pairLeft of pairLefts){if(pairLeft<leftIndex)before=pairLeft;if(pairLeft>leftIndex){after=pairLeft;break;}}const beforeRight=before>=0?(rightByLeft.get(before)??-1):-1;const afterRight=after>=0?(rightByLeft.get(after)??-1):-1;if(beforeRight>=0&&afterRight>=0&&afterRight-beforeRight===2)return right[beforeRight+1]||'';if(beforeRight>=0&&beforeRight+1<right.length&&!rightMatched.has(beforeRight+1))return right[beforeRight+1]||'';if(afterRight>0&&!rightMatched.has(afterRight-1))return right[afterRight-1]||'';for(let idx=0;idx<right.length;idx+=1){if(!rightMatched.has(idx))return right[idx]||'';}return'';}const parts=[];let collapsed=false;for(let idx=0;idx<left.length;idx+=1){if(leftMatched.has(idx)){if(!collapsed){parts.push('<span class="history-ellipsis">…</span>');collapsed=true;}continue;}collapsed=false;const compareBlock=findCompareBlock(idx);parts.push(renderHistoryBlock(left[idx],getHistoryBlockChangeSign(left[idx],compareBlock),compareBlock));}const html=parts.join('');return html.trim()?html:'<div class="diff-empty">沒有內容</div>';}
    function buildHistoryCompareContext(sourceText,targetText){const left=splitHistoryCompareBlocks(sourceText);const right=splitHistoryCompareBlocks(targetText);const{leftMatched,rightMatched,pairs}=buildLcsMatchedIndices(left,right);const leftVisible=new Set(),rightVisible=new Set();const rightByLeft=new Map(pairs.map(([li,ri])=>[li,ri]));const pairLefts=pairs.map(([li])=>li);function addWindow(set,length,center){if(length<=0||center<0)return;for(let pointer=Math.max(0,center-1);pointer<=Math.min(length-1,center+1);pointer+=1)set.add(pointer);}for(let idx=0;idx<left.length;idx+=1){if(leftMatched.has(idx))continue;addWindow(leftVisible,left.length,idx);let anchorRight=-1;if(pairLefts.length){let before=-1,after=-1;for(const leftIdx of pairLefts){if(leftIdx<idx)before=leftIdx;if(leftIdx>idx){after=leftIdx;break;}}if(before>=0&&after>=0){anchorRight=Math.max(0,Math.min(right.length-1,Math.round((rightByLeft.get(before)+rightByLeft.get(after))/2)));}else if(before>=0){anchorRight=Math.min(right.length-1,(rightByLeft.get(before)??0)+1);}else if(after>=0){anchorRight=Math.max(0,(rightByLeft.get(after)??0)-1);}}if(anchorRight<0&&right.length)anchorRight=0;addWindow(rightVisible,right.length,anchorRight);}for(let idx=0;idx<right.length;idx+=1){if(rightMatched.has(idx))continue;addWindow(rightVisible,right.length,idx);let anchorLeft=-1;if(pairs.length){let before=-1,after=-1;for(const[,rightIdx]of pairs){if(rightIdx<idx)before=rightIdx;if(rightIdx>idx){after=rightIdx;break;}}if(before>=0&&after>=0){const beforePair=pairs.find(([,ri])=>ri===before);const afterPair=pairs.find(([,ri])=>ri===after);anchorLeft=Math.max(0,Math.min(left.length-1,Math.round(((beforePair?.[0]??0)+(afterPair?.[0]??0))/2)));}else if(before>=0){const beforePair=pairs.find(([,ri])=>ri===before);anchorLeft=Math.min(left.length-1,(beforePair?.[0]??0)+1);}else if(after>=0){const afterPair=pairs.find(([,ri])=>ri===after);anchorLeft=Math.max(0,(afterPair?.[0]??0)-1);}}if(anchorLeft<0&&left.length)anchorLeft=0;addWindow(leftVisible,left.length,anchorLeft);}if(!leftVisible.size&&!rightVisible.size){return{leftHtml:'<div class="diff-empty">此版本與目前內文相同。</div>',rightHtml:'<div class="diff-empty">此版本與目前內文相同。</div>'};}function renderBlocks(blocks,visible,matched){const parts=[];let collapsed=false;for(let idx=0;idx<blocks.length;idx+=1){if(!visible.has(idx)){if(!collapsed){parts.push('<span class="history-ellipsis">…</span>');collapsed=true;}continue;}collapsed=false;const block=blocks[idx]||'';const highlighted=!matched.has(idx);parts.push(highlighted?'<span class="diff-line"><mark class="diff-mark">'+escapeHtml(block||' ')+'</mark></span>':'<span class="diff-line">'+escapeHtml(block||' ')+'</span>');}const html=parts.join('');return html.trim()?html:'<div class="diff-empty">沒有內容</div>';}return{leftHtml:renderBlocks(left,leftVisible,leftMatched),rightHtml:renderBlocks(right,rightVisible,rightMatched)};}
    function openHistoryDetail(versionId){selectedHistoryId=versionId||selectedHistoryId;renderHistoryList();renderHistoryDiff();if(isMobileHistoryLayout()){openModal(historyDetailModal);historyDetailCloseBtn?.focus();}}
    function renderHistoryList(){if(!historyList)return;historyList.innerHTML=historyVersions.map(version=>'<button type="button" class="history-entry'+(version.id===selectedHistoryId?' active':'')+'" data-history-id="'+escapeHtml(version.id)+'"><div>'+escapeHtml(version.filename||'未命名 TXT')+'</div><small>'+escapeHtml(getHistorySavedAtLabel(version))+' ・ '+escapeHtml(formatHistoryMode(version.mode))+(version.savedBy?' ・ '+escapeHtml(version.savedBy):'')+'</small></button>').join('');historyList.querySelectorAll('[data-history-id]').forEach(btn=>btn.addEventListener('click',()=>openHistoryDetail(btn.getAttribute('data-history-id')||'')));}
    function renderHistoryDiff(){const version=historyVersions.find(entry=>entry.id===selectedHistoryId)||historyVersions[historyVersions.length-1]||null;const emptyHtml='<div class="diff-empty">沒有可比較的編輯記錄。</div>';if(!version){if(historyVersionTitle)historyVersionTitle.textContent='尚未選擇版本';if(historyVersionMeta)historyVersionMeta.textContent='';if(historyVersionDiff)historyVersionDiff.innerHTML=emptyHtml;if(historyInlineVersionTitle)historyInlineVersionTitle.textContent='尚未選擇版本';if(historyInlineVersionMeta)historyInlineVersionMeta.textContent='';if(historyInlineVersionDiff)historyInlineVersionDiff.innerHTML=emptyHtml;if(historyInlineCurrentDiff)historyInlineCurrentDiff.innerHTML=emptyHtml;if(historyRestoreBtn)historyRestoreBtn.disabled=true;if(historyInlineRestoreBtn)historyInlineRestoreBtn.disabled=true;return;}selectedHistoryId=version.id;const metaText=[getHistorySavedAtLabel(version),formatHistoryMode(version.mode),version.savedBy||''].filter(Boolean).join(' ・ ');const mobileHtml=renderHighlightedHistoryHtml(version.text||'',editor?.value||'');const desktopCompare=buildHistoryCompareContext(version.text||'',editor?.value||'');if(historyVersionTitle)historyVersionTitle.textContent=version.filename||'未命名 TXT';if(historyVersionMeta)historyVersionMeta.textContent=metaText;if(historyVersionDiff)historyVersionDiff.innerHTML=mobileHtml;if(historyInlineVersionTitle)historyInlineVersionTitle.textContent=version.filename||'未命名 TXT';if(historyInlineVersionMeta)historyInlineVersionMeta.textContent=metaText;if(historyInlineVersionDiff)historyInlineVersionDiff.innerHTML=desktopCompare.leftHtml;if(historyInlineCurrentDiff)historyInlineCurrentDiff.innerHTML=desktopCompare.rightHtml;if(historyRestoreBtn)historyRestoreBtn.disabled=false;if(historyInlineRestoreBtn)historyInlineRestoreBtn.disabled=false;}
    async function loadHistoryVersions(){if(!historyUrl)return;try{const res=await fetch(historyUrl,{headers:{'Authorization':'Bearer '+(localStorage.getItem('adm-token')||'')}});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'讀取編輯記錄失敗');historyVersions=Array.isArray(data.versions)?data.versions:[];if(!historyVersions.some(entry=>entry.id===selectedHistoryId))selectedHistoryId=historyVersions.length?historyVersions[historyVersions.length-1].id:'';renderHistoryButton();renderHistoryList();renderHistoryDiff();}catch(err){setStatusMessage(err.message||'讀取編輯記錄失敗','error');}}
    async function clearHistoryVersions(){if(!historyUrl)return;const confirmed=await openHistoryClearConfirm();if(!confirmed)return;try{const res=await fetch(historyUrl,{method:'DELETE',headers:{'Authorization':'Bearer '+(localStorage.getItem('adm-token')||'')}});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'清空編輯記錄失敗');historyVersions=[];selectedHistoryId='';renderHistoryButton();closeHistoryDetailModal();closeHistoryModal();setStatusMessage('已清空編輯記錄。','success');}catch(err){setStatusMessage(err.message||'清空編輯記錄失敗','error');}}
    function restoreHistoryVersion(){const version=historyVersions.find(entry=>entry.id===selectedHistoryId);if(!version)return;applyTrackedState({text:version.text||'',filename:(version.filename||filenameInput?.value||'').replace(/\\.txt$/i,'')},'已還原選取的編輯記錄。','目前內容與選取版本相同。');renderHistoryDiff();}
    function runFormatAction(action){if(!editor)return;const value=editor.value||'';switch(action){case 'open_toc':tocModal?.classList.add('on');tocModal?.setAttribute('aria-hidden','false');tocCloseBtn?.focus();return;case 'keep_blank_line':applyTrackedState({text:keepSingleBlankLineBetweenParagraphs(value),filename:filenameInput?.value||''},'已在段落間保留一個空列。','段落間已經只保留一個空列。');return;case 'trim_blank_lines':applyTrackedState({text:trimExtraBlankLines(value),filename:filenameInput?.value||''},'已移除段落間所有空列。','目前段落間沒有空列。');return;case 'cjk_spacing':applyTrackedState({text:addCjkSpacing(value),filename:filenameInput?.value||''},'已在中英文之間補上空白。','目前不需要調整中英文空白。');return;case 'indent_add':applyTrackedState({text:formatParagraphIndent(value),filename:filenameInput?.value||''},'已在每一行行首插入兩個全形空格。','目前每一行都已有段首縮排。');return;case 'indent_remove':applyTrackedState({text:stripParagraphIndent(value),filename:filenameInput?.value||''},'已移除段首縮排。','目前沒有可移除的段首縮排。');return;case 'cn_to_twp':if(!cnToTwp){setStatusMessage('繁簡轉換元件尚未載入。','error');return;}applyTrackedState({text:cnToTwp(value),filename:filenameInput?.value||''},'已轉成繁體中文（台灣）。');return;case 't_to_cn':if(!tToCn){setStatusMessage('繁簡轉換元件尚未載入。','error');return;}applyTrackedState({text:tToCn(value),filename:filenameInput?.value||''},'已轉成簡體中文。');return;case 'punct_fullwidth':applyTrackedState({text:halfwidthPunctuationToFullwidth(value),filename:filenameInput?.value||''},'已將半形符號轉為全形符號。','目前沒有需要轉換的半形符號。');return;case 'find_replace':openFindReplaceModal();return;default:return;}}
    function findNextMatch(startIndex=null){if(!editor)return false;const needle=String(findInput?.value||'');if(!needle){updateFindSummary();setStatusMessage('請先輸入要尋找的文字。','error');return false;}const haystack=editor.value||'';const total=countMatches(haystack,needle);if(!total){updateFindSummary();setStatusMessage('找不到符合的文字。','error');return false;}const from=startIndex===null?(editor.selectionEnd??0):startIndex;let idx=haystack.indexOf(needle,from);if(idx<0&&from>0)idx=haystack.indexOf(needle,0);if(idx<0){updateFindSummary();setStatusMessage('找不到符合的文字。','error');return false;}const ordinal=getMatchOrdinal(haystack,needle,idx);editor.focus();editor.setSelectionRange(idx,idx+needle.length,'forward');requestAnimationFrame(()=>centerSelectionInEditor(idx));updateFindSummary(idx);setStatusMessage('已找到第 '+ordinal+' / '+total+' 筆。','success');return true;}
    function replaceCurrentMatch(){if(!editor)return false;const needle=String(findInput?.value||''),replacement=String(replaceInput?.value||'');if(!needle){updateFindSummary();setStatusMessage('請先輸入要尋找的文字。','error');return false;}const selected=editor.value.slice(editor.selectionStart??0,editor.selectionEnd??0);if(selected!==needle&&!findNextMatch(editor.selectionEnd??0))return false;const start=editor.selectionStart??0,end=editor.selectionEnd??start;commitPendingInputGroup();pendingInputState=null;rememberUndoState(snapshotState());editor.setRangeText(replacement,start,end,'end');resizeEditor();syncDirtyState();editor.focus();const remaining=countMatches(editor.value,needle);updateFindSummary();setStatusMessage('已取代 1 筆，剩餘 '+remaining+' 筆符合結果。','success');return true;}
    function replaceAllMatches(){if(!editor)return;const needle=String(findInput?.value||''),replacement=String(replaceInput?.value||'');if(!needle){updateFindSummary();setStatusMessage('請先輸入要尋找的文字。','error');return;}const total=countMatches(editor.value,needle);if(!total){updateFindSummary();setStatusMessage('找不到符合的文字。','error');return;}const changed=applyTrackedState({text:editor.value.split(needle).join(replacement),filename:filenameInput?.value||''},'已取代 '+total+' 筆結果。','目前沒有找到要取代的文字。');if(changed)window.alert('已取代'+total+'筆結果。');}
    function insertIndentAtCursor(event){if(!editor||event.key!=='Tab'||event.shiftKey||event.altKey||event.ctrlKey||event.metaKey)return false;event.preventDefault();commitPendingInputGroup();rememberUndoState(snapshotState());const start=editor.selectionStart??0,end=editor.selectionEnd??start;editor.setRangeText(INDENT,start,end,'end');resizeEditor();syncDirtyState();return true;}
    function continueIndentedParagraph(event){if(!editor||event.key!=='Enter'||event.shiftKey||event.altKey||event.ctrlKey||event.metaKey)return;if(event.isComposing||editor.readOnly)return;const start=editor.selectionStart??0,end=editor.selectionEnd??start;if(start!==end)return;const value=editor.value||'';const lineStart=value.lastIndexOf('\\n',Math.max(0,start-1))+1;const currentLine=value.slice(lineStart,start);if(!currentLine.startsWith(INDENT))return;event.preventDefault();commitPendingInputGroup();rememberUndoState(snapshotState());editor.setRangeText('\\n'+INDENT,start,end,'end');resizeEditor();syncDirtyState();}
    function closeLeaveModal(){closeModal(leaveModal);leaveViaHistory=false;}
    function showLeaveModal(viaHistory=false){leaveViaHistory=viaHistory;openModal(leaveModal);leaveStayBtn?.focus();}
    function confirmLeave(){allowLeave=true;closeLeaveModal();if(leaveViaHistory)history.back();else window.close();}
    function getSelectedEncoding(){return String(encodingSelect?.value||'auto');}
    function buildUrlWithEncoding(rawUrl,encodingValue){if(!rawUrl)return'';const url=new URL(rawUrl,window.location.origin);if(encodingValue&&encodingValue!=='auto')url.searchParams.set('encoding',encodingValue);else url.searchParams.delete('encoding');return url.toString();}
    async function refreshTxtWithEncoding(encodingValue){if(!txtReloadUrl||!editor)return false;const res=await fetch(buildUrlWithEncoding(txtReloadUrl,encodingValue),{cache:'no-store',headers:{'Authorization':'Bearer '+(localStorage.getItem('adm-token')||'')}});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'重新載入 TXT 失敗');commitPendingInputGroup();undoStack=[];redoStack=[];pendingInputState=null;inputGroupState=null;inputGroupTarget='';clearInputGroupTimer();suspendTracking=true;editor.value=typeof data.text==='string'?data.text:'';editor.defaultValue=editor.value;if(filenameInput&&typeof data.filename==='string'&&data.filename){const nextName=data.filename.replace(/\\.txt$/i,'');filenameInput.value=nextName;filenameInput.defaultValue=nextName;document.title=nextName;}suspendTracking=false;lastSavedText=editor.value;lastSavedFilename=filenameInput?filenameInput.value:'';currentEncoding=String(data.selectedEncoding||encodingValue||'auto');syncEncodingMenuState(currentEncoding);resizeEditor();updateUndoButtons();updateFindSummary();const updatedAtText=document.getElementById('updatedAtText');if(updatedAtText)updatedAtText.textContent=data.updatedAtLabel||'';const metaDotPrimary=document.getElementById('metaDotPrimary'),updatedByText=document.getElementById('updatedByText'),updatedByWrap=document.getElementById('updatedByWrap'),updatedDot=document.getElementById('updatedDot');if(updatedByText)updatedByText.textContent=data.updatedByLabel||'';if(metaDotPrimary)metaDotPrimary.style.display=data.updatedAtLabel?'':'none';if(updatedByWrap)updatedByWrap.style.display=data.updatedByLabel?'':'none';if(updatedDot)updatedDot.style.display=(data.updatedAtLabel&&data.updatedByLabel)?'':'none';const pageUrl=new URL(window.location.href);if(currentEncoding&&currentEncoding!=='auto')pageUrl.searchParams.set('encoding',currentEncoding);else pageUrl.searchParams.delete('encoding');window.history.replaceState({},'',pageUrl.toString());setStatusMessage('已切換為 '+(data.encoding||currentEncoding||'auto')+'。','success');syncDirtyState();return true;}
    async function handleEncodingChange(forcedEncoding=''){const nextEncoding=String(forcedEncoding||getSelectedEncoding()||'auto');if(nextEncoding===currentEncoding){syncEncodingMenuState(currentEncoding);return;}if(hasUnsavedChanges()&&!window.confirm('目前還有尚未儲存的內容，切換編碼會重新載入文字內容。要繼續嗎？')){syncEncodingMenuState(currentEncoding);return;}setStatusMessage('正在套用編碼…');try{await refreshTxtWithEncoding(nextEncoding);}catch(err){syncEncodingMenuState(currentEncoding);setStatusMessage(err.message||'切換編碼失敗','error');}}
    async function saveText(mode='manual'){if(!saveUrl||saveInFlight)return false;if(mode==='auto'&&!hasUnsavedChanges())return false;commitPendingInputGroup();saveInFlight=true;if(saveBtn)saveBtn.disabled=true;setStatusMessage(mode==='auto'?'自動儲存中…':'儲存中…');try{const res=await fetch(buildUrlWithEncoding(saveUrl,getSelectedEncoding()),{method:'PUT',headers:{'Content-Type':'application/json','Authorization':'Bearer '+(localStorage.getItem('adm-token')||'')} ,body:JSON.stringify({text:editor.value,filename:filenameInput?.value||'',saveMode:mode,encoding:getSelectedEncoding()})});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||'儲存失敗');if(filenameInput&&typeof data.filename==='string'&&data.filename){filenameInput.value=data.filename.replace(/\\.txt$/i,'');document.title=data.filename.replace(/\\.txt$/i,'');}lastSavedText=editor.value;lastSavedFilename=filenameInput?filenameInput.value:'';setStatusMessage(mode==='auto'?'已自動儲存。':'已儲存。','success');const updatedAtText=document.getElementById('updatedAtText');if(updatedAtText&&data.updatedAtLabel)updatedAtText.textContent=data.updatedAtLabel;const metaDotPrimary=document.getElementById('metaDotPrimary'),updatedByText=document.getElementById('updatedByText'),updatedByWrap=document.getElementById('updatedByWrap'),updatedDot=document.getElementById('updatedDot');if(updatedByText&&data.updatedByLabel)updatedByText.textContent=data.updatedByLabel;if(metaDotPrimary)metaDotPrimary.style.display=data.updatedAtLabel?'':'none';if(updatedByWrap)updatedByWrap.style.display=data.updatedByLabel?'':'none';if(updatedDot)updatedDot.style.display=(data.updatedAtLabel&&data.updatedByLabel)?'':'none';await loadHistoryVersions();syncDirtyState();return true;}catch(err){setStatusMessage(err.message||'儲存失敗','error');return false;}finally{saveInFlight=false;if(saveBtn)saveBtn.disabled=false;}}
    function handleBeforeUnload(event){if(allowLeave||!hasUnsavedChanges())return;event.preventDefault();event.returnValue='';}
    function handleUndoRedoKey(event){const key=event.key.toLowerCase();if(event.ctrlKey&&!event.shiftKey&&!event.altKey&&!event.metaKey&&key==='z'){event.preventDefault();undoAction();return true;}if(event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.metaKey&&key==='z'){event.preventDefault();redoAction();return true;}return false;}
    makeFloatingWindowDraggable(formatWindow,formatDragHandle);makeFloatingWindowDraggable(findReplaceWindow,findDragHandle);syncEncodingMenuState(currentEncoding);editor?.addEventListener('beforeinput',handleFieldBeforeInput);editor?.addEventListener('input',handleEditorInput);editor?.addEventListener('compositionstart',handleCompositionStart);editor?.addEventListener('compositionend',handleCompositionEnd);editor?.addEventListener('keydown',event=>{if(handleUndoRedoKey(event))return;if(insertIndentAtCursor(event))return;continueIndentedParagraph(event);});filenameInput?.addEventListener('beforeinput',handleFieldBeforeInput);filenameInput?.addEventListener('input',handleFilenameInput);filenameInput?.addEventListener('compositionstart',handleCompositionStart);filenameInput?.addEventListener('compositionend',handleCompositionEnd);filenameInput?.addEventListener('keydown',handleUndoRedoKey);encodingToggleBtn?.addEventListener('click',event=>{event.preventDefault();toggleEncodingMenu();});encodingMenuItems.forEach(item=>item.addEventListener('click',()=>{const nextEncoding=String(item.dataset.encodingValue||'auto');closeEncodingMenu();syncEncodingMenuState(nextEncoding);handleEncodingChange(nextEncoding);}));formatBtn?.addEventListener('click',openFormatModal);undoBtn?.addEventListener('click',undoAction);redoBtn?.addEventListener('click',redoAction);formatModalBg?.addEventListener('click',closeFormatModal);formatCloseBtn?.addEventListener('click',closeFormatModal);formatActionBtns.forEach(btn=>btn.addEventListener('click',()=>runFormatAction(btn.dataset.action||'')));findReplaceModalBg?.addEventListener('click',closeFindReplaceModal);findReplaceCloseBtn?.addEventListener('click',closeFindReplaceModal);findInput?.addEventListener('input',()=>updateFindSummary());findNextBtn?.addEventListener('click',()=>findNextMatch());replaceOneBtn?.addEventListener('click',replaceCurrentMatch);replaceAllBtn?.addEventListener('click',replaceAllMatches);historyModalBg?.addEventListener('click',closeHistoryModal);historyCloseBtn?.addEventListener('click',closeHistoryModal);historyClearBtn?.addEventListener('click',clearHistoryVersions);historyDetailModalBg?.addEventListener('click',closeHistoryDetailModal);historyDetailCloseBtn?.addEventListener('click',closeHistoryDetailModal);historyRestoreBtn?.addEventListener('click',restoreHistoryVersion);historyInlineRestoreBtn?.addEventListener('click',restoreHistoryVersion);historyClearConfirmModalBg?.addEventListener('click',()=>closeHistoryClearConfirm(false));historyClearCancelBtn?.addEventListener('click',()=>closeHistoryClearConfirm(false));historyClearConfirmBtn?.addEventListener('click',()=>closeHistoryClearConfirm(true));saveBtn?.addEventListener('click',()=>saveText('manual'));leaveModalBg?.addEventListener('click',closeLeaveModal);leaveStayBtn?.addEventListener('click',closeLeaveModal);leaveConfirmBtn?.addEventListener('click',confirmLeave);window.addEventListener('resize',()=>{if(encodingMenu?.classList.contains('is-open'))positionEncodingMenu();});window.addEventListener('scroll',()=>{if(encodingMenu?.classList.contains('is-open'))positionEncodingMenu();},{passive:true});
    document.addEventListener('click',event=>{if(!encodingMenu||!encodingToggleBtn)return;if(encodingMenu.contains(event.target)||encodingToggleBtn.contains(event.target))return;closeEncodingMenu();});
    document.addEventListener('keydown',event=>{const key=event.key.toLowerCase();if(event.ctrlKey&&!event.shiftKey&&!event.altKey&&!event.metaKey&&key==='m'){event.preventDefault();if(formatModal?.classList.contains('on'))closeFormatModal();else openFormatModal();return;}if(event.ctrlKey&&!event.shiftKey&&!event.altKey&&!event.metaKey&&key==='h'){event.preventDefault();if(findReplaceModal?.classList.contains('on'))closeFindReplaceModal();else openFindReplaceModal();return;}if(event.ctrlKey&&!event.shiftKey&&!event.altKey&&!event.metaKey&&key==='s'){event.preventDefault();saveText('manual');return;}if(event.ctrlKey&&!event.shiftKey&&!event.altKey&&!event.metaKey&&key==='z'){event.preventDefault();undoAction();return;}if(event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.metaKey&&key==='z'){event.preventDefault();redoAction();return;}if(event.key==='Escape'&&encodingMenu?.classList.contains('is-open')){event.preventDefault();closeEncodingMenu();return;}if(event.key==='Escape'&&historyClearConfirmModal?.classList.contains('on')){event.preventDefault();closeHistoryClearConfirm(false);return;}if(event.key==='Escape'&&historyDetailModal?.classList.contains('on')){event.preventDefault();closeHistoryDetailModal();return;}if(event.key==='Escape'&&historyModal?.classList.contains('on')){event.preventDefault();closeHistoryModal();return;}if(event.key==='Escape'&&findReplaceModal?.classList.contains('on')){event.preventDefault();closeFindReplaceModal();return;}if(event.key==='Escape'&&formatModal?.classList.contains('on')){event.preventDefault();closeFormatModal();return;}if(event.key==='Escape'&&leaveModal?.classList.contains('on')){event.preventDefault();closeLeaveModal();}});
    updateUndoButtons();loadHistoryVersions();window.setInterval(()=>{if(hasUnsavedChanges())saveText('auto');},AUTOSAVE_MS);window.addEventListener('beforeunload',handleBeforeUnload);history.pushState({txtPreviewGuard:true},'');window.addEventListener('popstate',()=>{if(allowLeave||!hasUnsavedChanges())return;history.pushState({txtPreviewGuard:true},'');showLeaveModal(true);});
  </script>` : ''}
  ${noContextMenuScript}
</body>
</html>`;
}

function getPreviewLabel(file) {
  const baseName = file?.name || path.basename(file?.key || 'document');
  if (file?.ext === '.pdf') return baseName;
  return baseName;
}

function getPreviewHubLabel(file) {
  return file?.name || path.basename(file?.key || 'document');
}

function buildPreviewPdf(text, title) {
  const safeTitle = String(title || 'preview');
  const lines = normalizePreviewText(text).split('\n');
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const marginX = 56;
  const marginTop = 72;
  const marginBottom = 60;
  const fontSize = 12;
  const lineHeight = 18;
  const usableWidth = pageWidth - marginX * 2;
  const maxChars = Math.max(24, Math.floor(usableWidth / (fontSize * 0.56)));
  const maxLinesPerPage = Math.max(10, Math.floor((pageHeight - marginTop - marginBottom) / lineHeight));

  const wrapped = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ');
    if (!line) {
      wrapped.push('');
      continue;
    }
    let rest = line;
    while (rest.length > maxChars) {
      wrapped.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    wrapped.push(rest);
  }
  /*
  if (!wrapped.length) wrapped.push('這份文件沒有可顯示的文字內容。');

  */
  if (!wrapped.length) wrapped.push('This document does not contain readable text for preview.');

  const pages = [];
  for (let i = 0; i < wrapped.length; i += maxLinesPerPage) {
    pages.push(wrapped.slice(i, i + maxLinesPerPage));
  }

  const objects = [];
  const addObject = body => {
    objects.push(body);
    return objects.length;
  };
  const pdfHexText = value => {
    const hex = [];
    for (const ch of String(value || '')) {
      const cp = ch.codePointAt(0);
      if (cp <= 0xFFFF) {
        hex.push(cp.toString(16).padStart(4, '0'));
      } else {
        const n = cp - 0x10000;
        const hi = 0xD800 + (n >> 10);
        const lo = 0xDC00 + (n & 0x3FF);
        hex.push(hi.toString(16).padStart(4, '0'));
        hex.push(lo.toString(16).padStart(4, '0'));
      }
    }
    return hex.join('').toUpperCase();
  };

  const cidFontId = addObject('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MSungStd-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (CNS1) /Supplement 7 >> /DW 1000 >>');
  const fontId = addObject(`<< /Type /Font /Subtype /Type0 /BaseFont /MSungStd-Light /Encoding /UniCNS-UTF16-H /DescendantFonts [${cidFontId} 0 R] >>`);
  const pageIds = [];

  pages.forEach((pageLines, pageIndex) => {
    const content = ['BT', `/F1 ${fontSize} Tf`, `${marginX} ${pageHeight - marginTop} Td`];
    pageLines.forEach((line, idx) => {
      if (idx > 0) content.push(`0 -${lineHeight} Td`);
      content.push(`<${pdfHexText(line)}> Tj`);
    });
    content.push('ET');
    const contentStream = content.join('\n');
    const contentId = addObject(`<< /Length ${Buffer.byteLength(contentStream, 'utf8')} >>\nstream\n${contentStream}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent PAGES_ID 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  });

  const pagesId = addObject(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  pageIds.forEach(id => {
    objects[id - 1] = objects[id - 1].replace('PAGES_ID', String(pagesId));
  });

  const titleHex = Buffer.from(safeTitle, 'utf16le').toString('hex').toUpperCase();
  const infoId = addObject(`<< /Title <FEFF${titleHex}> /Producer (Catalog Server Preview) >>`);
  const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, idx) => {
    offsets[idx + 1] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

function resolvePreview(item, previewIndex = 0, collection = 'scenario', preferredEncoding = '') {
  const files = getPreviewableFiles(item, collection);
  const file = files[Number(previewIndex)];
  if (!file) return null;
  if (!fs.existsSync(file.abs)) return null;
  if (PREVIEWABLE_MEDIA_MIME[file.ext]) {
    return {
      type: 'media',
      filename: file.name,
      label: getPreviewLabel(file),
      mimeType: getPreviewMediaMimeType(file.ext),
      file,
      abs: file.abs
    };
  }
  if (file.ext === '.pdf') {
    return {
      type: 'pdf',
      filename: getPreviewLabel(file),
      label: getPreviewLabel(file),
      file,
      buffer: null,
      abs: file.abs
    };
  }
  if (file.ext === '.docx') {
    const docxPreview = extractDocxHtmlBlocks(file.abs);
    return {
      type: 'html',
      filename: `${path.parse(file.name).name}.html`,
      label: getPreviewLabel(file),
      file,
      blocks: docxPreview.blocks,
      layoutMode: docxPreview.layoutMode,
      html: '',
      abs: null
    };
  }
  const selectedEncoding = normalizeTextEncodingChoice(preferredEncoding);
  const textMeta = file.ext === '.txt'
    ? readTextFile(file.abs, selectedEncoding)
    : null;
  if (file.ext === '.html' || file.ext === '.htm') {
    return {
      type: 'html-file',
      filename: file.name,
      label: getPreviewLabel(file),
      file,
      text: ensureHtmlPreviewCharset(readTextFile(file.abs).text),
      html: '',
      abs: null
    };
  }
  const text = file.ext === '.txt' ? (textMeta?.text || '') : getPreviewSourceText(file, selectedEncoding);
  return {
    type: 'html',
    filename: `${path.parse(file.name).name}.html`,
    label: getPreviewLabel(file),
    file,
    text,
    textEncoding: textMeta?.encoding || '',
    selectedEncoding: selectedEncoding || 'auto',
    html: '',
    abs: null
  };
}

function resolvePreviewFileIndexByShare(item, share = {}) {
  const files = getPreviewableFiles(item, share.collection || 'scenario');
  const idx = files.findIndex(file => {
    if (share.fileKey && file?.key === share.fileKey) return true;
    if (share.relativePath && String(file?.relativePath || '').replace(/\\/g, '/') === share.relativePath) return true;
    return false;
  });
  return idx;
}

function getPreviewShareEntry(cfg, token = '') {
  const key = String(token || '').trim();
  if (!key) return null;
  const source = cfg?.previewShareLinks?.[key];
  if (!source || typeof source !== 'object') return null;
  return {
    token: key,
    collection: sanitizeCollectionKey(source.collection, { collections: getCollectionsConfig(cfg) }),
    itemId: String(source.itemId || '').trim(),
    fileKey: String(source.fileKey || '').trim(),
    relativePath: String(source.relativePath || '').replace(/\\/g, '/').trim(),
    createdAt: Number(source.createdAt) || Date.now(),
    enabled: source.enabled !== false,
    passwordHash: typeof source.passwordHash === 'string' ? source.passwordHash : ''
  };
}

function resolveSharedPreview(cfg, token = '') {
  const share = getPreviewShareEntry(cfg, token);
  if (!share?.itemId) return null;
  const cat = readCat(share.collection);
  const item = (cat.items || []).find(entry => entry.id === share.itemId);
  if (!item) return null;
  const previewIndex = resolvePreviewFileIndexByShare(item, share);
  if (previewIndex < 0) return null;
  const preview = resolvePreview(item, previewIndex, share.collection);
  if (!preview) return null;
  return { share, item, preview, previewIndex };
}

function buildPreviewShareTargetKey(share = {}) {
  return [
    sanitizeCollectionKey(share.collection || 'scenario'),
    String(share.itemId || '').trim(),
    String(share.fileKey || '').trim() || String(share.relativePath || '').replace(/\\/g, '/').trim()
  ].join('::');
}

function normalizePreviewShareLinks(existingLinks = {}, cfg = null) {
  const sourceLinks = existingLinks && typeof existingLinks === 'object' && !Array.isArray(existingLinks) ? existingLinks : {};
  const collections = getCollectionsConfig(cfg);
  const catCache = new Map();
  const seenTargets = new Set();
  const orderedEntries = Object.entries(sourceLinks)
    .map(([token, entry], index) => ({
      token: String(token || '').trim(),
      entry,
      index,
      createdAt: Number(entry?.createdAt) || 0
    }))
    .sort((a, b) => {
      if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      if (a.createdAt && !b.createdAt) return -1;
      if (!a.createdAt && b.createdAt) return 1;
      return a.index - b.index;
    });
  const normalized = {};

  for (const { token, entry } of orderedEntries) {
    if (!token || !entry || typeof entry !== 'object') continue;
    const rawCollection = String(entry.collection || '').trim().toLowerCase();
    const collection = sanitizeCollectionKey(rawCollection || 'scenario', { collections });
    if (rawCollection && collection !== rawCollection) continue;
    const share = {
      collection,
      itemId: String(entry.itemId || '').trim(),
      fileKey: String(entry.fileKey || '').trim(),
      relativePath: String(entry.relativePath || '').replace(/\\/g, '/').trim(),
      createdAt: Number(entry.createdAt) || Date.now(),
      enabled: entry.enabled !== false,
      passwordHash: typeof entry.passwordHash === 'string' ? entry.passwordHash : ''
    };
    if (!share.itemId || (!share.fileKey && !share.relativePath)) continue;
    const targetKey = buildPreviewShareTargetKey(share);
    if (seenTargets.has(targetKey)) continue;

    if (!catCache.has(share.collection)) {
      catCache.set(share.collection, readCat(share.collection));
    }
    const cat = catCache.get(share.collection);
    const item = (cat?.items || []).find(candidate => candidate.id === share.itemId);
    if (!item) continue;
    const previewIndex = resolvePreviewFileIndexByShare(item, share);
    if (previewIndex < 0) continue;
    const preview = resolvePreview(item, previewIndex, share.collection);
    if (!preview) continue;

    seenTargets.add(targetKey);
    normalized[token] = share;
  }

  return normalized;
}

function cleanupPreviewShareLinksInConfig(cfg = null) {
  const currentCfg = cfg && typeof cfg === 'object' ? cfg : readCfg();
  const normalizedLinks = normalizePreviewShareLinks(currentCfg.previewShareLinks || {}, currentCfg);
  if (JSON.stringify(currentCfg.previewShareLinks || {}) !== JSON.stringify(normalizedLinks)) {
    currentCfg.previewShareLinks = normalizedLinks;
    writeJSON(CFG_FILE, currentCfg);
  }
  return currentCfg;
}

function getPublicShareOrigin(cfg = null) {
  return normalizeHttpOrigin(process.env.PUBLIC_SHARE_ORIGIN) || normalizeHttpOrigin(cfg?.publicShareOrigin);
}

function getPublicShareSiteSlug(cfg = null) {
  return normalizePublicShareSiteSlug(process.env.PUBLIC_SHARE_SITE_SLUG) || normalizePublicShareSiteSlug(cfg?.publicShareSiteSlug);
}

function buildPreviewSharePath(token = '', cfg = null) {
  const encodedToken = encodeURIComponent(String(token || '').trim());
  const siteSlug = getPublicShareSiteSlug(cfg);
  if (siteSlug) return `/${siteSlug}/${encodedToken}`;
  return `/preview-share/${encodedToken}`;
}

function buildPreviewShareUrl(req, token = '', cfg = null) {
  const resolvedCfg = cfg || readCfg();
  const sharePath = buildPreviewSharePath(token, resolvedCfg);
  const publicShareOrigin = getPublicShareOrigin(resolvedCfg);
  return {
    sharePath,
    shareUrl: publicShareOrigin
      ? new URL(sharePath, `${publicShareOrigin}/`).toString()
      : `${req.protocol}://${req.get('host')}${sharePath}`
  };
}

function isTrustedPublicShareRequest(req, cfg = null) {
  const publicShareOrigin = getPublicShareOrigin(cfg);
  const siteSlug = getPublicShareSiteSlug(cfg);
  if (!publicShareOrigin || !siteSlug) return true;
  const forwardedHost = String(req?.headers['x-forwarded-host'] || '').trim().toLowerCase();
  const sharedSlug = normalizePublicShareSiteSlug(req?.headers['x-share-site-slug'] || '');
  let publicShareHost = '';
  try {
    publicShareHost = new URL(publicShareOrigin).host.toLowerCase();
  } catch {}
  return !!publicShareHost && forwardedHost === publicShareHost && sharedSlug === siteSlug;
}

function ensureTrustedPublicShareRequest(req, res, cfg = null, responseType = 'html') {
  if (isTrustedPublicShareRequest(req, cfg)) return true;
  if (responseType === 'json') {
    res.status(404).json({ error: 'Not found' });
  } else {
    res.status(404).send('Not found');
  }
  return false;
}

function getPreviewSharePasswordVersion(cfg, share = {}) {
  return sign(String(share?.passwordHash || ''), cfg?.authSecret || '');
}

function makePreviewShareAccessToken(cfg, share = {}) {
  const body = Buffer.from(JSON.stringify({
    iat: Date.now(),
    rnd: crypto.randomBytes(8).toString('hex'),
    token: String(share?.token || '').trim(),
    pv: getPreviewSharePasswordVersion(cfg, share)
  })).toString('base64url');
  const sig = sign(body, cfg.authSecret);
  return `${body}.${sig}`;
}

function verifyPreviewShareAccessToken(cfg, share = {}, token = '') {
  if (!token || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const expected = sign(body, cfg.authSecret);
  if (!safeEq(sig, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!(Number(payload.iat) > 0 && (Date.now() - Number(payload.iat)) <= PREVIEW_SHARE_ACCESS_TTL_MS)) return false;
    if (String(payload.token || '').trim() !== String(share?.token || '').trim()) return false;
    if (String(payload.pv || '') !== getPreviewSharePasswordVersion(cfg, share)) return false;
    return true;
  } catch {
    return false;
  }
}

function getPreviewShareAccessTokenFromReq(req) {
  const headerToken = String(req.headers['x-preview-share-access'] || '').trim();
  if (headerToken) return headerToken;
  const queryToken = String(req.query?.access || '').trim();
  return queryToken;
}

function getPreviewShareAccessState(cfg, share = {}, req = null) {
  if (!share?.token) return { ok: false, status: 404, error: '找不到分享的線上閱覽檔案' };
  if (share.enabled === false) return { ok: false, status: 403, error: '此公開連結目前已取消公開' };
  if (!share.passwordHash) return { ok: true, requiresPassword: false };
  const accessToken = req ? getPreviewShareAccessTokenFromReq(req) : '';
  if (verifyPreviewShareAccessToken(cfg, share, accessToken)) return { ok: true, requiresPassword: true };
  return {
    ok: false,
    status: 401,
    error: '此公開連結需要密碼',
    requiresPassword: true
  };
}

function listPreviewSharesForCollection(cfg, collection = 'scenario', req = null) {
  const cat = readCat(collection);
  const itemMap = new Map((cat.items || []).map(item => [item.id, item]));
  return Object.keys(cfg?.previewShareLinks || {})
    .map(token => {
      const share = getPreviewShareEntry(cfg, token);
      if (!share || share.collection !== collection) return null;
      const item = itemMap.get(share.itemId);
      if (!item) return null;
      const previewIndex = resolvePreviewFileIndexByShare(item, share);
      if (previewIndex < 0) return null;
      const preview = resolvePreview(item, previewIndex, share.collection);
      if (!preview) return null;
      const shareUrlInfo = req
        ? buildPreviewShareUrl(req, token, cfg)
        : { sharePath: buildPreviewSharePath(token, cfg), shareUrl: '' };
      return {
        token,
        itemId: item.id,
        itemTitle: item.translatedTitle || item.title || item.subtitle || '未命名項目',
        previewLabel: preview.label || preview.filename || preview.file?.name || '',
        previewFilename: preview.filename || preview.file?.name || '',
        createdAt: Number(share.createdAt) || Date.now(),
        createdAtLabel: formatDateTimeToSecond(share.createdAt),
        enabled: share.enabled !== false,
        hasPassword: !!share.passwordHash,
        sharePath: shareUrlInfo.sharePath,
        shareUrl: shareUrlInfo.shareUrl
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function findExistingPreviewShareToken(existingLinks = {}, target = {}) {
  const collection = sanitizeCollectionKey(target.collection || 'scenario');
  const itemId = String(target.itemId || '').trim();
  const fileKey = String(target.fileKey || '').trim();
  const relativePath = String(target.relativePath || '').replace(/\\/g, '/').trim();
  if (!itemId || (!fileKey && !relativePath)) return '';
  for (const [token, rawEntry] of Object.entries(existingLinks || {})) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entryCollection = sanitizeCollectionKey(rawEntry.collection || 'scenario');
    if (entryCollection !== collection) continue;
    if (String(rawEntry.itemId || '').trim() !== itemId) continue;
    const entryFileKey = String(rawEntry.fileKey || '').trim();
    const entryRelativePath = String(rawEntry.relativePath || '').replace(/\\/g, '/').trim();
    if ((fileKey && entryFileKey === fileKey) || (relativePath && entryRelativePath === relativePath)) {
      return token;
    }
  }
  return '';
}

function createPreviewShareToken(existingLinks = {}) {
  for (let i = 0; i < 8; i += 1) {
    const token = crypto.randomBytes(6).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    if (token && !existingLinks[token]) return token;
  }
  return crypto.randomBytes(12).toString('hex');
}

function getNoContextMenuScript() {
  return `<script>document.addEventListener('contextmenu', event => event.preventDefault());</script>`;
}

function applyNoContextMenuToHtml(html = '') {
  const script = getNoContextMenuScript();
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${script}</body>`);
  return `${html}${script}`;
}

function getRequestOrigin(req, cfg = null) {
  const publicShareOrigin = getPublicShareOrigin(cfg);
  if (publicShareOrigin && isTrustedPublicShareRequest(req, cfg)) return publicShareOrigin;
  const uploadOrigin = String(cfg?.uploadOrigin || '').trim();
  if (uploadOrigin) return uploadOrigin;
  return `${req.protocol}://${req.get('host')}`;
}

function buildAbsoluteUrl(req, targetPath = '', cfg = null) {
  return new URL(String(targetPath || ''), `${getRequestOrigin(req, cfg)}/`).toString();
}

function escapeMetaContent(value) {
  return escapeXml(String(value || '')).replace(/\r?\n/g, ' ').trim();
}

function getPreviewShareEmbedImagePath(item = {}, preview = null, token = '') {
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
  const previewFile = preview?.file || null;
  if (previewFile?.key && imageExts.has(String(previewFile.ext || '').toLowerCase())) {
    return getUploadPublicUrl(previewFile.key) || getThumbUrl(previewFile.key) || `/api/preview-share/${encodeURIComponent(token)}`;
  }
  const thumbKeys = collectThumbSourceKeys(item);
  if (thumbKeys.length) return getThumbUrl(thumbKeys[0]);
  return '';
}

function getPreviewShareMeta(req, cfg, resolved) {
  const item = resolved?.item || {};
  const preview = resolved?.preview || {};
  const token = String(resolved?.share?.token || '').trim();
  const title = item.translatedTitle || item.title || preview.label || preview.filename || '公開閱覽';
  const fileLabel = preview.label || preview.filename || '附件';
  const description = `${title}｜${fileLabel}`;
  const url = buildAbsoluteUrl(req, buildPreviewSharePath(token, cfg), cfg);
  const imagePath = getPreviewShareEmbedImagePath(item, preview, token);
  const imageUrl = imagePath ? buildAbsoluteUrl(req, imagePath, cfg) : '';
  const isImageShare = preview?.type === 'media' && String(preview?.mimeType || '').toLowerCase().startsWith('image/');
  return {
    title,
    description,
    url,
    imageUrl,
    isImageShare
  };
}

function renderPreviewHubPageV2(item, previews, token, collection = 'scenario') {
  const safeTitle = escapeXml(item?.translatedTitle || item?.title || '線上閱覽');
  const cards = previews.map((file, index) => {
    const href = withCollection(`/preview-open/${item.id}/${index}`, collection);
    const label = escapeXml(file?.name || path.basename(file?.key || 'document'));
    return `
      <a class="doc-card" href="${href}" target="_blank" rel="noopener">
        <strong>${label}</strong>
      </a>
    `;
  }).join('');

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}｜線上閱覽</title>
  <style>
    :root{
      --bg:#111118;--bg2:#1a1a22;--card:#1d1d26;--panel:#15151d;
      --text:#e8e2d6;--muted:#8e8a98;--gold:#c9a84c;--gdim:#7a6230;
      --gglow:rgba(201,168,76,.12);--border:#28283a;
      --shadow:0 10px 30px rgba(0,0,0,.24), 0 0 0 1px rgba(201,168,76,.05);
      --shadow-hover:0 18px 34px rgba(0,0,0,.34), 0 0 0 1px rgba(201,168,76,.14);
      --bg-top:#07070f;--bg-glow:rgba(201,168,76,.07);
      --radius:7px;
    }
    html{color-scheme:dark}
    html[data-theme="light"],body[data-theme="light"]{
      color-scheme:light;
      --bg:#ffffff;--bg2:#f8f5ef;--card:#ffffff;--panel:#fdfbf8;
      --text:#3b342d;--muted:#9b9084;
      --gold:#a18d79;--gdim:#d8cec2;--gglow:rgba(161,141,121,.07);
      --border:#ece5db;
      --shadow:0 18px 34px rgba(87,72,56,.09), 0 0 0 1px rgba(120,98,75,.06);
      --shadow-hover:0 24px 40px rgba(87,72,56,.13), 0 0 0 1px rgba(120,98,75,.10);
      --bg-top:#fdfbf7;--bg-glow:rgba(161,141,121,.04);
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:"Noto Sans TC",sans-serif;
      background:transparent;
      color:var(--text);
      min-height:100vh;
      transition:background .25s ease,color .25s ease;
    }
    .wrap{padding:18px}
    .shell{
      width:min(540px,100%);
      margin:0 auto;
      padding:1.25rem;
      background:var(--panel);
      border:1px solid var(--border);
      border-radius:var(--radius);
      box-shadow:var(--shadow);
    }
    h1{
      margin:0 0 10px;
      font-family:"Noto Serif TC",serif;
      font-size:1.22rem;
      font-weight:600;
      letter-spacing:.06em;
      color:var(--gold);
    }
    body[data-theme="light"] h1{color:#8d6a43}
    p{margin:0 0 16px;color:var(--muted);line-height:1.7;font-size:.82rem}
    .grid{display:grid;gap:10px}
    .doc-card{
      display:block;
      padding:14px 16px;
      border:1px solid var(--border);
      border-radius:var(--radius);
      background:linear-gradient(180deg,var(--card),var(--bg2));
      text-decoration:none;
      color:inherit;
      box-shadow:var(--shadow);
      transition:transform .24s ease,border-color .24s ease,box-shadow .24s ease;
    }
    .doc-card:hover{
      transform:translateY(-1px);
      border-color:var(--gold);
      box-shadow:var(--shadow-hover);
    }
    strong{
      display:block;
      font-family:"Noto Serif TC",serif;
      font-size:1rem;
      font-weight:600;
      line-height:1.45;
      color:var(--text);
      word-break:break-word;
    }
  </style>
  <script>
    (() => {
      const mode = localStorage.getItem('theme-mode') === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = mode;
      document.addEventListener('DOMContentLoaded', () => {
        document.body.dataset.theme = mode;
      });
    })();
  </script>
</head>
<body>
  <main class="wrap">
    <section class="shell">
      <h1>${safeTitle}</h1>
      <p>請選擇欲開啟線上閱覽的附件。</p>
      <section class="grid">${cards}</section>
    </section>
  </main>
</body>
</html>`;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = CRC32_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function toDosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const dosTime = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const dosDate = (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { dosTime, dosDate };
}

function makeUniqueZipEntryNames(files) {
  const counts = new Map();
  return files.map((file, idx) => {
    const fallback = `file-${idx + 1}.bin`;
    const normalized = normalizeRelativePath(file.relativePath || file.originalname || fallback, fallback);
    const parsed = path.posix.parse(normalized);
    const base = sanitizeDownloadName(parsed.name, `file-${idx + 1}`);
    const ext = parsed.ext || '';
    const dir = parsed.dir ? `${parsed.dir}/` : '';
    const dedupeKey = `${dir}${base}${ext}`;
    const seen = counts.get(dedupeKey) || 0;
    counts.set(dedupeKey, seen + 1);
    const name = seen ? `${base} (${seen + 1})${ext}` : `${base}${ext}`;
    return `${dir}${name}`;
  });
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  entries.forEach(entry => {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const data = fs.readFileSync(entry.path);
    const stat = fs.statSync(entry.path);
    const { dosTime, dosDate } = toDosDateTime(stat.mtime);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function persistDownloadFiles(itemId, files, preferredBaseName, collection = 'scenario') {
  if (!files?.length) return { downloadKey: null, downloadName: null, downloadFiles: [] };

  const dir = collUploadDir(collection, itemId);
  const legacyZipPath = path.join(dir, 'dl.zip');
  fs.mkdirSync(dir, { recursive: true });

  const sourceFiles = files.map((file, idx) => {
    const fallbackName = decodeUploadFilename(file.name || file.originalname || path.basename(file.key || `file-${idx + 1}.bin`));
    return {
      ...file,
      relativePath: normalizeRelativePath(file.relativePath || fallbackName, fallbackName || `file-${idx + 1}.bin`)
    };
  });
  const uniqueRelativePaths = makeUniqueZipEntryNames(sourceFiles.map(file => ({ relativePath: file.relativePath })));
  const normalizedFiles = sourceFiles.map((file, idx) => {
    const relativePath = uniqueRelativePaths[idx];
    const finalKey = buildStoredKey(collection, itemId, relativePath);
    const finalPath = resolveUploadTargetPath(dir, relativePath);
    let currentPath = file.path || (file.key ? path.join(UPLOADS, file.key) : finalPath);
    if (file.path) {
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      if (path.resolve(currentPath) !== finalPath) {
        if (fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true });
        fs.renameSync(currentPath, finalPath);
      }
      currentPath = finalPath;
    }
    return {
      key: file.path ? finalKey : (file.key || finalKey),
      path: currentPath,
      name: sanitizeDownloadName(decodeUploadFilename(path.posix.basename(relativePath)), `file-${idx + 1}`),
      size: Number(file.size) > 0 ? Number(file.size) : (fs.existsSync(currentPath) ? fs.statSync(currentPath).size : undefined),
      relativePath
    };
  });

  if (normalizedFiles.length === 1) {
    if (fs.existsSync(legacyZipPath)) fs.rmSync(legacyZipPath, { force: true });
    const file = normalizedFiles[0];
    return {
      downloadKey: file.key,
      downloadName: file.name,
      downloadFiles: normalizedFiles.map(({ key, name, size, relativePath }) => ({ key, name, size, relativePath }))
    };
  }

  const zipBase = sanitizeDownloadName(String(preferredBaseName || 'download').replace(/\.zip$/i, ''), 'download');
  if (fs.existsSync(legacyZipPath)) fs.rmSync(legacyZipPath, { force: true });
  return {
    downloadKey: null,
    downloadName: `${zipBase}.zip`,
    downloadFiles: normalizedFiles.map(({ key, name, size, relativePath }) => ({ key, name, size, relativePath }))
  };
}

// ── Multer（依 itemId 分資料夾）────────────────────
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const id  = getUploadItemId(req);
    const dir = collUploadDir(getUploadCollection(req), id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = (path.extname(file.originalname) || '.bin').toLowerCase();
    if (file.fieldname === 'cover')    return cb(null, 'cover' + ext);
    if (file.fieldname === 'file' || file.fieldname === 'files') {
      req._fc = req._fc ?? 0;
      return cb(null, `dl-src-${Date.now()}-${req._fc++}${ext}`);
    }
    if (file.fieldname === 'previews') {
      req._pc = req._pc ?? 0;
      return cb(null, `prev-${Date.now()}-${req._pc++}${ext}`);
    }
    cb(null, Date.now() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2 GB 上限
});
function removeStoredFile(key) {
  if (!key) return;
  const abs = path.join(UPLOADS, key);
  if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
  const thumbAbs = getThumbAbsPath(key);
  if (thumbAbs && fs.existsSync(thumbAbs)) fs.rmSync(thumbAbs, { force: true });
}

// ── 中介層 ────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/opencc-js', express.static(path.join(ROOT, 'node_modules', 'opencc-js', 'dist', 'umd')));
app.use('/uploads',
  (req, res, next) => {
    if (path.basename(req.path).startsWith('dl.')) {
      return res.status(403).json({ error: 'Direct upload access is not allowed here.' });
    }
    next();
  },
  express.static(UPLOADS, { maxAge: '7d' })
);
app.get('/thumbs/*', async (req, res) => {
  const sourceKey = resolveThumbSourceFromRequestPath(req.params[0] || '');
  if (!sourceKey || path.basename(sourceKey).startsWith('dl.')) {
    return res.status(404).end();
  }
  const thumbAbs = await ensureThumbForKey(sourceKey);
  if (!thumbAbs || !fs.existsSync(thumbAbs)) {
    return res.status(404).end();
  }
  res.type('image/webp');
  res.set('Cache-Control', 'public, max-age=604800');
  return res.sendFile(thumbAbs);
});

// ══════════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════════

// 取得目錄（公開）
app.get('/api/catalog', (req, res) => {
  const collection = getC(req);
  const role = getViewerRole(req);
  const cfg = readCfg();
  if (!canAccessCollectionByRole(collection, role, cfg)) return res.status(403).json({ error: '你沒有權限查看這個資料庫' });
  const cat = readCat(collection);
  res.json(filterCatalogForViewer(cat, role));
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/cfg-public', (req, res) => {
  try {
    const cfg = readCfg();
    res.json({
      googleClientId: cfg.googleClientId || null,
      uploadOrigin: cfg.uploadOrigin || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/host-usage', auth, (req, res) => {
  try {
    const snapshot = getHostUsageSnapshot();
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/cfg-upload-origin', auth, (req, res) => {
  try {
    if (req.authUser?.role !== 'owner') return res.status(403).json({ error: '只有站主可以設定上傳網域' });
    const rawUploadOrigin = String(req.body?.uploadOrigin || '').trim();
    let uploadOrigin = '';
    if (rawUploadOrigin) {
      try {
        const url = new URL(rawUploadOrigin);
        if (!/^https?:$/.test(url.protocol)) throw new Error('invalid-protocol');
        uploadOrigin = url.origin;
      } catch {
        return res.status(400).json({ error: '上傳網域格式錯誤，請填入完整網址，例如 https://upload.example.com' });
      }
    }
    saveCfg({ uploadOrigin });
    res.json({ ok: true, uploadOrigin: uploadOrigin || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const cfg = readCfg();
    const clientId = cfg.googleClientId;
    if (!clientId) return res.status(503).json({ error: '尚未設定 Google Client ID，請站主至後台設定頁填入' });

    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: req.body.credential, audience: clientId });
    const payload = ticket.getPayload();
    const googleEmail = normalizeGoogleEmail(payload?.email || '');
    if (!googleEmail) return res.status(401).json({ error: '無法取得 Google 帳號信箱' });

    const allUsers = normalizeAuthUsers(cfg.users, cfg.pwdHash);
    const user = allUsers.find(u => normalizeGoogleEmail(u.googleEmail) === googleEmail);
    if (user && !user.googleOnly) {
      cfg.users = allUsers.map(entry => entry.id === user.id ? { ...entry, googleOnly: true } : entry);
      saveCfg(cfg);
      user.googleOnly = true;
    }
    if (!user) return res.status(401).json({ error: `此 Google 帳號（${googleEmail}）尚未綁定任何使用者，請站主至後台帳號管理填入對應信箱` });

    res.json({
      token: makeToken(user),
      expiresInMs: TOKEN_TTL_MS,
      user: { id: user.id, username: user.username, role: user.role }
    });
  } catch (e) { res.status(401).json({ error: 'Google 登入失敗: ' + e.message }); }
});

app.post('/api/login', (req, res) => {
  const cfg = readCfg();
  const targetUser = getAuthUserByUsername(cfg, req.body.username || '');
  if (targetUser?.googleOnly) return res.status(403).json({ error: '此帳號已停用帳號密碼登入，請改用 Google 登入' });
  const user = getAuthUserByCredentials(cfg, req.body.username || '', req.body.password || '');
  if (!user) return res.status(401).json({ error: '用戶名或密碼錯誤' });
  res.json({
    token: makeToken(user),
    expiresInMs: TOKEN_TTL_MS,
    user: { id: user.id, username: user.username, role: user.role }
  });
});

// 登出
app.post('/api/logout', auth, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/manage-page-lock', auth, (req, res) => {
  const collection = getC(req);
  const lock = getActiveManagePageLock(collection);
  if (!lock) return res.json({ ok: true, locked: false });
  res.json({
    ok: true,
    locked: true,
    lock: {
      username: lock.username,
      role: lock.role,
      collection: lock.collection,
      expiresAt: lock.expiresAt
    }
  });
});

app.post('/api/manage-page-lock/acquire', auth, (req, res) => {
  const collection = getC(req);
  const sessionId = String(req.body?.sessionId || '').trim();
  if (!sessionId) return res.status(400).json({ error: '缺少編輯識別' });
  const current = getActiveManagePageLock(collection);
  if (current && current.sessionId !== sessionId) {
    return res.status(409).json({
      error: `目前「${current.username}」正在編輯資料清單，請稍後再試`,
      locked: true,
      lock: {
        username: current.username,
        role: current.role,
        collection: current.collection,
        expiresAt: current.expiresAt
      }
    });
  }
  const lock = setManagePageLock(collection, {
    sessionId,
    userId: req.authUser.id,
    username: req.authUser.username,
    role: req.authUser.role
  });
  res.json({
    ok: true,
    locked: true,
    lock: {
      username: lock.username,
      role: lock.role,
      collection: lock.collection,
      expiresAt: lock.expiresAt
    }
  });
});

app.post('/api/manage-page-lock/heartbeat', auth, (req, res) => {
  const collection = getC(req);
  const sessionId = String(req.body?.sessionId || '').trim();
  if (!sessionId) return res.status(400).json({ error: '缺少編輯識別' });
  const current = getActiveManagePageLock(collection);
  if (!current) return res.status(409).json({ error: '編輯鎖已失效', locked: false });
  if (current.sessionId !== sessionId) {
    return res.status(409).json({
      error: `目前「${current.username}」正在編輯資料清單，請稍後再試`,
      locked: true,
      lock: {
        username: current.username,
        role: current.role,
        collection: current.collection,
        expiresAt: current.expiresAt
      }
    });
  }
  const lock = setManagePageLock(collection, {
    sessionId,
    userId: req.authUser.id,
    username: req.authUser.username,
    role: req.authUser.role
  });
  res.json({
    ok: true,
    locked: true,
    lock: {
      username: lock.username,
      role: lock.role,
      collection: lock.collection,
      expiresAt: lock.expiresAt
    }
  });
});

app.post('/api/manage-page-lock/release', auth, (req, res) => {
  const collection = getC(req);
  const sessionId = String(req.body?.sessionId || '').trim();
  if (!sessionId) return res.status(400).json({ error: '缺少編輯識別' });
  clearManagePageLock(collection, sessionId);
  res.json({ ok: true, locked: false });
});

app.get('/api/items/:id/download', auth, (req, res) => {
  const collection = getC(req);
  const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
  if (collectionDenied) return res.status(403).json(collectionDenied);
  if (!hasRolePermission(req.authUser, 'downloadFiles', collection)) return res.status(403).json({ error: '你沒有下載檔案的權限。' });
  const cat = readCat(collection);
  const collCfg = getCollectionConfig(collection);
  const item = (cat.items || []).find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: '找不到項目。' });
  if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });
  if (collCfg.mode === 'image' && getImageBundleFiles(item).length) return res.json({ url: withCollection(`/api/download/${item.id}`, collection) });
  if (item.downloadUrl) return res.json({ url: item.downloadUrl });
  if (getDownloadableFilesForItem(item, collCfg.mode).length) return res.json({ url: withCollection(`/api/download/${item.id}`, collection) });
  if (item.downloadKey) return res.json({ url: withCollection(`/api/download/${item.id}`, collection) });
  return res.json({ url: '' });
});

app.get('/api/items/:id/download-files', auth, (req, res) => {
  const collection = getC(req);
  const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
  if (collectionDenied) return res.status(403).json(collectionDenied);
  if (!hasRolePermission(req.authUser, 'downloadFiles', collection)) return res.status(403).json({ error: '你沒有下載檔案的權限。' });
  const cat = readCat(collection);
  const collCfg = getCollectionConfig(collection);
  const item = (cat.items || []).find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: '找不到項目。' });
  if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });

  const files = getDownloadableFilesForItem(item, collCfg.mode).map(file => ({
    index: file.index,
    name: path.posix.basename(String(file.relativePath || file.name || path.basename(file.key || 'download')).replace(/\\/g, '/')),
    relativePath: file.relativePath || file.name,
    url: withCollection(`/api/download/${item.id}/files/${file.index}`, collection),
    key: file.key || '',
    mediaUrl: file.key ? withCollection(`/uploads/${file.key}`, collection) : '',
    thumbUrl: file.key && isThumbEligibleImageKey(file.key) ? getThumbUrl(file.key) : ''
  }));

  if (files.length) {
    return res.json({
      files,
      allUrl: withCollection(`/api/download/${item.id}`, collection),
      allName: item.downloadName || `${sanitizeDownloadName(String(item.title || item.subtitle || 'download')).replace(/\.zip$/i, '')}.zip`
    });
  }

  if (item.downloadUrl) {
    const name = sanitizeDownloadName(item.downloadName || item.title || item.subtitle || 'download');
    return res.json({
      files: [{ index: 0, name, url: item.downloadUrl, external: true }],
      allUrl: item.downloadUrl,
      allName: name,
      externalAll: true
    });
  }

  return res.json({ files: [], allUrl: '', allName: '' });
});

app.get('/api/items/:id/preview', auth, (req, res) => {
  try {
    const collection = getC(req);
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
    if (collectionDenied) return res.status(403).json(collectionDenied);
    if (!hasRolePermission(req.authUser, 'onlinePreview', collection)) return res.status(403).json({ error: '你沒有權限使用線上閱覽。' });
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '找不到項目。' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });
    const files = getPreviewableFiles(item, collection).filter(file => fs.existsSync(file.abs));
    if (!files.length) return res.json({ supported: false, url: '', count: 0 });
    const url = files.length === 1
      ? withCollection(`/preview-open/${item.id}/0`, collection)
      : withCollection(`/preview-hub/${item.id}`, collection);
    return res.json({
      supported: true,
      url,
      count: files.length,
      itemId: item.id,
      title: item.translatedTitle || item.title || '線上閱覽',
      files: files.map((file, index) => ({
        index,
        name: path.posix.basename(String(file?.relativePath || file?.name || path.basename(file?.key || 'document')).replace(/\\/g, '/')),
        relativePath: file?.relativePath || file?.name || path.basename(file?.key || 'document'),
        url: withCollection(`/preview-open/${item.id}/${index}`, collection),
        mediaUrl: PREVIEWABLE_MEDIA_MIME[file?.ext]
          ? withCollection(`/uploads/${file.key}`, collection)
          : withCollection(`/api/preview/${item.id}/${index}`, collection),
        thumbUrl: PREVIEWABLE_MEDIA_MIME[file?.ext] && isThumbEligibleImageKey(file?.key) ? getThumbUrl(file.key) : ''
      }))
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/items/:id/preview-share', auth, (req, res) => {
  try {
    const cfg = readCfg();
    const collection = getC(req);
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, cfg);
    if (collectionDenied) return res.status(403).json(collectionDenied);
    if (!hasRolePermission(req.authUser, 'onlinePreview', collection)) return res.status(403).json({ error: '你沒有權限使用線上閱覽。' });
    if (!hasRolePermission(req.authUser, 'createPreviewShare', collection)) return res.status(403).json({ error: '你沒有建立預覽分享的權限。' });
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '找不到項目。' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });
    const files = getPreviewableFiles(item, collection).filter(file => fs.existsSync(file.abs));
    const previewIndex = Number(req.body?.index);
    const file = files[previewIndex];
    if (!file) return res.status(404).json({ error: '找不到可預覽的檔案。' });
    cfg.previewShareLinks = cfg.previewShareLinks && typeof cfg.previewShareLinks === 'object' ? cfg.previewShareLinks : {};
    const shareEntry = {
      collection,
      itemId: item.id,
      fileKey: String(file.key || '').trim(),
      relativePath: String(file.relativePath || file.name || '').replace(/\\/g, '/').trim(),
      createdAt: Date.now(),
      enabled: true,
      passwordHash: ''
    };
    let token = findExistingPreviewShareToken(cfg.previewShareLinks, shareEntry);
    if (!token) token = createPreviewShareToken(cfg.previewShareLinks);
    const previous = cfg.previewShareLinks[token] && typeof cfg.previewShareLinks[token] === 'object' ? cfg.previewShareLinks[token] : {};
    cfg.previewShareLinks[token] = {
      ...previous,
      ...shareEntry,
      enabled: true,
      passwordHash: typeof previous.passwordHash === 'string' ? previous.passwordHash : ''
    };
    saveCfg(cfg);
    const { sharePath, shareUrl } = buildPreviewShareUrl(req, token, cfg);
    return res.json({
      ok: true,
      sharePath,
      shareUrl
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.post('/api/preview-share/:token/auth', (req, res) => {
  try {
    const cfg = readCfg();
    if (!ensureTrustedPublicShareRequest(req, res, cfg, 'json')) return;
    const share = getPreviewShareEntry(cfg, req.params.token);
    if (!share) return res.status(404).json({ error: '找不到分享的線上閱覽檔案' });
    if (share.enabled === false) return res.status(403).json({ error: '此公開連結目前已取消公開' });
    if (!share.passwordHash) return res.json({ ok: true, accessToken: '' });
    const password = String(req.body?.password || '');
    if (!password || !safeEq(sha256(password), share.passwordHash)) {
      return res.status(401).json({ error: '密碼錯誤', requiresPassword: true });
    }
    return res.json({
      ok: true,
      accessToken: makePreviewShareAccessToken(cfg, share)
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.get('/api/download/:id', auth, (req, res) => {
  const collection = getC(req);
  const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
  if (collectionDenied) return res.status(403).json(collectionDenied);
    if (!hasRolePermission(req.authUser, 'downloadFiles', collection)) return res.status(403).json({ error: '你沒有下載檔案的權限。' });
  const cat = readCat(collection);
  const collCfg = getCollectionConfig(collection);
  const item = (cat.items || []).find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: '找不到項目。' });
  if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });
  if (collCfg.mode === 'image') {
    const files = getImageBundleFiles(item);
    if (!files.length) return res.status(404).json({ error: '找不到可下載的檔案。' });
    if (files.length === 1) {
      setDownloadHeaders(res, files[0].name);
      return res.sendFile(files[0].abs);
    }
    const zipBase = sanitizeDownloadName(String(item.title || item.subtitle || 'media').replace(/\.zip$/i, ''), 'media');
    const entryNames = makeUniqueZipEntryNames(files.map(file => ({ originalname: file.name })));
    const zipBuffer = buildZipBuffer(files.map((file, idx) => ({ path: file.abs, name: entryNames[idx] })));
    setDownloadHeaders(res, `${zipBase}.zip`);
    return res.end(zipBuffer);
  }
  const files = getDownloadableFilesForItem(item, collCfg.mode);
  if (files.length) {
    if (files.length === 1) {
      setDownloadHeaders(res, files[0].name);
      return res.sendFile(files[0].abs);
    }
    const zipBase = sanitizeDownloadName(String(item.downloadName || item.title || item.subtitle || 'download').replace(/\.zip$/i, ''), 'download');
    const entryNames = makeUniqueZipEntryNames(files.map(file => ({ relativePath: file.relativePath || file.name })));
    const zipBuffer = buildZipBuffer(files.map((file, idx) => ({ path: file.abs, name: entryNames[idx] })));
    setDownloadHeaders(res, `${zipBase}.zip`);
    return res.end(zipBuffer);
  }
  if (item.downloadKey) {
    const abs = path.join(UPLOADS, item.downloadKey);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: '找不到檔案。' });
    setDownloadHeaders(res, item.downloadName || path.basename(abs));
    return res.sendFile(abs);
  }
  return res.status(404).json({ error: '找不到檔案。' });
});

app.get('/api/download/:id/files/:index', auth, (req, res) => {
  const collection = getC(req);
  const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
  if (collectionDenied) return res.status(403).json(collectionDenied);
  if (!hasRolePermission(req.authUser, 'downloadFiles', collection)) return res.status(403).json({ error: '你沒有下載檔案的權限。' });
  const cat = readCat(collection);
  const collCfg = getCollectionConfig(collection);
  const item = (cat.items || []).find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: '找不到項目。' });
  if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });
  const files = getDownloadableFilesForItem(item, collCfg.mode);
  const file = files[Number(req.params.index)];
  if (!file) return res.status(404).json({ error: '找不到檔案。' });
  setDownloadHeaders(res, file.name || path.basename(file.abs));
  return res.sendFile(file.abs);
});

app.get('/preview-hub/:id', auth, (req, res) => {
  try {
    const collection = getC(req);
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
    if (collectionDenied) return res.status(403).send(collectionDenied.error);
    if (!hasRolePermission(req.authUser, 'onlinePreview', collection)) return res.status(403).send('你沒有權限使用線上閱覽。');
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).send('Item not found');
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).send('Forbidden');
    const files = getPreviewableFiles(item, collection).filter(file => fs.existsSync(file.abs));
    if (!files.length) return res.status(404).send('No previewable files');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderPreviewHubPageV2(item, files, getTokenFromReq(req), collection));
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

function renderPreviewOpenShell(itemId, previewIndex, collection = 'scenario') {
  const safeId = escapeXml(itemId);
  const safeIndex = escapeXml(String(previewIndex));
  const safeCollection = escapeXml(sanitizeCollectionKey(collection));
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>線上閱覽</title>
  <style>
    :root{--bg:#111118;--panel:#15151d;--text:#e8e2d6;--muted:#8e8a98;--border:#28283a;--gold:#c9a84c}
    html{color-scheme:dark}
    html[data-theme="light"],body[data-theme="light"]{
      color-scheme:light;
      --bg:#e6e6e6;--panel:#ffffff;--text:#3b342d;--muted:#9b9084;--border:#ece5db;--gold:#a18d79;
    }
    html[data-theme="light"] .pw-form button,body[data-theme="light"] .pw-form button{color:#5E4F36}
    html[data-theme="light"] .pw-form button:hover,body[data-theme="light"] .pw-form button:hover{color:#140f00}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif}
    .state{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
    .card{background:var(--panel);border:1px solid var(--border);padding:24px 28px;max-width:520px;width:100%}
    h1{margin:0 0 10px;font-family:"Noto Serif TC",serif;font-size:1.25rem}
    p{margin:0;color:var(--muted);line-height:1.7}
    .pw-form{display:none;gap:10px;margin-top:18px}
    .pw-form.on{display:grid}
    .pw-form input{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--text);font:inherit;outline:none}
    .pw-form input:focus{border-color:#c9a84c}
    .pw-form button{padding:12px 14px;border:none;border-radius:12px;background:#c9a84c;color:#17120a;font:inherit;cursor:pointer}
    .pw-hint{display:none;margin-top:10px;font-size:.92rem}
    .pw-hint.on{display:block}
    iframe,embed{display:block;border:none;width:100%;height:100vh}
    .media-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .media-wrap img,.media-wrap video{display:block;max-width:min(100%,1200px);max-height:calc(100vh - 40px);border:none}
    .media-wrap audio{width:min(720px,100%)}
  </style>
</head>
<body>
  <div class="state" id="state">
    <div class="card">
      <h1>線上閱覽</h1>
      <p id="msg">正在載入檔案...</p>
    </div>
  </div>
  <script>
    (() => {
      const mode = localStorage.getItem('theme-mode') === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = mode;
      document.body.dataset.theme = mode;
    })();
    const itemId = ${JSON.stringify(itemId)};
    const previewIndex = ${JSON.stringify(String(previewIndex))};
    const collection = ${JSON.stringify(sanitizeCollectionKey(collection))};
    const token = localStorage.getItem('adm-token') || '';
    const msg = document.getElementById('msg');
    const state = document.getElementById('state');

    async function openPreview() {
      if (!token) {
        msg.textContent = '請先登入後再開啟線上閱覽。';
        return;
      }
      function applyMediaViewerTheme() {
        document.documentElement.dataset.theme = 'dark';
        document.body.dataset.theme = 'dark';
        document.documentElement.style.background = '#111118';
        document.body.style.background = '#111118';
      }
      const params = new URLSearchParams(window.location.search);
      if (collection !== 'scenario') params.set('c', collection); else params.delete('c');
      const queryString = params.toString();
      const url = '/api/preview/' + encodeURIComponent(itemId) + '/' + encodeURIComponent(previewIndex) + (queryString ? ('?' + queryString) : '');
      const resp = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!resp.ok) {
        let text = '無法載入檔案';
        try {
          const data = await resp.json();
          text = data.error || text;
        } catch {}
        msg.textContent = text;
        return;
      }
      const type = (resp.headers.get('content-type') || '').toLowerCase();
      if (type.startsWith('audio/')) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const wrap = document.createElement('div');
        wrap.className = 'media-wrap';
        applyMediaViewerTheme();
        const audio = document.createElement('audio');
        audio.src = url;
        audio.controls = true;
        audio.autoplay = true;
        document.body.innerHTML = '';
        wrap.appendChild(audio);
        document.body.appendChild(wrap);
        return;
      }
      if (type.startsWith('video/')) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const wrap = document.createElement('div');
        wrap.className = 'media-wrap';
        applyMediaViewerTheme();
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        document.body.innerHTML = '';
        wrap.appendChild(video);
        document.body.appendChild(wrap);
        return;
      }
      if (type.startsWith('image/')) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const wrap = document.createElement('div');
        wrap.className = 'media-wrap';
        applyMediaViewerTheme();
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        document.body.innerHTML = '';
        wrap.appendChild(img);
        document.body.appendChild(wrap);
        return;
      }
      if (type.includes('application/pdf')) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const embed = document.createElement('embed');
        embed.src = url;
        embed.type = 'application/pdf';
        document.body.innerHTML = '';
        document.body.appendChild(embed);
        return;
      }
      const html = await resp.text();
      document.open();
      document.write(html);
      document.close();
    }

    openPreview().catch(() => {
      msg.textContent = '載入預覽失敗，請稍後再試。';
    });
  </script>
</body>
</html>`;
}

function renderPreviewShareShell(token = '', options = {}) {
  const meta = options.meta || {};
  const pageTitle = meta.title ? `${meta.title}｜公開閱覽` : '公開閱覽';
  const safeTitle = escapeMetaContent(pageTitle);
  const safeDescription = escapeMetaContent(meta.description || '公開閱覽');
  const safeUrl = escapeMetaContent(meta.url || '');
  const safeImageUrl = escapeMetaContent(meta.imageUrl || '');
  const isImageShare = !!meta.isImageShare && !!safeImageUrl;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  ${isImageShare ? '' : `<meta property="og:title" content="${safeTitle}">`}
  ${isImageShare ? '' : `<meta property="og:description" content="${safeDescription}">`}
  <meta property="og:type" content="${isImageShare ? 'image' : 'website'}">
  ${isImageShare ? '' : `<meta property="og:site_name" content="公開閱覽">`}
  ${safeUrl ? `<meta property="og:url" content="${safeUrl}">` : ''}
  ${safeImageUrl ? `<meta property="og:image" content="${safeImageUrl}">` : ''}
  <meta name="twitter:card" content="${safeImageUrl ? 'summary_large_image' : 'summary'}">
  ${isImageShare ? '' : `<meta name="twitter:title" content="${safeTitle}">`}
  ${isImageShare ? '' : `<meta name="twitter:description" content="${safeDescription}">`}
  ${safeImageUrl ? `<meta name="twitter:image" content="${safeImageUrl}">` : ''}
  <style>
    :root{--bg:#111118;--panel:#15151d;--text:#e8e2d6;--muted:#8e8a98;--border:#28283a;--gold:#c9a84c}
    html{color-scheme:dark}
    html[data-theme="light"],body[data-theme="light"]{
      color-scheme:light;
      --bg:#e6e6e6;--panel:#ffffff;--text:#3b342d;--muted:#9b9084;--border:#ece5db;--gold:#a18d79;
    }
    html[data-theme="light"] .pw-form button,body[data-theme="light"] .pw-form button{color:#5E4F36}
    html[data-theme="light"] .pw-form button:hover,body[data-theme="light"] .pw-form button:hover{color:#140f00}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif}
    .state{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
    .card{background:var(--panel);border:1px solid var(--border);padding:24px 28px;max-width:520px;width:100%}
    h1{margin:0 0 10px;font-family:"Noto Serif TC",serif;font-size:1.25rem}
    p{margin:0;color:var(--muted);line-height:1.7}
    .pw-form{display:none;gap:10px;margin-top:16px}
    .pw-form.on{display:grid}
    .pw-form input{width:100%;min-height:44px;padding:0 14px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;outline:none}
    .pw-form button{min-height:44px;border:1px solid var(--gold);border-radius:7px;background:var(--gold);color:#140f00;font:inherit;font-weight:500;cursor:pointer;transition:all .2s ease;text-align:center}
    .pw-form button:hover{background:#d5b45a;border-color:#d5b45a}
    .pw-hint{display:none;margin-top:10px;color:#d98f7f}
    .pw-hint.on{display:block}
    iframe,embed{display:block;border:none;width:100%;height:100vh}
    .media-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .media-wrap img,.media-wrap video{display:block;max-width:min(100%,1200px);max-height:calc(100vh - 40px);border:none}
    .media-wrap audio{width:min(720px,100%)}
  </style>
</head>
<body>
  <div class="state" id="state">
    <div class="card">
      <h1>公開閱覽</h1>
      <p id="msg">正在載入檔案...</p>
      <form class="pw-form" id="pw-form">
        <input type="password" id="pw-input" placeholder="請輸入訪問密碼" autocomplete="current-password">
        <button type="submit">送出密碼</button>
      </form>
      <p class="pw-hint" id="pw-hint"></p>
    </div>
  </div>
  <script>
    (() => {
      const mode = localStorage.getItem('theme-mode') === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = mode;
      document.body.dataset.theme = mode;
    })();
    document.addEventListener('contextmenu', event => event.preventDefault());
    const token = ${JSON.stringify(String(token || '').trim())};
    const msg = document.getElementById('msg');
    const pwForm = document.getElementById('pw-form');
    const pwInput = document.getElementById('pw-input');
    const pwHint = document.getElementById('pw-hint');
    let accessToken = '';

    function showPasswordForm(text = '此公開連結需要密碼') {
      msg.textContent = text;
      pwForm.classList.add('on');
      pwHint.classList.remove('on');
      pwHint.textContent = '';
      setTimeout(() => pwInput.focus(), 0);
    }

    function setPasswordHint(text = '') {
      pwHint.textContent = text;
      pwHint.classList.toggle('on', !!text);
    }

    async function submitPassword(password) {
      const resp = await fetch('/api/preview-share/' + encodeURIComponent(token) + '/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || '密碼驗證失敗');
      accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
      pwForm.classList.remove('on');
      setPasswordHint('');
      msg.textContent = '密碼驗證成功，正在載入檔案...';
      return openPreview();
    }

    async function openPreview() {
      function applyMediaViewerTheme() {
        document.documentElement.dataset.theme = 'dark';
        document.body.dataset.theme = 'dark';
        document.documentElement.style.background = '#111118';
        document.body.style.background = '#111118';
      }
      const url = '/api/preview-share/' + encodeURIComponent(token);
      const headers = accessToken ? { 'x-preview-share-access': accessToken } : {};
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        let text = '無法載入檔案';
        try {
          const data = await resp.json();
          if (resp.status === 401 && data.requiresPassword) {
            showPasswordForm(data.error || '此公開連結需要密碼');
            return;
          }
          pwForm.classList.remove('on');
          text = data.error || text;
        } catch {}
        pwForm.classList.remove('on');
        msg.textContent = text;
        return;
      }
      const type = (resp.headers.get('content-type') || '').toLowerCase();
      if (type.startsWith('audio/')) {
        const blob = await resp.blob();
        const mediaUrl = URL.createObjectURL(blob);
        const wrap = document.createElement('div');
        wrap.className = 'media-wrap';
        applyMediaViewerTheme();
        const audio = document.createElement('audio');
        audio.src = mediaUrl;
        audio.controls = true;
        audio.autoplay = true;
        document.body.innerHTML = '';
        document.body.appendChild(wrap);
        wrap.appendChild(audio);
        return;
      }
      if (type.startsWith('video/')) {
        const blob = await resp.blob();
        const mediaUrl = URL.createObjectURL(blob);
        const wrap = document.createElement('div');
        wrap.className = 'media-wrap';
        applyMediaViewerTheme();
        const video = document.createElement('video');
        video.src = mediaUrl;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        document.body.innerHTML = '';
        document.body.appendChild(wrap);
        wrap.appendChild(video);
        return;
      }
      if (type.startsWith('image/')) {
        const blob = await resp.blob();
        const mediaUrl = URL.createObjectURL(blob);
        const wrap = document.createElement('div');
        wrap.className = 'media-wrap';
        applyMediaViewerTheme();
        const img = document.createElement('img');
        img.src = mediaUrl;
        img.alt = '';
        document.body.innerHTML = '';
        document.body.appendChild(wrap);
        wrap.appendChild(img);
        return;
      }
      if (type.includes('application/pdf')) {
        const blob = await resp.blob();
        const mediaUrl = URL.createObjectURL(blob);
        const embed = document.createElement('embed');
        embed.src = mediaUrl;
        embed.type = 'application/pdf';
        document.body.innerHTML = '';
        document.body.appendChild(embed);
        return;
      }
      const html = await resp.text();
      document.open();
      document.write(html);
      document.close();
    }

    pwForm.addEventListener('submit', event => {
      event.preventDefault();
      const password = pwInput.value || '';
      if (!password) {
        setPasswordHint('請先輸入密碼');
        pwInput.focus();
        return;
      }
      submitPassword(password).catch(err => {
        setPasswordHint(err.message || '密碼驗證失敗');
      });
    });

    openPreview().catch(() => {
      msg.textContent = '載入預覽失敗，請稍後再試。';
    });
  </script>
</body>
</html>`;
}

function sendResolvedPreview(res, item, preview, previewIndex, options = {}) {
  const collection = options.collection || 'scenario';
  const canEditTxt = !!options.canEditTxt;
  const disableContextMenu = !!options.disableContextMenu;
  const scrollMemoryKey = `${sanitizeCollectionKey(collection)}:${String(item?.id || '')}:${String(previewIndex)}:${String(preview.file?.key || preview.filename || preview.file?.name || preview.type || 'preview')}`;
  const previewSavePath = canEditTxt ? withCollection(`/api/preview/${encodeURIComponent(item.id)}/${previewIndex}`, collection) : '';
  if (preview.type === 'media') {
    res.type(preview.mimeType || getPreviewMediaMimeType(path.extname(preview.filename || '')));
    if (preview.abs) return res.sendFile(preview.abs);
  }
  if (preview.type === 'pdf') {
    setInlinePdfHeaders(res, preview.filename);
    if (preview.abs) return res.sendFile(preview.abs);
  }
  if (preview.type === 'html-file') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(disableContextMenu ? applyNoContextMenuToHtml(preview.text || '') : (preview.text || ''));
  }
  const textEditMeta = preview.file?.ext === '.txt'
    ? getTextEditMeta(item, preview.file.key, preview.file.abs)
    : null;
  const previewHistoryPath = canEditTxt ? withCollection(`/api/preview/${encodeURIComponent(item.id)}/${previewIndex}/history`, collection) : '';
  const txtReloadPath = canEditTxt && preview.file?.ext === '.txt'
    ? withCollection(`/api/preview/${encodeURIComponent(item.id)}/${previewIndex}/text`, collection)
    : '';
  preview.html = preview.file?.ext === '.docx'
    ? renderDocxPreviewPage(item, preview.file, preview.blocks || [], {
        disableContextMenu,
        layoutMode: preview.layoutMode,
        scrollMemoryKey
      })
    : renderTextPreviewPage(item, preview.file, preview.text, {
        saveUrl: previewSavePath,
        historyUrl: previewHistoryPath,
        createdAtLabel: textEditMeta ? formatDateTimeToSecond(textEditMeta.createdAt) : '',
        updatedAtLabel: textEditMeta ? formatDateTimeToSecond(textEditMeta.savedAt) : '',
        updatedByLabel: textEditMeta?.savedBy || '',
        selectedEncoding: preview.selectedEncoding || 'auto',
        detectedEncoding: preview.textEncoding || '',
        txtReloadUrl: txtReloadPath,
        scrollMemoryKey,
        canEditTxt,
        disableContextMenu
      });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(preview.html);
}

function sendTxtPreviewPayload(res, item, preview, options = {}) {
  const textEditMeta = preview.file?.ext === '.txt'
    ? getTextEditMeta(item, preview.file.key, preview.file.abs)
    : null;
  return res.json({
    ok: true,
    text: preview.text || '',
    filename: preview.file?.name || '',
    encoding: preview.textEncoding || 'utf8',
    selectedEncoding: preview.selectedEncoding || 'auto',
    updatedAtLabel: textEditMeta ? formatDateTimeToSecond(textEditMeta.savedAt) : '',
    updatedByLabel: textEditMeta?.savedBy || ''
  });
}

app.get('/preview-open/:id/:index', (req, res) => {
  if (req.params.index === 'list') {
    return res.status(404).send('Not found');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(renderPreviewOpenShell(req.params.id, req.params.index, getC(req)));
});

app.get('/preview-share/:token', (req, res) => {
  try {
    const cfg = readCfg();
    if (!ensureTrustedPublicShareRequest(req, res, cfg)) return;
    const resolved = resolveSharedPreview(cfg, req.params.token);
    if (!resolved) return res.status(404).send('找不到分享的線上閱覽檔案');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderPreviewShareShell(req.params.token, {
      meta: getPreviewShareMeta(req, cfg, resolved)
    }));
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get('/api/preview-share/:token', (req, res) => {
  try {
    const cfg = readCfg();
    if (!ensureTrustedPublicShareRequest(req, res, cfg, 'json')) return;
    const resolved = resolveSharedPreview(cfg, req.params.token);
    if (!resolved) return res.status(404).json({ error: '找不到分享的線上閱覽檔案' });
    const accessState = getPreviewShareAccessState(cfg, resolved.share, req);
    if (!accessState.ok) {
      return res.status(accessState.status || 403).json({
        error: accessState.error || '無法存取這個公開連結',
        requiresPassword: !!accessState.requiresPassword
      });
    }
    return sendResolvedPreview(res, resolved.item, resolved.preview, resolved.previewIndex, {
      collection: resolved.share.collection,
      canEditTxt: false,
      disableContextMenu: true
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/preview/:id/:index', auth, (req, res) => {
  try {
    const collection = getC(req);
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
    if (collectionDenied) return res.status(403).json(collectionDenied);
    if (!hasRolePermission(req.authUser, 'onlinePreview', collection)) return res.status(403).json({ error: '你沒有權限使用線上閱覽。' });
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '找不到項目。' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });
    const previewIndex = Number(req.params.index) || 0;
    const preview = resolvePreview(item, previewIndex, collection, req.query?.encoding);
    if (!preview) return res.status(415).json({ error: '這個檔案類型不支援線上閱覽。' });
    return sendResolvedPreview(res, item, preview, previewIndex, {
      collection,
      canEditTxt: preview.file?.ext === '.txt' && canEditTxtPreview(req.authUser, collection)
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/preview/:id/:index/text', auth, (req, res) => {
  try {
    const collection = getC(req);
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
    if (collectionDenied) return res.status(403).json(collectionDenied);
    if (!canEditTxtPreview(req.authUser, collection)) return res.status(403).json({ error: '你沒有編輯 TXT 的權限。' });
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '找不到項目。' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });
    const previewIndex = Number(req.params.index) || 0;
    const preview = resolvePreview(item, previewIndex, collection, req.query?.encoding);
    if (!preview || preview.file?.ext !== '.txt') return res.status(415).json({ error: '這個檔案不是可切換編碼的 TXT。' });
    return sendTxtPreviewPayload(res, item, preview, { collection });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

function renameTxtPreviewFile(collection, item, file, requestedName = '') {
  const raw = String(requestedName || '').trim();
  if (!raw) return { key: file.key, name: file.name, abs: file.abs };
  const currentExt = path.extname(file.name || file.key || '.txt') || '.txt';
  const parsed = path.parse(raw);
  const nextBase = sanitizeDownloadName(parsed.name || raw, path.parse(file.name || 'document').name || 'document');
  const finalName = `${nextBase}${currentExt}`;
  if (finalName === file.name) return { key: file.key, name: file.name, abs: file.abs };
  const currentDir = path.posix.dirname(file.key || '');
  const nextKey = (currentDir && currentDir !== '.') ? path.posix.join(currentDir, finalName) : finalName;
  const nextAbs = path.join(UPLOADS, nextKey);
  if (fs.existsSync(nextAbs)) throw new Error('已存在同名 TXT 檔案，請改用其他檔名。');
  fs.renameSync(file.abs, nextAbs);

  const downloadFiles = normalizeDownloadFiles(item);
  item.downloadFiles = downloadFiles.map(entry => {
    if (entry.key !== file.key) return entry;
    const currentRel = typeof entry.relativePath === 'string' && entry.relativePath.trim()
      ? entry.relativePath.trim().replace(/\\/g, '/')
      : '';
    const nextRelativePath = currentRel
      ? path.posix.join(path.posix.dirname(currentRel), finalName).replace(/^\.\/+/, '')
      : finalName;
    return { ...entry, key: nextKey, name: finalName, relativePath: nextRelativePath };
  });
  if (item.downloadKey === file.key) item.downloadKey = nextKey;
  if (item.downloadName === file.name || item.downloadFiles.length === 1) item.downloadName = finalName;
  if (item.textEditMeta && typeof item.textEditMeta === 'object' && item.textEditMeta[file.key]) {
    item.textEditMeta[nextKey] = item.textEditMeta[file.key];
    delete item.textEditMeta[file.key];
  }
  moveTextHistoryVersions(collection, item?.id, file.key, nextKey);
  return { key: nextKey, name: finalName, abs: nextAbs };
}

app.put('/api/preview/:id/:index', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!canEditTxtPreview(req.authUser, collection)) return res.status(403).json({ error: '你沒有編輯 TXT 的權限。' });
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
    if (collectionDenied) return res.status(403).json(collectionDenied);
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '找不到項目。' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });
    const file = getPreviewableFiles(item, collection)[Number(req.params.index) || 0];
    if (!file || file.ext !== '.txt') {
      return res.status(415).json({ error: '目前只能編輯 TXT 預覽檔案。' });
    }
    if (!fs.existsSync(file.abs)) return res.status(404).json({ error: '找不到 TXT 檔案。' });
    const renamedFile = renameTxtPreviewFile(collection, item, file, req.body?.filename);
    const requestedEncoding = normalizeTextEncodingChoice(req.body?.encoding);
    const sourceMeta = readTextFile(renamedFile.abs, requestedEncoding);
    const nextText = typeof req.body?.text === 'string' ? req.body.text : '';
    const writeMeta = requestedEncoding
      ? {
          encoding: requestedEncoding,
          bom: sourceMeta.encoding === requestedEncoding ? sourceMeta.bom : null
        }
      : sourceMeta;
    fs.writeFileSync(renamedFile.abs, encodeTextBuffer(nextText, writeMeta));
    item.textEditMeta = item.textEditMeta && typeof item.textEditMeta === 'object' ? item.textEditMeta : {};
    const savedAt = new Date();
    const historyVersions = appendTextHistoryVersion(collection, item, renamedFile.key, {
      savedAt: savedAt.toISOString(),
      savedById: req.authUser?.id || '',
      savedBy: req.authUser?.username || '',
      mode: req.body?.saveMode === 'auto' ? 'auto' : 'manual',
      filename: renamedFile.name,
      text: nextText
    });
    item.textEditMeta[renamedFile.key] = {
      savedAt: savedAt.toISOString(),
      savedById: req.authUser?.id || '',
      savedBy: req.authUser?.username || ''
    };
    saveCat(cat, collection);
    return res.json({
      ok: true,
      filename: renamedFile.name,
      encoding: writeMeta.encoding || sourceMeta.encoding || 'utf8',
      historyCount: historyVersions.length,
      updatedAt: savedAt.toISOString(),
      updatedAtLabel: formatDateTimeToSecond(savedAt),
      updatedByLabel: req.authUser?.username || ''
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════
//  ADMIN API（需要 Bearer token）
// ══════════════════════════════════════════════════

// 取得 TXT 編輯記錄
app.get('/api/preview/:id/:index/history', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!canEditTxtPreview(req.authUser, collection)) return res.status(403).json({ error: '你沒有編輯 TXT 的權限。' });
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
    if (collectionDenied) return res.status(403).json(collectionDenied);
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '找不到項目。' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });
    const file = getPreviewableFiles(item, collection)[Number(req.params.index) || 0];
    if (!file || file.ext !== '.txt') return res.status(415).json({ error: '目前只能讀取 TXT 的編輯記錄。' });
    return res.json({ versions: readTextHistoryVersions(collection, item.id, file.key).map(version => ({ ...version, savedAtLabel: formatDateTimeToSecond(version.savedAt) })) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.delete('/api/preview/:id/:index/history', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!canEditTxtPreview(req.authUser, collection)) return res.status(403).json({ error: '你沒有編輯 TXT 的權限。' });
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
    if (collectionDenied) return res.status(403).json(collectionDenied);
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '找不到項目。' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限存取這個項目。' });
    const file = getPreviewableFiles(item, collection)[Number(req.params.index) || 0];
    if (!file || file.ext !== '.txt') return res.status(415).json({ error: '目前只能清除 TXT 的編輯記錄。' });
    writeTextHistoryVersions(collection, item.id, file.key, []);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.put('/api/password', auth, (req, res) => {
  try {
    const cfg = readCfg();
    cfg.pwdHash = sha256(req.body.password || '');
    saveCfg(cfg);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth-users', auth, (req, res) => {
  try {
    const cfg = readCfg();
    const roleConfig = getGlobalRoleConfig(cfg);
    const allUsers = normalizeAuthUsers(cfg.users, cfg.pwdHash);
    const users = (req.authUser?.role === 'owner' ? allUsers : allUsers.filter(user => user.id === req.authUser?.id)).map(user => ({
      id: user.id,
      username: user.username,
      role: user.role,
      roleLabel: roleConfig[user.role]?.label || user.role,
      hasPassword: !!user.passwordHash,
      googleEmail: user.googleEmail || '',
      googleOnly: !!user.googleOnly
    }));
    res.json({
      users,
      currentUser: req.authUser ? { id: req.authUser.id, username: req.authUser.username, role: req.authUser.role } : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/auth-users', auth, (req, res) => {
  try {
    const cfg = readCfg();
    const roleConfig = getGlobalRoleConfig(cfg);
    const allowedRoles = new Set(Object.keys(roleConfig));
    const defaultNonOwnerRole = getDefaultNonOwnerRoleKey(roleConfig);
    const incoming = Array.isArray(req.body?.users) ? req.body.users : [];
    const existingUsers = normalizeAuthUsers(cfg.users, cfg.pwdHash);
    const existingMap = new Map(existingUsers.map(user => [user.id, user]));
    let nextUsers = [];
    if (req.authUser?.role === 'owner') {
      if (!incoming.length) return res.status(400).json({ error: '至少要保留一位使用者。' });
      const seenNames = new Set();
      nextUsers = incoming.map((entry, idx) => {
        const username = String(entry?.username || '').trim();
        if (!username) throw new Error(`第 ${idx + 1} 位使用者的名稱不得為空白。`);
        if (seenNames.has(username)) throw new Error(`使用者名稱「${username}」重複，請改用其他名稱。`);
        seenNames.add(username);
        const id = typeof entry?.id === 'string' && entry.id.trim() ? entry.id.trim() : makeAuthUserId();
        const previous = existingMap.get(id);
        const password = typeof entry?.password === 'string' ? entry.password : '';
        const passwordHash = password ? sha256(password) : (previous?.passwordHash || '');
        if (!passwordHash) throw new Error(`第 ${idx + 1} 位使用者需要設定密碼。`);
        const requestedRole = sanitizeRoleKey(entry?.role);
        let role = requestedRole && allowedRoles.has(requestedRole)
          ? requestedRole
          : (idx === 0 ? 'owner' : defaultNonOwnerRole);
        if (idx > 0 && !role) throw new Error('請為這位使用者設定有效的角色。');
        const googleEmail = String(entry?.googleEmail || '').trim().toLowerCase();
        const googleEmailNormalized = normalizeGoogleEmail(googleEmail);
        const googleOnly = !!entry?.googleOnly;
        if (googleOnly && !googleEmail) throw new Error(`第 ${idx + 1} 個帳號已設為僅限 Google 登入，不能清空 Google 信箱`);
        if (googleEmailNormalized && incoming.some((other, otherIdx) => otherIdx !== idx && normalizeGoogleEmail(other?.googleEmail || '') === googleEmailNormalized)) {
          throw new Error(`第 ${idx + 1} 位使用者的 Google 信箱已被其他使用者使用。`);
        }
        return {
          id,
          username,
          passwordHash,
          role,
          googleEmail,
          googleOnly
        };
      });
      if (nextUsers[0]?.role !== 'owner') throw new Error('第一組帳號必須固定為群主');
      const ownerCount = nextUsers.filter(user => user.role === 'owner').length;
      if (ownerCount !== 1) throw new Error('必須且只能保留一位擁有者。');
    } else {
      if (incoming.length !== 1) return res.status(400).json({ error: '你只能修改自己的帳號資料' });
      const self = existingUsers.find(user => user.id === req.authUser?.id);
      if (!self) return res.status(403).json({ error: '找不到目前登入的使用者。' });
      const entry = incoming[0] || {};
      if (String(entry?.id || '') !== self.id) return res.status(403).json({ error: '你只能修改自己的帳號資料' });
      const username = String(entry?.username || '').trim();
      if (!username) throw new Error('使用者名稱不得為空白。');
      if (existingUsers.some(user => user.id !== self.id && user.username === username)) throw new Error(`使用者名稱「${username}」已被使用。`);
      const password = typeof entry?.password === 'string' ? entry.password : '';
      const passwordHash = password ? sha256(password) : self.passwordHash;
      const googleEmail = String(entry?.googleEmail || '').trim().toLowerCase();
      const googleEmailNormalized = normalizeGoogleEmail(googleEmail);
      if (!passwordHash) throw new Error('請設定密碼。');
      if (self.googleOnly && !googleEmail) throw new Error('此帳號目前僅限 Google 登入，不能清空 Google 信箱');
      if (googleEmailNormalized && existingUsers.some(user => user.id !== self.id && normalizeGoogleEmail(user.googleEmail) === googleEmailNormalized)) {
        throw new Error('此 Google 信箱已被其他帳號綁定');
      }
      nextUsers = existingUsers.map(user => user.id === self.id ? {
        ...user,
        username,
        passwordHash,
        googleEmail
      } : user);
    }
    cfg.users = nextUsers;
    saveCfg(cfg);
    const currentUser = nextUsers.find(user => user.id === req.authUser?.id) || null;
    res.json({
      ok: true,
      users: (req.authUser?.role === 'owner' ? nextUsers : nextUsers.filter(user => user.id === req.authUser?.id)).map(user => ({ id: user.id, username: user.username, role: user.role, roleLabel: roleConfig[user.role]?.label || user.role, hasPassword: !!user.passwordHash, googleEmail: user.googleEmail || '', googleOnly: !!user.googleOnly })),
      currentUser: currentUser ? { id: currentUser.id, username: currentUser.username, role: currentUser.role } : null
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/role-config', auth, (req, res) => {
  try {
    const cfg = readCfg();
    const collection = getC(req);
    res.json({
      roleConfig: getVisibleRoleConfig(cfg, collection),
      allRoleConfig: getGlobalRoleConfig(cfg),
      currentUser: req.authUser ? { id: req.authUser.id, username: req.authUser.username, role: req.authUser.role } : null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/role-config', auth, (req, res) => {
  try {
    const cfg = readCfg();
    const collection = getC(req);
    const current = getRoleConfig(cfg, collection);
    const currentVisible = getVisibleRoleConfig(cfg, collection);
    const incoming = normalizeRoleConfig(req.body?.roleConfig || {});
    const incomingAll = normalizeRoleConfig(req.body?.allRoleConfig || cfg.roleConfig || {});
    const visibleKeys = new Set(getAccessibleRoleKeysForCollection(collection, cfg));
    const role = req.authUser?.role || 'admin';
    const globalRoleConfig = getGlobalRoleConfig(cfg);
    if (role === 'owner') {
      cfg.roleConfig = incomingAll;
      cfg.collectionRoleConfig = cfg.collectionRoleConfig && typeof cfg.collectionRoleConfig === 'object' ? cfg.collectionRoleConfig : {};
      const nextCollectionRoles = { ...(cfg.collectionRoleConfig[collection] || {}) };
      Object.keys(currentVisible).forEach(roleKey => {
        if (!visibleKeys.has(roleKey)) return;
        const source = incoming[roleKey] || current[roleKey] || globalRoleConfig[roleKey];
        if (!source) return;
        nextCollectionRoles[roleKey] = {
          label: (incomingAll[roleKey]?.label || globalRoleConfig[roleKey]?.label || source.label || '').trim(),
          permissions: normalizeRolePermissions(source.permissions, globalRoleConfig[roleKey]?.permissions || getDefaultRoleConfig().admin.permissions)
        };
      });
      Object.keys(incoming).forEach(roleKey => {
        if (!visibleKeys.has(roleKey)) return;
        const source = incoming[roleKey];
        if (!source) return;
        nextCollectionRoles[roleKey] = {
          label: (incomingAll[roleKey]?.label || source.label || '').trim(),
          permissions: normalizeRolePermissions(source.permissions, globalRoleConfig[roleKey]?.permissions || getDefaultRoleConfig().admin.permissions)
        };
      });
      cfg.collectionRoleConfig[collection] = nextCollectionRoles;
      saveCfg(cfg);
      return res.json({
        ok: true,
        roleConfig: getVisibleRoleConfig(cfg, collection),
        allRoleConfig: getGlobalRoleConfig(cfg)
      });
    }
    if (!currentVisible[role]) return res.status(403).json({ error: '找不到目前身份組' });
    const nextGlobal = getGlobalRoleConfig(cfg);
    nextGlobal[role].label = incomingAll[role]?.label || incoming[role]?.label || nextGlobal[role].label;
    cfg.roleConfig = nextGlobal;
    saveCfg(cfg);
    return res.json({
      ok: true,
      roleConfig: getVisibleRoleConfig(cfg, collection),
      allRoleConfig: getGlobalRoleConfig(cfg)
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/ui-preferences', auth, (req, res) => {
  try {
    const cfg = readCfg();
    const allPrefs = getUserUiPrefs(cfg);
    const userId = req.authUser?.id || '';
    res.json({
      uiPreferences: allPrefs[userId] || { manageDiscOrderByCollection: {} }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/ui-preferences', auth, (req, res) => {
  try {
    const cfg = readCfg();
    const allPrefs = getUserUiPrefs(cfg);
    const userId = req.authUser?.id || '';
    if (!userId) return res.status(400).json({ error: '找不到目前登入帳號' });
    const incoming = req.body?.uiPreferences || {};
    const next = normalizeUserUiPrefs({ [userId]: incoming });
    allPrefs[userId] = next[userId] || { manageDiscOrderByCollection: {} };
    cfg.userUiPrefs = allPrefs;
    saveCfg(cfg);
    res.json({ ok: true, uiPreferences: allPrefs[userId] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/collections', (req, res) => {
  try {
    const cfg = readCfg();
    const role = getViewerRole(req);
    const collections = getCollectionsConfig(cfg)
      .filter(item => canAccessCollectionByRole(item.key, role, cfg))
      .map(item => ({
      key: item.key,
      label: item.label,
      mode: normalizeCollectionMode(item.mode),
      permission: normalizeItemPermission(item.permission)
    }));
    res.json({ collections });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/collections-config', auth, (req, res) => {
  try {
    if (req.authUser?.role !== 'owner') {
      return res.status(403).json({ error: '你沒有權限管理資料夾頁籤' });
    }
    const cfg = readCfg();
    res.json({ collections: getCollectionsConfig(cfg) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/preview-share-links', auth, (req, res) => {
  try {
    if (req.authUser?.role !== 'owner') {
      return res.status(403).json({ error: '只有站主可以管理公開連結' });
    }
    const cfg = readCfg();
    const collection = getC(req);
    return res.json({
      shares: listPreviewSharesForCollection(cfg, collection, req)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/preview-share-links/:token/status', auth, (req, res) => {
  try {
    if (req.authUser?.role !== 'owner') {
      return res.status(403).json({ error: '只有站主可以管理公開連結' });
    }
    const cfg = readCfg();
    const collection = getC(req);
    const share = getPreviewShareEntry(cfg, req.params.token);
    if (!share || share.collection !== collection) return res.status(404).json({ error: '找不到這筆公開連結' });
    cfg.previewShareLinks[share.token] = {
      ...(cfg.previewShareLinks[share.token] || {}),
      enabled: req.body?.enabled !== false
    };
    saveCfg(cfg);
    return res.json({
      ok: true,
      shares: listPreviewSharesForCollection(readCfg(), collection, req)
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/preview-share-links/:token/password', auth, (req, res) => {
  try {
    if (req.authUser?.role !== 'owner') {
      return res.status(403).json({ error: '只有站主可以管理公開連結' });
    }
    const cfg = readCfg();
    const collection = getC(req);
    const share = getPreviewShareEntry(cfg, req.params.token);
    if (!share || share.collection !== collection) return res.status(404).json({ error: '找不到這筆公開連結' });
    const password = String(req.body?.password || '');
    if (!password) return res.status(400).json({ error: '請輸入密碼' });
    cfg.previewShareLinks[share.token] = {
      ...(cfg.previewShareLinks[share.token] || {}),
      passwordHash: sha256(password)
    };
    saveCfg(cfg);
    return res.json({
      ok: true,
      shares: listPreviewSharesForCollection(readCfg(), collection, req)
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/preview-share-links/:token/password', auth, (req, res) => {
  try {
    if (req.authUser?.role !== 'owner') {
      return res.status(403).json({ error: '只有站主可以管理公開連結' });
    }
    const cfg = readCfg();
    const collection = getC(req);
    const share = getPreviewShareEntry(cfg, req.params.token);
    if (!share || share.collection !== collection) return res.status(404).json({ error: '找不到這筆公開連結' });
    cfg.previewShareLinks[share.token] = {
      ...(cfg.previewShareLinks[share.token] || {}),
      passwordHash: ''
    };
    saveCfg(cfg);
    return res.json({
      ok: true,
      shares: listPreviewSharesForCollection(readCfg(), collection, req)
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/preview-share-links/:token', auth, (req, res) => {
  try {
    if (req.authUser?.role !== 'owner') {
      return res.status(403).json({ error: '只有站主可以管理公開連結' });
    }
    const cfg = readCfg();
    const collection = getC(req);
    const share = getPreviewShareEntry(cfg, req.params.token);
    if (!share || share.collection !== collection) return res.status(404).json({ error: '找不到這筆公開連結' });
    delete cfg.previewShareLinks[share.token];
    saveCfg(cfg);
    return res.json({
      ok: true,
      shares: listPreviewSharesForCollection(readCfg(), collection, req)
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/collections-config', auth, (req, res) => {
  try {
    if (req.authUser?.role !== 'owner') {
      return res.status(403).json({ error: '你沒有權限管理資料夾頁籤' });
    }
    const cfg = readCfg();
    const incoming = Array.isArray(req.body?.collections) ? req.body.collections : [];
    const nextCollections = normalizeCollectionsConfig(incoming);
    if (!nextCollections.length) return res.status(400).json({ error: '至少需要保留一個資料庫頁籤' });
    if (!nextCollections.some(item => item.key === 'scenario')) return res.status(400).json({ error: '至少需要保留資料庫頁籤' });
    const currentCollections = getCollectionsConfig(cfg);
    const currentMap = new Map(currentCollections.map(item => [item.key, item]));
    const invalidModeChange = nextCollections.find(item => currentMap.has(item.key) && currentMap.get(item.key).mode !== item.mode);
    if (invalidModeChange) return res.status(400).json({ error: `資料庫「${invalidModeChange.label}」建立後不可變更模式` });
    const removedCollections = currentCollections
      .filter(item => item.key !== 'scenario' && !nextCollections.some(next => next.key === item.key))
      .map(item => item.key);
    cfg.collections = nextCollections;
    saveCfg(cfg);
    removedCollections.forEach(key => deleteCollectionStorage(key, { collections: currentCollections }));
    cleanupPreviewShareLinksInConfig();
    res.json({ ok: true, collections: cfg.collections });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 儲存前台設定（標題、副標題、頁尾）
app.put('/api/site', auth, (req, res) => {
  try {
    if (req.authUser?.role !== 'owner') return res.status(403).json({ error: '只有站主可以編輯前台外觀' });
    const collection = getC(req);
    const cat = readCat(collection);
    cat.sc = req.body;
    saveCat(cat, collection);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cfg-google', auth, (req, res) => {
  try {
    if (req.authUser?.role !== 'owner') return res.status(403).json({ error: '只有站主可以設定 Google Client ID' });
    const googleClientId = String(req.body?.googleClientId || '').trim();
    saveCfg({ googleClientId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 上傳新項目 POST /api/upload/:itemId
app.put('/api/tags', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'editTags', collection)) return res.status(403).json({ error: '你沒有權限編輯標籤庫' });
    const cat = readCat(collection);
    cat.tags = Array.isArray(req.body.tags) ? req.body.tags : [];
    if (Array.isArray(req.body.items)) {
      const tagMap = new Map(req.body.items.map(item => [item.id, Array.isArray(item.tags) ? item.tags : []]));
      cat.items = (cat.items || []).map(item => tagMap.has(item.id)
        ? { ...item, tags: tagMap.get(item.id) }
        : item);
    }
    saveCat(cat, collection);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/categories', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'editCategories', collection)) return res.status(403).json({ error: '你沒有權限編輯類別庫' });
    const cat = readCat(collection);
    cat.categories = Array.isArray(req.body.categories) ? req.body.categories : [];
    if (Array.isArray(req.body.items)) {
      const catMap = new Map(req.body.items.map(item => [
        item.id,
        Array.isArray(item.categories)
          ? item.categories.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean)
          : (typeof item.category === 'string' && item.category.trim() ? [item.category.trim()] : [])
      ]));
      cat.items = (cat.items || []).map(item => catMap.has(item.id)
        ? { ...item, categories: catMap.get(item.id), category: catMap.get(item.id)[0] || '' }
        : item);
    }
    saveCat(cat, collection);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/upload/:itemId', auth,
  upload.fields([
    { name: 'previews', maxCount: 30 },
    { name: 'file',     maxCount: 1  },
    { name: 'files',    maxCount: 500 }
  ]),
  async (req, res) => {
    try {
      const collection = getC(req);
      if (!hasRolePermission(req.authUser, 'uploadItems', collection)) return res.status(403).json({ error: '你沒有權限使用上傳功能' });
      const id  = req.params.itemId;
      const prs = req.files?.previews || [];
      const relativePaths = Array.isArray(req.body?.['relativePaths[]'])
        ? req.body['relativePaths[]']
        : (Array.isArray(req.body?.relativePaths) ? req.body.relativePaths : (req.body?.['relativePaths[]'] ? [req.body['relativePaths[]']] : (req.body?.relativePaths ? [req.body.relativePaths] : [])));
      const dlFiles = [...(req.files?.files || []), ...(req.files?.file || [])].map((file, idx) => ({
        key: buildStoredKey(collection, id, file.filename),
        path: file.path,
        name: file.originalname,
        size: file.size,
        relativePath: relativePaths[idx] || file.originalname
      }));
      const previewKeys = prs.map(f => buildStoredKey(collection, id, f.filename));
      const subtitle = String(req.body.subtitle || req.body.translatedTitle || '').trim();
      const creator = String(req.body.creator || req.body.author || '').trim();
      const sourceUrl = String(req.body.sourceUrl || req.body.originalUrl || '').trim();
      const coverFocusX = Number.isFinite(Number(req.body.coverFocusX)) ? Math.max(0, Math.min(100, Number(req.body.coverFocusX))) : 50;
      const coverFocusY = Number.isFinite(Number(req.body.coverFocusY)) ? Math.max(0, Math.min(100, Number(req.body.coverFocusY))) : 50;
      const download = persistDownloadFiles(id, dlFiles, subtitle || req.body.title || 'download', collection);

      let tags = [];
      try { tags = JSON.parse(req.body.tags || '[]'); } catch {}
      let categories = [];
      try { categories = JSON.parse(req.body.categories || '[]'); } catch {}
      if (!Array.isArray(categories)) categories = [];
      categories = categories.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean);

      const item = {
        id,
        title:       req.body.title       || '',
        creator,
        author:      creator,
        subtitle,
        translatedTitle: subtitle,
        permission: normalizeItemPermission(req.body.permission),
        categories,
        category:    categories[0] || req.body.category || '',
        tags,
        description: req.body.description || '',
        sourceUrl,
        originalUrl: sourceUrl,
        coverFocusX,
        coverFocusY,
        coverKey:    previewKeys[0] || null,
        previewKeys,
        downloadKey: download.downloadKey,
        downloadName: download.downloadName,
        downloadFiles: download.downloadFiles,
        downloadUrl: download.downloadKey ? null : (req.body.downloadUrl || null),
        createdAt:   new Date().toISOString()
      };

      await ensureThumbsForKeys([...previewKeys, ...download.downloadFiles.map(file => file.key)]);

      const cat = readCat(collection);
      cat.items.push(item);
      saveCat(cat, collection);
      res.json({ ok: true, item });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  }
);

// 編輯項目 metadata
app.put('/api/items/:id', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'editItemInfo', collection)) return res.status(403).json({ error: '你沒有權限編輯項目資訊' });
    const cat = readCat(collection);
    const it  = cat.items.find(i => i.id === req.params.id);
    if (!it) return res.status(404).json({ error: '項目不存在' });
    if (!canAccessItemByRole(it, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限修改這個項目' });

    const { title, creator, author, subtitle, translatedTitle, category, categories, tags, description, sourceUrl, originalUrl, permission, coverFocusX, coverFocusY } = req.body;
    const nextCategories = Array.isArray(categories)
      ? categories.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean)
      : (typeof category === 'string' && category.trim() ? [category.trim()] : it.categories || []);
    const nextCreator = String(creator || author || '').trim();
    const nextSubtitle = String(subtitle || translatedTitle || '').trim();
    const nextSourceUrl = String(sourceUrl || originalUrl || '').trim();
    const nextCoverFocusX = Number.isFinite(Number(coverFocusX)) ? Math.max(0, Math.min(100, Number(coverFocusX))) : (Number.isFinite(Number(it.coverFocusX)) ? Number(it.coverFocusX) : 50);
    const nextCoverFocusY = Number.isFinite(Number(coverFocusY)) ? Math.max(0, Math.min(100, Number(coverFocusY))) : (Number.isFinite(Number(it.coverFocusY)) ? Number(it.coverFocusY) : 50);
    Object.assign(it, {
      title,
      creator: nextCreator,
      author: nextCreator,
      subtitle: nextSubtitle,
      translatedTitle: nextSubtitle,
      permission: normalizeItemPermission(permission || it.permission),
      categories: nextCategories,
      category: nextCategories[0] || '',
      tags: tags || it.tags,
      description,
      sourceUrl: nextSourceUrl,
      originalUrl: nextSourceUrl,
      coverFocusX: nextCoverFocusX,
      coverFocusY: nextCoverFocusY
    });

    saveCat(cat, collection);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/items/:id/previews', auth, upload.array('previews', 30), async (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'editItemInfo', collection)) return res.status(403).json({ error: '你沒有權限編輯項目資訊' });
    const cat = readCat(collection);
    const it  = cat.items.find(i => i.id === req.params.id);
    if (!it) return res.status(404).json({ error: '項目不存在' });
    if (!canAccessItemByRole(it, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限修改這個項目' });

    let order = [];
    try { order = JSON.parse(req.body.order || '[]'); } catch {}
    if (!Array.isArray(order)) order = [];

    const newFiles = req.files || [];
    const newKeys = newFiles.map(f => buildStoredKey(collection, req.params.id, f.filename));
    const keptPreviewKeys = [];
    const keptPreviewUrls = [];
    const usedNewKeys = new Set();
    const downloadFileKeys = normalizeDownloadFiles(it).map(file => file.key).filter(Boolean);

    const allowedKeySet = new Set([...(it.previewKeys || []), it.coverKey, ...downloadFileKeys].filter(Boolean));
    const allowedUrlSet = new Set([...(it.previewUrls || []), it.coverUrl].filter(Boolean));

    order.forEach(entry => {
      if (!entry || typeof entry !== 'object') return;
      if (entry.type === 'key' && allowedKeySet.has(entry.value)) keptPreviewKeys.push(entry.value);
      if (entry.type === 'url' && allowedUrlSet.has(entry.value)) keptPreviewUrls.push(entry.value);
      if (entry.type === 'new') {
        const key = newKeys[Number(entry.value)];
        if (key) {
          keptPreviewKeys.push(key);
          usedNewKeys.add(key);
        }
      }
    });

    const removedKeys = (it.previewKeys || []).filter(key => !keptPreviewKeys.includes(key) && !downloadFileKeys.includes(key));
    removedKeys.forEach(removeStoredFile);
    newKeys.filter(key => !usedNewKeys.has(key)).forEach(removeStoredFile);

    it.previewKeys = keptPreviewKeys;
    it.previewUrls = keptPreviewUrls;
    it.coverKey = keptPreviewKeys[0] || null;
    it.coverUrl = it.coverKey ? null : (keptPreviewUrls[0] || null);

    await ensureThumbsForKeys(keptPreviewKeys);

    saveCat(cat, collection);
    cleanupPreviewShareLinksInConfig();
    res.json({ ok: true, item: it });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/items/:id/file', auth, upload.fields([
  { name: 'file',  maxCount: 1  },
  { name: 'files', maxCount: 500 }
]), async (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'editItemInfo', collection)) return res.status(403).json({ error: '你沒有權限編輯項目資訊' });
    const cat = readCat(collection);
    const it  = cat.items.find(i => i.id === req.params.id);
    if (!it) return res.status(404).json({ error: '項目不存在' });
    if (!canAccessItemByRole(it, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限修改這個項目' });
    let keptKeys = [];
    try { keptKeys = JSON.parse(req.body.keptKeys || '[]'); } catch {}
    if (!Array.isArray(keptKeys)) keptKeys = [];
    let order = [];
    try { order = JSON.parse(req.body.order || '[]'); } catch {}
    if (!Array.isArray(order)) order = [];
    const relativePaths = Array.isArray(req.body?.['relativePaths[]'])
      ? req.body['relativePaths[]']
      : (Array.isArray(req.body?.relativePaths) ? req.body.relativePaths : (req.body?.['relativePaths[]'] ? [req.body['relativePaths[]']] : (req.body?.relativePaths ? [req.body.relativePaths] : [])));

    const existingFiles = normalizeDownloadFiles(it);
    const uploadFiles = [...(req.files?.files || []), ...(req.files?.file || [])].map((file, idx) => ({
      key: buildStoredKey(collection, req.params.id, file.filename),
      path: file.path,
      name: file.originalname,
      size: file.size,
      relativePath: relativePaths[idx] || file.originalname
    }));
    const existingMap = new Map(existingFiles.map(file => [file.key, file]));
    let nextFiles = [];

    if (order.length) {
      const usedExisting = new Set();
      const usedUploads = new Set();
      nextFiles = order.map(entry => {
        if (entry?.type === 'key' && typeof entry.value === 'string') {
          const file = existingMap.get(entry.value);
          if (!file || usedExisting.has(file.key)) return null;
          usedExisting.add(file.key);
          return file;
        }
        if (entry?.type === 'new' && Number.isInteger(entry.value) && entry.value >= 0 && entry.value < uploadFiles.length) {
          if (usedUploads.has(entry.value)) return null;
          usedUploads.add(entry.value);
          return uploadFiles[entry.value];
        }
        return null;
      }).filter(Boolean);
      uploadFiles.forEach((file, idx) => {
        if (!usedUploads.has(idx)) nextFiles.push(file);
      });
    } else {
      const keptExisting = existingFiles.filter(file => keptKeys.includes(file.key));
      nextFiles = [...keptExisting, ...uploadFiles];
    }

    const keptKeySet = new Set(nextFiles.filter(file => existingMap.has(file.key)).map(file => file.key));
    const removedExisting = existingFiles.filter(file => !keptKeySet.has(file.key));

    removedExisting.forEach(file => removeStoredFile(file.key));
    if (it.downloadKey && !keptKeySet.has(it.downloadKey)) {
      removeStoredFile(it.downloadKey);
    }

    const download = persistDownloadFiles(req.params.id, nextFiles, it.subtitle || it.translatedTitle || it.title || 'download', collection);
    it.downloadKey = download.downloadKey;
    it.downloadName = download.downloadName;
    it.downloadFiles = download.downloadFiles;
    it.downloadUrl = null;

    await ensureThumbsForKeys(download.downloadFiles.map(file => file.key));

    saveCat(cat, collection);
    cleanupPreviewShareLinksInConfig();
    res.json({ ok: true, item: it });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/items/:id/file', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'editItemInfo', collection)) return res.status(403).json({ error: '你沒有權限編輯項目資訊' });
    const cat = readCat(collection);
    const it  = cat.items.find(i => i.id === req.params.id);
    if (!it) return res.status(404).json({ error: '項目不存在' });
    if (!canAccessItemByRole(it, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限修改這個項目' });

    removeStoredFile(it.downloadKey);
    normalizeDownloadFiles(it).forEach(file => removeStoredFile(file.key));
    it.downloadKey = null;
    it.downloadName = null;
    it.downloadFiles = [];
    it.downloadUrl = null;

    saveCat(cat, collection);
    cleanupPreviewShareLinksInConfig();
    res.json({ ok: true, item: it });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 刪除項目（含上傳的檔案）
app.delete('/api/items/:id', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'deleteItems', collection)) return res.status(403).json({ error: '你沒有權限刪除項目' });
    const cat = readCat(collection);
    const idx = cat.items.findIndex(i => i.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '項目不存在' });
    if (!canAccessItemByRole(cat.items[idx], req.authUser?.role)) return res.status(403).json({ error: '你沒有權限刪除這個項目' });

    const [removed] = cat.items.splice(idx, 1);
    saveCat(cat, collection);
    const trash = readTrash(collection);
    trash.unshift({
      ...removed,
      _deletedIndex: idx,
      _deletedAt: new Date().toISOString()
    });
    saveTrash(trash, collection);
    cleanupPreviewShareLinksInConfig();
    res.json({ ok: true, item: removed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/items/batch-delete', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'deleteItems', collection)) return res.status(403).json({ error: '你沒有權限刪除項目' });
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.filter(id => typeof id === 'string' && id.trim()))]
      : [];
    if (!ids.length) return res.status(400).json({ error: '缺少要刪除的項目' });
    const cat = readCat(collection);
    const idSet = new Set(ids);
    const removed = [];

    cat.items = cat.items.filter((item, idx) => {
      if (!idSet.has(item.id)) return true;
      if (!canAccessItemByRole(item, req.authUser?.role)) return true;
      removed.push({ ...item, _deletedIndex: idx });
      return false;
    });

    if (!removed.length) return res.status(404).json({ error: '找不到可刪除的項目' });

    saveCat(cat, collection);
    const now = new Date().toISOString();
    const trash = readTrash(collection);
    trash.unshift(...removed.map(item => ({
      ...item,
      _deletedAt: now
    })));
    saveTrash(trash, collection);
    cleanupPreviewShareLinksInConfig();
    res.json({ ok: true, count: removed.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trash', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'deleteItems', collection)) return res.status(403).json({ error: '你沒有權限查看回收桶' });
    const trash = readTrash(collection).filter(item => canAccessItemByRole(item, req.authUser?.role));
    res.json({ ok: true, trash });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trash/restore', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'deleteItems', collection)) return res.status(403).json({ error: '你沒有權限復原項目' });
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.filter(id => typeof id === 'string' && id.trim()))]
      : [];
    if (!ids.length) return res.status(400).json({ error: '缺少要復原的項目' });
    const trash = readTrash(collection);
    const idSet = new Set(ids);
    const restoreItems = [];
    const keepTrash = [];

    trash.forEach(item => {
      if (idSet.has(item.id) && canAccessItemByRole(item, req.authUser?.role)) restoreItems.push(item);
      else keepTrash.push(item);
    });

    if (!restoreItems.length) return res.status(404).json({ error: '找不到可復原的項目' });

    const cat = readCat(collection);
    const existingIds = new Set(cat.items.map(item => item.id));
    const keptDeletedIndexes = keepTrash
      .map(item => Number(item?._deletedIndex))
      .filter(idx => Number.isInteger(idx))
      .sort((a, b) => a - b);
    restoreItems
      .sort((a, b) => Number(a?._deletedIndex ?? Infinity) - Number(b?._deletedIndex ?? Infinity))
      .forEach(item => {
      const restored = { ...item };
      delete restored._deletedAt;
      const targetIdx = Number.isInteger(restored._deletedIndex) ? restored._deletedIndex : cat.items.length;
      const missingBefore = keptDeletedIndexes.filter(idx => idx < targetIdx).length;
      const adjustedIdx = targetIdx - missingBefore;
      delete restored._deletedIndex;
      if (!existingIds.has(restored.id)) {
        const insertIdx = Math.max(0, Math.min(cat.items.length, adjustedIdx));
        cat.items.splice(insertIdx, 0, restored);
        existingIds.add(restored.id);
      }
    });

    saveCat(cat, collection);
    saveTrash(keepTrash, collection);
    res.json({ ok: true, count: restoreItems.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/trash', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'deleteItems', collection)) return res.status(403).json({ error: '你沒有權限永久刪除項目' });
    const requestedIds = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.filter(id => typeof id === 'string' && id.trim()))]
      : null;
    const idSet = requestedIds ? new Set(requestedIds) : null;
    const trash = readTrash(collection);
    const purgeItems = [];
    const keepTrash = [];

    trash.forEach(item => {
      const match = !idSet || idSet.has(item.id);
      if (match && canAccessItemByRole(item, req.authUser?.role)) purgeItems.push(item);
      else keepTrash.push(item);
    });

    purgeItems.forEach(item => {
      const dir = collUploadDir(collection, item.id);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    saveTrash(keepTrash, collection);
    res.json({ ok: true, count: purgeItems.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 儲存排序
app.put('/api/order', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!hasRolePermission(req.authUser, 'editItemOrder', collection)) return res.status(403).json({ error: '你沒有權限編輯項目清單' });
    const cat = readCat(collection);
    const ids = req.body.ids;
    if (Array.isArray(ids)) {
      const map = new Map(cat.items.map(i => [i.id, i]));
      cat.items = ids.map(id => map.get(id)).filter(Boolean);
    }
    saveCat(cat, collection);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_UNEXPECTED_FILE'
      ? '上傳檔案數量超出限制'
      : (err.code === 'LIMIT_FILE_SIZE' ? '單一檔案大小超出限制' : err.message);
    return res.status(400).json({ error: msg });
  }
  return res.status(500).json({ error: err.message || 'Upload failed' });
});

// ── 啟動 ──────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  素材庫後端已啟動`);
  console.log(`    本機：http://localhost:${PORT}`);
  console.log(`    外部：http://<你的VM-IP>:${PORT}\n`);
  setTimeout(() => {
    try {
      const removed = pruneExpiredTextHistoryFiles();
      if (removed.length) console.log(`[text-history] 已自動清理 ${removed.length} 份逾期編輯記錄`);
    } catch (err) {
      console.warn('[text-history] cleanup failed:', err?.message || err);
    }
  }, 0);
  setInterval(() => {
    try {
      const removed = pruneExpiredTextHistoryFiles();
      if (removed.length) console.log(`[text-history] 已自動清理 ${removed.length} 份逾期編輯記錄`);
    } catch (err) {
      console.warn('[text-history] cleanup failed:', err?.message || err);
    }
  }, TEXT_HISTORY_SWEEP_INTERVAL_MS);
  setTimeout(() => {
    (async () => {
      try {
        for (const entry of getCollectionsConfig()) {
          await backfillThumbsForCollection(entry.key);
        }
      } catch (err) {
        console.warn('[thumb] backfill failed:', err?.message || err);
      }
    })();
  }, 0);
});
