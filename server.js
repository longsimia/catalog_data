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
const THUMB_MAX_EDGE = 400;
const THUMB_QUALITY = 80;
const CAT_FILE = path.join(DATA, 'catalog.json');
const CFG_FILE = path.join(DATA, 'config.json');
const VALID_COLLECTION_MODES = new Set(['scenario', 'image']);
const ROLE_PERMISSION_KEYS = [
  'onlinePreview',
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
const managePageLocks = new Map();

// 確保目錄存在
[DATA, UPLOADS].forEach(d => fs.mkdirSync(d, { recursive: true }));

const THUMB_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

// ── 工具函式 ──────────────────────────────────────
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

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
  return {
    ...item,
    subtitle,
    translatedTitle: subtitle,
    creator,
    author: creator,
    sourceUrl,
    originalUrl: sourceUrl
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
    uploadOrigin: ''
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
  const rawUploadOrigin = String(cfg.uploadOrigin || '').trim();
  let normalizedUploadOrigin = '';
  if (rawUploadOrigin) {
    try {
      const url = new URL(rawUploadOrigin);
      if (/^https?:$/.test(url.protocol)) normalizedUploadOrigin = url.origin;
    } catch {}
  }
  if (cfg.uploadOrigin !== normalizedUploadOrigin) {
    cfg.uploadOrigin = normalizedUploadOrigin;
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

  const result = { ...cat, items, tags: visibleTags, categories: visibleCategories };

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

function getPreviewableFiles(item) {
  const files = normalizeDownloadFiles(item);
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
      abs: path.join(UPLOADS, file.key)
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

function getTopLevelDocxBlocks(xml, tags = ['p', 'tbl']) {
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
    const openEnd = start + tagMatch[0].length;
    let depth = 1;
    let pos = openEnd;
    const tagRe = new RegExp(`<\\/?w:${tag}\\b[^>]*>`, 'g');
    tagRe.lastIndex = openEnd;
    let next;

    while (depth > 0 && (next = tagRe.exec(source))) {
      if (next[0].startsWith(`</w:${tag}`)) {
        depth -= 1;
      } else {
        depth += 1;
      }
      pos = tagRe.lastIndex;
    }

    if (depth === 0) {
      blocks.push({ tag, xml: source.slice(start, pos) });
      i = pos;
    } else {
      break;
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
  const fontHint = fontEastAsia || fontAscii;
  const sizeHalfPoints = Number((rPr.match(/<w:sz\b[^>]*w:val="(\d+)"/) || [])[1] || 0);
  const styles = [];
  if (/<w:b(?:\b[^>]*)?\/>|<w:b\b[\s\S]*?<\/w:b>/.test(rPr)) styles.push('font-weight:700');
  if (/<w:i(?:\b[^>]*)?\/>|<w:i\b[\s\S]*?<\/w:i>/.test(rPr)) styles.push('font-style:italic');
  if (/<w:u\b[^>]*w:val="(?!none)[^"]+"/.test(rPr) || /<w:u(?:\b[^>]*)?\/>/.test(rPr)) styles.push('text-decoration:underline');
  if (color) styles.push(`color:#${color}`);
  if (sizeHalfPoints > 0) styles.push(`font-size:${(sizeHalfPoints / 2).toFixed(1).replace(/\.0$/, '')}pt`);
  if (fontHint) styles.push(`font-family:${JSON.stringify(fontHint)},"Noto Serif TC","Microsoft JhengHei","PingFang TC",serif`);
  return styles.join(';');
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
  if (style) return `<span style="${style}">${inner}</span>`;
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

function renderDocxParagraphBlocks(block, mediaMap, rels) {
  const meta = getDocxParagraphMeta(block);
  const inlineHtml = renderDocxInline(block, mediaMap, rels);
  const tag = meta.heading ? `h${meta.heading}` : 'p';
  const classes = ['docx-paragraph'];
  if (meta.heading) classes.push(`docx-heading-${meta.heading}`);
  if (meta.isToc) classes.push('docx-toc-entry');
  if (meta.align) classes.push(`docx-align-${meta.align}`);
  const paragraphStyles = [];
  if (meta.indentLeftTwip > 0) paragraphStyles.push(`padding-left:${(meta.indentLeftTwip / 567).toFixed(3)}cm`);
  if (meta.spacingBeforeTwip > 0) paragraphStyles.push(`margin-top:${(meta.spacingBeforeTwip / 567).toFixed(3)}cm`);
  if (meta.spacingAfterTwip > 0) paragraphStyles.push(`margin-bottom:${(meta.spacingAfterTwip / 567).toFixed(3)}cm`);
  if (meta.lineTwip > 0) paragraphStyles.push(`line-height:${Math.max(1.2, meta.lineTwip / 240).toFixed(2)}`);
  const styleAttr = paragraphStyles.length ? ` style="${paragraphStyles.join(';')}"` : '';
  const html = `<${tag} class="${classes.join(' ')}"${styleAttr}>${inlineHtml || '&nbsp;'}</${tag}>`;
  return [{ type: 'paragraph', html, splittable: false }];
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

function extractDocxHtmlBlocks(absPath) {
  const documentXml = getZipEntryBuffer(absPath, 'word/document.xml').toString('utf8');
  const rels = getDocxRelationships(absPath);
  const mediaMap = getDocxMediaMap(absPath, rels);
  const blocks = [];

  getTopLevelDocxBlocks(documentXml).forEach(entry => {
    if (entry.tag === 'p') {
      blocks.push(...renderDocxParagraphBlocks(entry.xml, mediaMap, rels));
      return;
    }
    if (entry.tag === 'tbl') {
      blocks.push({ type: 'table', html: renderDocxTable(entry.xml, mediaMap, rels), splittable: false });
    }
  });

  return blocks;
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
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  const utf16ZeroCount = [...buf].filter((byte, idx) => idx % 2 === 1 && byte === 0).length;
  if (utf16ZeroCount > buf.length / 6) {
    return { text: buf.toString('utf16le').replace(/^\uFEFF/, ''), encoding: 'utf16le', bom: null };
  }
  if (replacementCount <= Math.max(1, Math.floor(buf.length / 120))) {
    return { text: utf8.replace(/^\uFEFF/, ''), encoding: 'utf8', bom: null };
  }

  for (const encoding of ['big5', 'gb18030']) {
    try {
      return {
        text: new TextDecoder(encoding, { fatal: true }).decode(buf).replace(/^\uFEFF/, ''),
        encoding,
        bom: null
      };
    } catch {}
  }
  for (const encoding of ['utf8', 'utf16le', 'big5']) {
    try {
      const decoded = iconv.decode(buf, encoding).replace(/^\uFEFF/, '');
      if (decoded && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded)) {
        return { text: decoded, encoding, bom: null };
      }
    } catch {}
  }
  return { text: utf8.replace(/\uFFFD/g, ''), encoding: 'utf8', bom: null };
}

function readTextFile(absPath) {
  return decodeTextBuffer(fs.readFileSync(absPath));
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
  if (meta.encoding === 'big5' || meta.encoding === 'gb18030') {
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
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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
function getPreviewSourceText(file) {
  if (!file?.abs || !fs.existsSync(file.abs)) throw new Error('Preview source file was not found.');
  if (file.ext === '.txt') {
    return readTextFile(file.abs).text;
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

function renderDocxPreviewPage(item, file, blocks = []) {
  const pageTitle = escapeXml(getPreviewLabel(file));
  const itemTitle = escapeXml(item?.translatedTitle || item?.title || '文件線上閱覽');
  const kind = 'Docx 文件閱覽';
  const blockHtml = blocks.map((block, idx) => {
    if (block.type === 'pagebreak') return `<hr class="docx-page-divider" data-idx="${idx}">`;
    return `<div class="docx-block" data-kind="${escapeXml(block.type)}" data-idx="${idx}">${block.html}</div>`;
  }).join('');

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  <style>
    :root{
      --bg:#111118;--paper:#15151d;--text:#e8e2d6;--muted:#8e8a98;--line:#28283a;--accent:#c9a84c;
      --accent-soft:rgba(201,168,76,.12);--btn-text:#140f00;
      --shadow:0 18px 40px rgba(0,0,0,.22);--bg-top:#07070f;--bg-glow:rgba(201,168,76,.07)
    }
    html{color-scheme:dark}
    html[data-theme="light"],body[data-theme="light"]{
      color-scheme:light;
      --bg:#e6e6e6;--paper:#ffffff;--text:#3b342d;--muted:#9b9084;--line:#ece5db;--accent:#a18d79;
      --accent-soft:rgba(161,141,121,.07);--btn-text:#fff;
      --shadow:0 18px 34px rgba(87,72,56,.09), 0 0 0 1px rgba(120,98,75,.06);--bg-top:#e6e6e6;--bg-glow:transparent
    }
    *{box-sizing:border-box}
    body{margin:0;font-family:"Noto Serif TC","Microsoft JhengHei","PingFang TC",serif;background:radial-gradient(ellipse 70% 50% at 50% 0%, var(--bg-glow), transparent 70%),linear-gradient(180deg,var(--bg-top) 0%,var(--bg) 100%);color:var(--text);transition:background .25s ease,color .25s ease}
    body[data-theme="light"]{background:var(--bg)}
    .wrap{width:min(calc(21cm + 36px),100%);margin:0 auto;padding:28px 18px 72px}
    .meta{margin:0 0 32px}
    .meta-hero{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
    .meta-label{font-family:"Noto Serif TC","Microsoft JhengHei","PingFang TC",serif;font-size:16px;line-height:1.25;font-weight:600;color:var(--text)}
    .meta strong{display:block;font-size:clamp(24px,3vw,34px);line-height:1.35}
    .meta-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
    .theme-btn{width:29px;height:29px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid var(--line);border-radius:999px;background:var(--paper);color:var(--text);transition:all .25s ease;box-shadow:none;flex:0 0 29px}
    .theme-btn:hover{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
    .ico{display:inline-flex;align-items:center;justify-content:center;width:.92rem;height:.92rem;flex-shrink:0}
    .ico svg{width:100%;height:100%;display:block}
    .paper{background:var(--paper);border:1px solid var(--line);border-radius:0;padding:28px 1.6cm 22px;box-shadow:var(--shadow);width:21cm;max-width:100%}
    .docx-block + .docx-block{margin-top:0}
    .docx-paragraph{margin:0 0 1.1em;white-space:pre-wrap;word-break:break-word;line-height:1.9;font-size:17px}
    .docx-heading-1,.docx-heading-2,.docx-heading-3,.docx-heading-4,.docx-heading-5,.docx-heading-6{font-family:"Noto Serif TC","Microsoft JhengHei","PingFang TC",serif;font-weight:700;line-height:1.45;margin:1.4em 0 .7em}
    .docx-heading-1{font-size:1.9rem}
    .docx-heading-2{font-size:1.55rem}
    .docx-heading-3{font-size:1.3rem}
    .docx-heading-4{font-size:1.15rem}
    .docx-heading-5,.docx-heading-6{font-size:1rem}
    .docx-align-center{text-align:center}
    .docx-align-right{text-align:right}
    .docx-align-both{text-align:justify}
    .docx-toc-entry{font-size:1rem}
    .docx-empty{opacity:.55}
    .docx-image{display:block;max-width:100%;height:auto;margin:12px auto;border-radius:10px}
    .docx-table-wrap{overflow-x:auto;margin:0 0 1.2em}
    .docx-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:15px;line-height:1.7}
    .docx-table td,.docx-table th{border:1px solid var(--line);padding:10px 12px;vertical-align:top}
    .docx-table p{margin:0 0 .7em}
    .docx-table p:last-child{margin-bottom:0}
    .docx-link{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
    .docx-link:hover{opacity:.8}
    .docx-anchor{display:block;position:relative;top:-8px;visibility:hidden}
    .docx-page-divider{border:none;border-top:1px dashed var(--line);margin:1.6em 0}
    .docx-zoom{position:fixed;inset:0;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.72);z-index:999}
    .docx-zoom.on{display:flex}
    .docx-zoom img{max-width:min(96vw,1400px);max-height:92vh;object-fit:contain;border:1px solid rgba(255,255,255,.18);background:#000}
    @media (max-width: 860px){
      .wrap{padding-inline:10px}
      .paper{width:100%;padding:22px 18px 18px}
      .docx-paragraph{font-size:16px;line-height:1.8}
      .docx-table{font-size:14px}
    }
  </style>
  <script>
    (() => {
      const mode = localStorage.getItem('theme-mode') === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = mode;
      document.addEventListener('DOMContentLoaded', () => {
        document.body.dataset.theme = mode;
      });
    })();
  </script>
</head>
<body>
  <main class="wrap">
    <section class="meta">
      <div class="meta-hero meta-top">
        <button class="theme-btn" id="theme-btn" type="button" aria-label="切換顯示模式"></button>
        <span class="meta-label">${itemTitle}</span>
      </div>
      <strong>${pageTitle}</strong>
    </section>
    <article class="paper">${blockHtml || '<p class="docx-paragraph docx-empty">&nbsp;</p>'}</article>
  </main>
  <div class="docx-zoom" id="docxZoom" aria-hidden="true"><img id="docxZoomImg" alt=""></div>
  <script>
    const themeIcon = kind => kind === 'moon'
      ? '<span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg></span>'
      : '<span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3"/></svg></span>';

    function applyTheme(theme) {
      const mode = theme === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = mode;
      document.body.dataset.theme = mode;
      localStorage.setItem('theme-mode', mode);
      const btn = document.getElementById('theme-btn');
      if (btn) {
        btn.innerHTML = mode === 'light' ? themeIcon('moon') : themeIcon('sun');
        btn.setAttribute('title', mode === 'light' ? '切換為深色模式' : '切換為淺色模式');
      }
    }

    function toggleTheme() {
      const next = (document.body.dataset.theme || 'dark') === 'light' ? 'dark' : 'light';
      applyTheme(next);
    }
    const zoom = document.getElementById('docxZoom');
    const zoomImg = document.getElementById('docxZoomImg');

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

    document.getElementById('theme-btn')?.addEventListener('click', toggleTheme);
    applyTheme(localStorage.getItem('theme-mode') === 'light' ? 'light' : 'dark');
    document.querySelectorAll('.docx-image').forEach(img => {
      img.addEventListener('click', () => openZoom(img.src));
    });
    zoom?.addEventListener('click', closeZoom);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeZoom();
    });
  </script>
</body>
</html>`;
}

function renderTextPreviewPage(item, file, text, options = {}) {
  const pageTitle = escapeXml(getPreviewLabel(file));
  const itemTitle = escapeXml(item?.translatedTitle || item?.title || '文件線上閱覽');
  const rawBody = escapeXml(String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  const displayBody = rawBody || escapeXml(normalizePreviewText(text));
  const kind = file.ext === '.docx' ? 'Docx 文件閱覽' : 'TXT 文件閱覽';
  const isTxt = file.ext === '.txt';
  const canEditTxt = !!options.canEditTxt;
  const createdAtLabel = escapeXml(options.createdAtLabel || '');
  const updatedAtLabel = escapeXml(options.updatedAtLabel || '');
  const updatedByLabel = escapeXml(options.updatedByLabel || '');
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  <style>
    :root{
      --bg:#111118;--paper:#15151d;--text:#e8e2d6;--muted:#8e8a98;--line:#28283a;--accent:#c9a84c;
      --accent-soft:rgba(201,168,76,.12);--btn-text:#140f00;
      --shadow:0 18px 40px rgba(0,0,0,.22);--bg-top:#07070f;--bg-glow:rgba(201,168,76,.07)
    }
    html{color-scheme:dark}
    html[data-theme="light"],body[data-theme="light"]{
      color-scheme:light;
      --bg:#f1f3f5;--paper:#ffffff;--text:#3b342d;--muted:#9b9084;--line:#ece5db;--accent:#a18d79;
      --accent-soft:rgba(161,141,121,.07);--btn-text:#fff;
      --shadow:0 18px 34px rgba(87,72,56,.09), 0 0 0 1px rgba(120,98,75,.06);--bg-top:#f1f3f5;--bg-glow:transparent
    }
    *{box-sizing:border-box}
    body{margin:0;font-family:"Noto Serif TC","Microsoft JhengHei","PingFang TC",serif;background:radial-gradient(ellipse 70% 50% at 50% 0%, var(--bg-glow), transparent 70%),linear-gradient(180deg,var(--bg-top) 0%,var(--bg) 100%);color:var(--text);transition:background .25s ease,color .25s ease}
    body[data-theme="light"]{background:var(--bg)}
    .wrap{max-width:980px;margin:0 auto;padding:28px 18px 54px}
    .meta{margin-bottom:32px}
    .meta-hero{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
    .meta-label{font-family:"Noto Serif TC","Microsoft JhengHei","PingFang TC",serif;font-size:16px;line-height:1.25;font-weight:600;color:var(--text)}
    .meta strong{display:block;font-size:clamp(24px,3vw,34px);line-height:1.35}
    .meta p{margin:10px 0 0;color:var(--muted);line-height:1.7}
    .meta-times{margin-top:12px;display:grid;gap:4px;color:var(--muted);font-size:14px;line-height:1.6}
    .meta-times span{display:block}
    .meta-times .inline-time{display:flex;flex-wrap:nowrap;align-items:baseline;gap:0;white-space:nowrap}
    .meta-times .inline-time time,.meta-times .inline-time #updatedByWrap,.meta-times .inline-time #updatedByText{display:inline;white-space:nowrap}
    .meta-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
    .meta-head{display:flex;gap:14px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
    .meta-copy{min-width:min(100%,440px);flex:1}
    .actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .theme-btn{width:29px;height:29px;padding:0;display:inline-flex;align-items:center;justify-content:center;gap:.4rem;cursor:pointer;border:1px solid var(--line);border-radius:999px;background:var(--paper);color:var(--text);font-size:.8rem;font-family:inherit;transition:all .25s ease;box-shadow:none;flex:0 0 29px}
    .theme-btn:hover{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
    .ico{display:inline-flex;align-items:center;justify-content:center;width:.92rem;height:.92rem;flex-shrink:0}
    .ico svg{width:100%;height:100%;display:block}
    .btn{appearance:none;border:1px solid var(--line);background:var(--paper);color:var(--text);border-radius:999px;padding:10px 16px;font:inherit;font-size:14px;cursor:pointer;box-shadow:0 10px 24px rgba(0,0,0,.12)}
    .btn:hover{border-color:var(--accent)}
    .btn:disabled{opacity:.6;cursor:wait}
    .btn-primary{background:var(--accent);color:var(--btn-text);border-color:var(--accent)}
    .btn-plain{box-shadow:none}
    .paper{background:var(--paper);border:1px solid var(--line);border-radius:0;padding:28px 1.6cm 22px;box-shadow:var(--shadow)}
    pre,.editor{margin:0;white-space:pre-wrap;word-break:break-word;line-height:1.95;font-size:17px;font-family:inherit}
    .editor{display:block;width:100%;min-height:0;border:none;outline:none;resize:none;overflow:hidden;background:transparent;color:inherit}
    .status{min-height:22px;margin-top:12px;color:var(--muted);font-size:14px}
    .status[data-state="error"]{color:#a33d2d}
    .status[data-state="success"]{color:#2d7a54}
    .leave-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:50}
    .leave-modal.on{display:flex}
    .leave-modal-bg{position:absolute;inset:0;background:rgba(0,0,0,.65)}
    .leave-modal-card{position:relative;z-index:1;width:min(92vw,420px);background:var(--paper);border:1px solid var(--line);box-shadow:var(--shadow);padding:20px 22px;border-radius:18px}
    .leave-modal-card h3{margin:0 0 10px;font-size:20px;line-height:1.35;color:var(--text)}
    .leave-modal-card p{margin:0;color:var(--muted);font-size:14px;line-height:1.7}
    .leave-modal-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:18px}
  </style>
  <script>
    (() => {
      const mode = localStorage.getItem('theme-mode') === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = mode;
      document.addEventListener('DOMContentLoaded', () => {
        document.body.dataset.theme = mode;
      });
    })();
  </script>
</head>
<body>
  <main class="wrap">
    <section class="meta">
      <div class="meta-hero meta-top">
        <button class="theme-btn" id="theme-btn" type="button" aria-label="切換顯示模式"></button>
        <span class="meta-label">${itemTitle}</span>
      </div>
      <div class="meta-head">
        <div class="meta-copy">
          <strong>${pageTitle}</strong>
          ${isTxt ? `<div class="meta-times">
            <span>建立時間：<time id="createdAtText">${createdAtLabel}</time></span>
            <span class="inline-time">最後儲存：<time id="updatedAtText">${updatedAtLabel}</time><span id="updatedByWrap"${updatedByLabel ? '' : ' style="display:none"'}>&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;<span id="updatedByText">${updatedByLabel}</span></span></span>
          </div>` : ''}
        </div>
        ${isTxt && canEditTxt ? `<div class="actions">
          <button type="button" class="btn btn-primary" id="saveBtn" title="會直接覆寫雲端上的原始檔案">儲存</button>
        </div>` : ''}
      </div>
    </section>
    <article class="paper">
      ${isTxt
        ? `<textarea id="editor" class="editor" spellcheck="false"${canEditTxt ? '' : ' readonly'}>${rawBody}</textarea>
      <div class="status" id="saveStatus" aria-live="polite"${canEditTxt ? '' : ' style="display:none"'}></div>`
        : `<pre>${displayBody}</pre>`}
    </article>
  </main>
  ${isTxt && canEditTxt ? `<div class="leave-modal" id="leaveModal" aria-hidden="true">
    <div class="leave-modal-bg" id="leaveModalBg"></div>
    <div class="leave-modal-card" role="dialog" aria-modal="true" aria-labelledby="leaveModalTitle">
      <h3 id="leaveModalTitle">尚未儲存變更</h3>
      <p>這份 TXT 還有未儲存的編輯內容。要先留在這頁繼續處理，還是直接離開？</p>
      <div class="leave-modal-actions">
        <button type="button" class="btn btn-plain" id="leaveStayBtn">留在此頁</button>
        <button type="button" class="btn btn-primary" id="leaveConfirmBtn">直接離開</button>
      </div>
    </div>
  </div>` : ''}
  <script>
    const themeIcon = kind => kind === 'moon'
      ? '<span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg></span>'
      : '<span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3"/></svg></span>';

    function applyTheme(theme) {
      const mode = theme === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = mode;
      document.body.dataset.theme = mode;
      localStorage.setItem('theme-mode', mode);
      const btn = document.getElementById('theme-btn');
      if (btn) {
        btn.innerHTML = mode === 'light' ? themeIcon('moon') : themeIcon('sun');
        btn.setAttribute('title', mode === 'light' ? '切換為深色模式' : '切換為淺色模式');
      }
    }

    function toggleTheme() {
      const next = (document.body.dataset.theme || 'dark') === 'light' ? 'dark' : 'light';
      applyTheme(next);
    }

    document.getElementById('theme-btn')?.addEventListener('click', toggleTheme);
    applyTheme(localStorage.getItem('theme-mode') === 'light' ? 'light' : 'dark');
  </script>
  ${isTxt ? `<script>
    const editor = document.getElementById('editor');

    function resizeEditor() {
      if (!editor) return;
      editor.style.height = 'auto';
      editor.style.height = editor.scrollHeight + 'px';
    }

    resizeEditor();
    window.addEventListener('load', resizeEditor);
    window.addEventListener('resize', resizeEditor);
    editor?.addEventListener('input', resizeEditor);
  </script>` : ''}
  ${isTxt && canEditTxt ? `<script>
    const saveBtn = document.getElementById('saveBtn');
    const status = document.getElementById('saveStatus');
    const saveUrlRaw = ${JSON.stringify(options.saveUrl || '')};
    const saveUrl = saveUrlRaw ? new URL(saveUrlRaw, window.location.origin).toString() : '';
    const leaveModal = document.getElementById('leaveModal');
    const leaveModalBg = document.getElementById('leaveModalBg');
    const leaveStayBtn = document.getElementById('leaveStayBtn');
    const leaveConfirmBtn = document.getElementById('leaveConfirmBtn');
    let lastSavedText = editor ? editor.value : '';
    let allowLeave = false;
    let leaveViaHistory = false;

    function hasUnsavedChanges() {
      return !!editor && editor.value !== lastSavedText;
    }

    function syncDirtyState() {
      if (!status || status.dataset.state === 'error') return;
      if (hasUnsavedChanges()) {
        status.dataset.state = '';
        status.textContent = '尚有未儲存變更';
      } else if (status.textContent === '尚有未儲存變更') {
        status.textContent = '';
      }
    }

    function closeLeaveModal() {
      if (!leaveModal) return;
      leaveModal.classList.remove('on');
      leaveModal.setAttribute('aria-hidden', 'true');
      leaveViaHistory = false;
    }

    function showLeaveModal(viaHistory = false) {
      if (!leaveModal) return;
      leaveViaHistory = viaHistory;
      leaveModal.classList.add('on');
      leaveModal.setAttribute('aria-hidden', 'false');
      leaveStayBtn?.focus();
    }

    function confirmLeave() {
      allowLeave = true;
      closeLeaveModal();
      if (leaveViaHistory) {
        history.back();
      } else {
        window.close();
      }
    }

    async function saveText() {
      if (!saveUrl) return;
      saveBtn.disabled = true;
      status.dataset.state = '';
      status.textContent = '儲存中...';
      try {
        const res = await fetch(saveUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (localStorage.getItem('adm-token') || '')
          },
          body: JSON.stringify({ text: editor.value })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '儲存失敗');
        lastSavedText = editor.value;
        status.dataset.state = 'success';
        status.textContent = '已儲存';
        const updatedAtText = document.getElementById('updatedAtText');
        if (updatedAtText && data.updatedAtLabel) updatedAtText.textContent = data.updatedAtLabel;
        const updatedByText = document.getElementById('updatedByText');
        const updatedByWrap = document.getElementById('updatedByWrap');
        if (updatedByText && data.updatedByLabel) updatedByText.textContent = data.updatedByLabel;
        if (updatedByWrap) updatedByWrap.style.display = data.updatedByLabel ? '' : 'none';
      } catch (err) {
        status.dataset.state = 'error';
        status.textContent = err.message || '儲存失敗';
      } finally {
        saveBtn.disabled = false;
      }
    }

    function handleBeforeUnload(event) {
      if (allowLeave || !hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    }

    editor?.addEventListener('input', syncDirtyState);
    saveBtn?.addEventListener('click', saveText);
    leaveModalBg?.addEventListener('click', closeLeaveModal);
    leaveStayBtn?.addEventListener('click', closeLeaveModal);
    leaveConfirmBtn?.addEventListener('click', confirmLeave);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && leaveModal?.classList.contains('on')) {
        event.preventDefault();
        closeLeaveModal();
      }
    });
    window.addEventListener('beforeunload', handleBeforeUnload);
    history.pushState({ txtPreviewGuard: true }, '');
    window.addEventListener('popstate', event => {
      if (allowLeave || !hasUnsavedChanges()) return;
      history.pushState({ txtPreviewGuard: true }, '');
      showLeaveModal(true);
    });
  </script>` : ''}
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

function resolvePreview(item, previewIndex = 0) {
  const files = getPreviewableFiles(item);
  const file = files[Number(previewIndex)];
  if (!file) return null;
  if (!fs.existsSync(file.abs)) return null;
  if (PREVIEWABLE_MEDIA_MIME[file.ext]) {
    return {
      type: 'media',
      filename: file.name,
      label: getPreviewLabel(file),
      mimeType: getPreviewMediaMimeType(file.ext),
      abs: file.abs
    };
  }
  if (file.ext === '.pdf') {
    return {
      type: 'pdf',
      filename: getPreviewLabel(file),
      label: getPreviewLabel(file),
      buffer: null,
      abs: file.abs
    };
  }
  if (file.ext === '.docx') {
    const blocks = extractDocxHtmlBlocks(file.abs);
    return {
      type: 'html',
      filename: `${path.parse(file.name).name}.html`,
      label: getPreviewLabel(file),
      file,
      blocks,
      html: '',
      abs: null
    };
  }
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
  const text = getPreviewSourceText(file);
  return {
    type: 'html',
    filename: `${path.parse(file.name).name}.html`,
    label: getPreviewLabel(file),
    file,
    text,
    html: '',
    abs: null
  };
}

function resolvePreviewFileIndexByShare(item, share = {}) {
  const files = getPreviewableFiles(item);
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
    createdAt: Number(source.createdAt) || Date.now()
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
  const preview = resolvePreview(item, previewIndex);
  if (!preview) return null;
  return { share, item, preview, previewIndex };
}

function createPreviewShareToken(existingLinks = {}) {
  for (let i = 0; i < 8; i += 1) {
    const token = crypto.randomBytes(9).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    if (token && !existingLinks[token]) return token;
  }
  return crypto.randomBytes(12).toString('hex');
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
      const mode = localStorage.getItem('theme-mode') === 'light' ? 'light' : 'dark';
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
app.use('/uploads',
  (req, res, next) => {
    if (path.basename(req.path).startsWith('dl.')) {
      return res.status(403).json({ error: '下載需要登入' });
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
  } catch (e) { res.status(401).json({ error: 'Google 驗證失敗：' + e.message }); }
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
  if (!hasRolePermission(req.authUser, 'downloadFiles', collection)) return res.status(403).json({ error: '你沒有權限下載檔案' });
  const cat = readCat(collection);
  const collCfg = getCollectionConfig(collection);
  const item = (cat.items || []).find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: '項目不存在' });
  if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限查看這個項目' });
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
  if (!hasRolePermission(req.authUser, 'downloadFiles', collection)) return res.status(403).json({ error: '你沒有權限下載檔案' });
  const cat = readCat(collection);
  const collCfg = getCollectionConfig(collection);
  const item = (cat.items || []).find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: '項目不存在' });
  if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限查看這個項目' });

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
    if (!hasRolePermission(req.authUser, 'onlinePreview', collection)) return res.status(403).json({ error: '你沒有權限線上閱覽附件' });
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '項目不存在' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限查看這個項目' });
    const files = getPreviewableFiles(item).filter(file => fs.existsSync(file.abs));
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
    if (!hasRolePermission(req.authUser, 'onlinePreview', collection)) return res.status(403).json({ error: '你沒有權限線上閱覽附件' });
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '項目不存在' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限查看這個項目' });
    const files = getPreviewableFiles(item).filter(file => fs.existsSync(file.abs));
    const previewIndex = Number(req.body?.index);
    const file = files[previewIndex];
    if (!file) return res.status(404).json({ error: '找不到可分享的附件' });
    cfg.previewShareLinks = cfg.previewShareLinks && typeof cfg.previewShareLinks === 'object' ? cfg.previewShareLinks : {};
    const token = createPreviewShareToken(cfg.previewShareLinks);
    cfg.previewShareLinks[token] = {
      collection,
      itemId: item.id,
      fileKey: String(file.key || '').trim(),
      relativePath: String(file.relativePath || file.name || '').replace(/\\/g, '/').trim(),
      createdAt: Date.now()
    };
    saveCfg(cfg);
    const sharePath = `/preview-share/${encodeURIComponent(token)}`;
    return res.json({
      ok: true,
      sharePath,
      shareUrl: `${req.protocol}://${req.get('host')}${sharePath}`
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

app.get('/api/download/:id', auth, (req, res) => {
  const collection = getC(req);
  const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
  if (collectionDenied) return res.status(403).json(collectionDenied);
    if (!hasRolePermission(req.authUser, 'downloadFiles', collection)) return res.status(403).json({ error: '你沒有權限下載檔案' });
  const cat = readCat(collection);
  const collCfg = getCollectionConfig(collection);
  const item = (cat.items || []).find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: '找不到下載檔案' });
  if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限查看這個項目' });
  if (collCfg.mode === 'image') {
    const files = getImageBundleFiles(item);
    if (!files.length) return res.status(404).json({ error: '找不到下載檔案' });
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
    if (!fs.existsSync(abs)) return res.status(404).json({ error: '找不到下載檔案' });
    setDownloadHeaders(res, item.downloadName || path.basename(abs));
    return res.sendFile(abs);
  }
  return res.status(404).json({ error: '找不到下載檔案' });
});

app.get('/api/download/:id/files/:index', auth, (req, res) => {
  const collection = getC(req);
  const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
  if (collectionDenied) return res.status(403).json(collectionDenied);
  if (!hasRolePermission(req.authUser, 'downloadFiles', collection)) return res.status(403).json({ error: '你沒有權限下載檔案' });
  const cat = readCat(collection);
  const collCfg = getCollectionConfig(collection);
  const item = (cat.items || []).find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: '找不到下載檔案' });
  if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限查看這個項目' });
  const files = getDownloadableFilesForItem(item, collCfg.mode);
  const file = files[Number(req.params.index)];
  if (!file) return res.status(404).json({ error: '找不到下載檔案' });
  setDownloadHeaders(res, file.name || path.basename(file.abs));
  return res.sendFile(file.abs);
});

app.get('/preview-hub/:id', auth, (req, res) => {
  try {
    const collection = getC(req);
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
    if (collectionDenied) return res.status(403).send(collectionDenied.error);
    if (!hasRolePermission(req.authUser, 'onlinePreview', collection)) return res.status(403).send('你沒有權限線上閱覽附件');
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).send('Item not found');
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).send('Forbidden');
    const files = getPreviewableFiles(item).filter(file => fs.existsSync(file.abs));
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
    :root{--bg:#111118;--panel:#15151d;--text:#e8e2d6;--muted:#8e8a98;--border:#28283a}
    html{color-scheme:dark}
    html[data-theme="light"],body[data-theme="light"]{
      color-scheme:light;
      --bg:#e6e6e6;--panel:#ffffff;--text:#3b342d;--muted:#9b9084;--border:#ece5db;
    }
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif}
    .state{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
    .card{background:var(--panel);border:1px solid var(--border);padding:24px 28px;max-width:520px;width:100%}
    h1{margin:0 0 10px;font-family:"Noto Serif TC",serif;font-size:1.25rem}
    p{margin:0;color:var(--muted);line-height:1.7}
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
      const mode = localStorage.getItem('theme-mode') === 'light' ? 'light' : 'dark';
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
        msg.textContent = '請先登入後台後再開啟這個檔案。';
        return;
      }
      const url = '/api/preview/' + encodeURIComponent(itemId) + '/' + encodeURIComponent(previewIndex) + (collection === 'scenario' ? '' : ('?c=' + encodeURIComponent(collection)));
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
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      window.location.replace(blobUrl);
    }

    openPreview().catch(() => {
      msg.textContent = '載入失敗，請稍後再試。';
    });
  </script>
</body>
</html>`;
}

function sendResolvedPreview(res, item, preview, previewIndex, options = {}) {
  const collection = options.collection || 'scenario';
  const canEditTxt = !!options.canEditTxt;
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
    return res.send(preview.text || '');
  }
  const textEditMeta = preview.file?.ext === '.txt' ? getTextEditMeta(item, preview.file.key, preview.file.abs) : null;
  preview.html = preview.file?.ext === '.docx'
    ? renderDocxPreviewPage(item, preview.file, preview.blocks || [])
    : renderTextPreviewPage(item, preview.file, preview.text, {
        saveUrl: previewSavePath,
        createdAtLabel: textEditMeta ? formatDateTimeToSecond(textEditMeta.createdAt) : '',
        updatedAtLabel: textEditMeta ? formatDateTimeToSecond(textEditMeta.savedAt) : '',
        updatedByLabel: textEditMeta?.savedBy || '',
        canEditTxt
      });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(preview.html);
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
    const resolved = resolveSharedPreview(cfg, req.params.token);
    if (!resolved) return res.status(404).send('找不到分享的線上閱覽檔案');
    return sendResolvedPreview(res, resolved.item, resolved.preview, resolved.previewIndex, {
      collection: resolved.share.collection,
      canEditTxt: false
    });
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

app.get('/api/preview/:id/:index', auth, (req, res) => {
  try {
    const collection = getC(req);
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
    if (collectionDenied) return res.status(403).json(collectionDenied);
    if (!hasRolePermission(req.authUser, 'onlinePreview', collection)) return res.status(403).json({ error: '你沒有權限線上閱覽附件' });
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '項目不存在' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限查看這個項目' });
    const previewIndex = Number(req.params.index) || 0;
    const preview = resolvePreview(item, previewIndex);
    if (!preview) return res.status(415).json({ error: '這個檔案格式目前不支援線上閱覽' });
    return sendResolvedPreview(res, item, preview, previewIndex, {
      collection,
      canEditTxt: preview.file?.ext === '.txt' && canEditTxtPreview(req.authUser, collection)
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.put('/api/preview/:id/:index', auth, (req, res) => {
  try {
    const collection = getC(req);
    if (!canEditTxtPreview(req.authUser, collection)) return res.status(403).json({ error: '你沒有權限編輯 TXT 附件' });
    const collectionDenied = ensureCollectionAccessOrNull(collection, req.authUser?.role, readCfg());
    if (collectionDenied) return res.status(403).json(collectionDenied);
    const cat = readCat(collection);
    const item = (cat.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: '項目不存在' });
    if (!canAccessItemByRole(item, req.authUser?.role)) return res.status(403).json({ error: '你沒有權限編輯這個項目' });
    const file = getPreviewableFiles(item)[Number(req.params.index) || 0];
    if (!file || file.ext !== '.txt') {
      return res.status(415).json({ error: '只有 TXT 文件支援線上編輯與儲存' });
    }
    if (!fs.existsSync(file.abs)) return res.status(404).json({ error: '找不到原始 TXT 檔案' });
    const sourceMeta = readTextFile(file.abs);
    const nextText = typeof req.body?.text === 'string' ? req.body.text : '';
    fs.writeFileSync(file.abs, encodeTextBuffer(nextText, sourceMeta));
    item.textEditMeta = item.textEditMeta && typeof item.textEditMeta === 'object' ? item.textEditMeta : {};
    const savedAt = new Date();
    item.textEditMeta[file.key] = {
      savedAt: savedAt.toISOString(),
      savedById: req.authUser?.id || '',
      savedBy: req.authUser?.username || ''
    };
    saveCat(cat, collection);
    return res.json({
      ok: true,
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

// 修改管理密碼
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
      if (!incoming.length) return res.status(400).json({ error: '至少要保留一組登入帳號' });
      const seenNames = new Set();
      nextUsers = incoming.map((entry, idx) => {
        const username = String(entry?.username || '').trim();
        if (!username) throw new Error(`第 ${idx + 1} 組用戶名不可空白`);
        if (seenNames.has(username)) throw new Error(`用戶名「${username}」重複，請調整後再儲存`);
        seenNames.add(username);
        const id = typeof entry?.id === 'string' && entry.id.trim() ? entry.id.trim() : makeAuthUserId();
        const previous = existingMap.get(id);
        const password = typeof entry?.password === 'string' ? entry.password : '';
        const passwordHash = password ? sha256(password) : (previous?.passwordHash || '');
        if (!passwordHash) throw new Error(`第 ${idx + 1} 組帳號需要設定密碼`);
        const requestedRole = sanitizeRoleKey(entry?.role);
        let role = requestedRole && allowedRoles.has(requestedRole)
          ? requestedRole
          : (idx === 0 ? 'owner' : defaultNonOwnerRole);
        if (idx > 0 && !role) throw new Error('請先建立至少一個非站主身份組');
        const googleEmail = String(entry?.googleEmail || '').trim().toLowerCase();
        const googleEmailNormalized = normalizeGoogleEmail(googleEmail);
        const googleOnly = !!entry?.googleOnly;
        if (googleOnly && !googleEmail) throw new Error(`第 ${idx + 1} 個帳號已設為僅限 Google 登入，不能清空 Google 信箱`);
        if (googleEmailNormalized && incoming.some((other, otherIdx) => otherIdx !== idx && normalizeGoogleEmail(other?.googleEmail || '') === googleEmailNormalized)) {
          throw new Error(`第 ${idx + 1} 個帳號的 Google 信箱與其他帳號重複綁定`);
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
      if (ownerCount !== 1) throw new Error('群主只能有一位');
    } else {
      if (incoming.length !== 1) return res.status(400).json({ error: '你只能修改自己的帳號資料' });
      const self = existingUsers.find(user => user.id === req.authUser?.id);
      if (!self) return res.status(403).json({ error: '找不到目前登入帳號' });
      const entry = incoming[0] || {};
      if (String(entry?.id || '') !== self.id) return res.status(403).json({ error: '你只能修改自己的帳號資料' });
      const username = String(entry?.username || '').trim();
      if (!username) throw new Error('用戶名不可空白');
      if (existingUsers.some(user => user.id !== self.id && user.username === username)) throw new Error(`用戶名「${username}」重複，請調整後再儲存`);
      const password = typeof entry?.password === 'string' ? entry.password : '';
      const passwordHash = password ? sha256(password) : self.passwordHash;
      const googleEmail = String(entry?.googleEmail || '').trim().toLowerCase();
      const googleEmailNormalized = normalizeGoogleEmail(googleEmail);
      if (!passwordHash) throw new Error('帳號需要設定密碼');
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

    const { title, creator, author, subtitle, translatedTitle, category, categories, tags, description, sourceUrl, originalUrl, permission } = req.body;
    const nextCategories = Array.isArray(categories)
      ? categories.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean)
      : (typeof category === 'string' && category.trim() ? [category.trim()] : it.categories || []);
    const nextCreator = String(creator || author || '').trim();
    const nextSubtitle = String(subtitle || translatedTitle || '').trim();
    const nextSourceUrl = String(sourceUrl || originalUrl || '').trim();
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
      originalUrl: nextSourceUrl
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
