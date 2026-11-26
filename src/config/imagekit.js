const ImageKit = require('imagekit');

function normalizeEndpoint(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

const primaryConfig = {
  id: 'primary',
  label: 'Utama (.env)',
  publicKey: String(process.env.IMAGEKIT_PUBLIC_KEY || '').trim(),
  privateKey: String(process.env.IMAGEKIT_PRIVATE_KEY || '').trim(),
  urlEndpoint: normalizeEndpoint(process.env.IMAGEKIT_URL_ENDPOINT || ''),
};

// Instance default tetap diarahkan ke akun Primary (.env) agar kompatibel dengan pemanggilan lama & terkunci untuk Frame/QRIS
const primaryImageKit = new ImageKit({
  publicKey: primaryConfig.publicKey,
  privateKey: primaryConfig.privateKey,
  urlEndpoint: primaryConfig.urlEndpoint,
});

// Cache instance SDK untuk akun cadangan agar tidak membuat ulang objek di setiap request
const clientCache = new Map();

function createClientFromCreds({ publicKey, privateKey, urlEndpoint }) {
  const pub = String(publicKey || '').trim();
  const priv = String(privateKey || '').trim();
  const ep = normalizeEndpoint(urlEndpoint);

  if (!pub || !priv || !ep) return null;

  if (
    pub === primaryConfig.publicKey &&
    priv === primaryConfig.privateKey &&
    ep === primaryConfig.urlEndpoint
  ) {
    return primaryImageKit;
  }

  const cacheKey = `${pub}|${priv}|${ep}`;
  if (clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey);
  }

  if (clientCache.size > 50) {
    clientCache.clear();
  }

  const client = new ImageKit({
    publicKey: pub,
    privateKey: priv,
    urlEndpoint: ep,
  });
  clientCache.set(cacheKey, client);
  return client;
}

function getPrimaryAccount() {
  const isConfigured = Boolean(
    primaryConfig.publicKey && primaryConfig.privateKey && primaryConfig.urlEndpoint
  );
  return {
    id: 'primary',
    label: primaryConfig.label,
    publicKey: primaryConfig.publicKey,
    privateKey: primaryConfig.privateKey,
    urlEndpoint: primaryConfig.urlEndpoint,
    active: isConfigured,
    priority: 0,
    isPrimary: true,
    client: primaryImageKit,
  };
}

async function resolveSettingDoc(settingDoc) {
  if (settingDoc) return settingDoc;
  const Setting = require('../models/Setting');
  return Setting.getGlobal();
}

// Mengambil seluruh akun (Utama + semua Cadangan, termasuk yang nonaktif) untuk kebutuhan delete file & whitelist URL
async function getAllAccounts(settingDoc = null) {
  const setting = await resolveSettingDoc(settingDoc);
  const accounts = [getPrimaryAccount()];
  const backups = Array.isArray(setting?.imagekit_backups) ? setting.imagekit_backups : [];

  for (const b of backups) {
    if (!b || !b.id) continue;
    const ep = normalizeEndpoint(b.url_endpoint);
    const client = createClientFromCreds({
      publicKey: b.public_key,
      privateKey: b.private_key,
      urlEndpoint: ep,
    });
    if (!client) continue;

    accounts.push({
      id: String(b.id).trim(),
      label: String(b.label || b.id).trim(),
      publicKey: String(b.public_key || '').trim(),
      privateKey: String(b.private_key || '').trim(),
      urlEndpoint: ep,
      active: b.active !== false,
      priority: Number.isFinite(Number(b.priority)) ? Number(b.priority) : 1,
      isPrimary: false,
      client,
    });
  }

  return accounts;
}

// Pool khusus media sesi (Foto, Pose HD, Video, GIF, Print) dengan urutan failover dinamis
async function getSessionAccountPool(settingDoc = null) {
  const setting = await resolveSettingDoc(settingDoc);
  const all = await getAllAccounts(setting);

  const primary = all.find((a) => a.id === 'primary' && a.active);
  const activeBackups = all
    .filter((a) => !a.isPrimary && a.active)
    .sort((a, b) => a.priority - b.priority);

  const preferredId = String(setting?.imagekit_active_session_account || 'auto').trim();

  // Jika admin memilih akun cadangan tertentu sebagai prioritas utama, taruh di indeks ke-0
  if (preferredId && preferredId !== 'auto' && preferredId !== 'primary') {
    const preferred = activeBackups.find((a) => a.id === preferredId);
    if (preferred) {
      const restBackups = activeBackups.filter((a) => a.id !== preferredId);
      return [preferred, ...restBackups, ...(primary ? [primary] : [])];
    }
  }

  // Default ('auto' atau 'primary'): Utama dulu, lalu Cadangan urut prioritas
  return [...(primary ? [primary] : []), ...activeBackups];
}

async function getAccountById(accountId, settingDoc = null) {
  const id = String(accountId || '').trim();
  if (!id || id === 'primary') {
    return getPrimaryAccount();
  }
  const all = await getAllAccounts(settingDoc);
  return all.find((a) => a.id === id) || null;
}

async function getAccountByUrl(url, settingDoc = null) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl) return null;
  const all = await getAllAccounts(settingDoc);

  // Urutkan endpoint terpanjang dulu untuk menghindari salah cocok prefix
  const sorted = [...all]
    .filter((a) => a.urlEndpoint)
    .sort((a, b) => b.urlEndpoint.length - a.urlEndpoint.length);

  return sorted.find((a) => cleanUrl.startsWith(a.urlEndpoint)) || null;
}

async function getAllowedUrlEndpoints(settingDoc = null) {
  const all = await getAllAccounts(settingDoc);
  return [...new Set(all.map((a) => a.urlEndpoint).filter(Boolean))];
}

// Tempelkan helper ke instance primary agar export tetap kompatibel dengan require('../config/imagekit')
primaryImageKit.getPrimaryClient = () => primaryImageKit;
primaryImageKit.getPrimaryAccount = getPrimaryAccount;
primaryImageKit.createClientFromCreds = createClientFromCreds;
primaryImageKit.getAllAccounts = getAllAccounts;
primaryImageKit.getSessionAccountPool = getSessionAccountPool;
primaryImageKit.getAccountById = getAccountById;
primaryImageKit.getAccountByUrl = getAccountByUrl;
primaryImageKit.getAllowedUrlEndpoints = getAllowedUrlEndpoints;
primaryImageKit.normalizeEndpoint = normalizeEndpoint;

module.exports = primaryImageKit;