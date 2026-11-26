const path = require('path');
const imagekit = require('../config/imagekit');

function getPrefixByType(fileType) {
  if (fileType === 'raw') return 'raw-';
  if (fileType === 'video') return 'live-';
  if (fileType === 'gif') return 'slide-';
  if (fileType === 'print') return 'print-';
  return 'studio-';
}

// Khusus upload Frame & QRIS di Admin: SELALU memakai akun Primary (.env)
function getAuthParams() {
  return imagekit.getPrimaryClient().getAuthenticationParameters();
}

// Khusus upload Media Sesi (React Native Direct Upload): kembalikan pool token Primary + Cadangan
async function getSessionAuthPool(settingDoc = null) {
  const pool = await imagekit.getSessionAccountPool(settingDoc);
  return pool.map((acc) => {
    const auth = acc.client.getAuthenticationParameters();
    return {
      id: acc.id,
      label: acc.label,
      isPrimary: Boolean(acc.isPrimary),
      publicKey: acc.publicKey,
      urlEndpoint: acc.urlEndpoint,
      signature: auth.signature,
      expire: auth.expire,
      token: auth.token,
      folder: '/photobooth/sessions',
    };
  });
}

// Upload buffer dari server:
// - Folder '/photobooth/sessions' -> otomatis failover ke seluruh pool aktif
// - Folder lain (frames / qris)   -> terkunci hanya ke akun Primary (.env)
async function uploadBufferToImageKit(buffer, filename, folder = '/photobooth/sessions', settingDoc = null) {
  const isSessionFolder = String(folder || '').startsWith('/photobooth/sessions');

  if (!isSessionFolder) {
    const res = await imagekit.getPrimaryClient().upload({
      file: buffer,
      fileName: filename,
      folder,
      useUniqueFileName: false,
    });
    return {
      filename: res.name,
      url: res.url,
      fileId: res.fileId,
      storage_account_id: 'primary',
    };
  }

  const pool = await imagekit.getSessionAccountPool(settingDoc);
  if (!pool.length) {
    throw new Error('Tidak ada akun ImageKit aktif yang terkonfigurasi.');
  }

  let lastError = null;
  for (const acc of pool) {
    try {
      const res = await acc.client.upload({
        file: buffer,
        fileName: filename,
        folder,
        useUniqueFileName: false,
      });
      return {
        filename: res.name,
        url: res.url,
        fileId: res.fileId,
        storage_account_id: acc.id,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[ImageKit Failover] Upload gagal di akun "${acc.label}" (${acc.id}): ${err.message}`);
    }
  }

  throw lastError || new Error('Semua akun ImageKit gagal menerima upload.');
}

// Mirror frame dari URL luar: SELALU terkunci di akun Primary (.env)
async function mirrorUrlToImageKit(sourceUrl, filename, folder = '/photobooth/frames') {
  if (!sourceUrl || !sourceUrl.startsWith('http')) return null;
  const primary = imagekit.getPrimaryAccount();
  if (primary.urlEndpoint && sourceUrl.startsWith(primary.urlEndpoint)) {
    return { url: sourceUrl, fileId: '' };
  }
  const res = await primary.client.upload({
    file: sourceUrl,
    fileName: filename,
    folder,
    useUniqueFileName: true,
  });
  return {
    url: res.url,
    fileId: res.fileId,
  };
}

// Tes validitas kredensial ImageKit (untuk tombol Tes Koneksi di Admin Panel)
async function testImageKitAccount({ publicKey, privateKey, urlEndpoint }) {
  const client = imagekit.createClientFromCreds({ publicKey, privateKey, urlEndpoint });
  if (!client) {
    throw new Error('Public Key, Private Key, dan URL Endpoint wajib diisi lengkap.');
  }
  await client.listFiles({ limit: 1 });
  return { ok: true };
}

/**
 * Cari fileId di seluruh akun ImageKit (Primary + Cadangan) berdasarkan nama file.
 * Mengembalikan array objek [{ fileId, storage_account_id }] agar deleteFileIds menghapus di akun yang tepat.
 */
async function findSessionFileIdsByNames(filenames = [], settingDoc = null) {
  const cleanNames = [
    ...new Set(
      filenames
        .map((f) => path.basename(String(f || '').split('?')[0]).trim())
        .filter(Boolean)
    ),
  ];

  if (cleanNames.length === 0) return [];

  const allAccounts = await imagekit.getAllAccounts(settingDoc);
  const foundMap = new Map();

  for (const acc of allAccounts) {
    if (!acc.client || !acc.publicKey || !acc.privateKey) continue;

    for (let i = 0; i < cleanNames.length; i += 20) {
      const chunk = cleanNames.slice(i, i + 20);
      const escapedList = chunk.map((n) => `"${n.replace(/["\\]/g, '')}"`).join(', ');
      try {
        const files = await acc.client.listFiles({
          path: '/photobooth/sessions',
          searchQuery: `name IN [${escapedList}]`,
          limit: 100,
        });
        if (Array.isArray(files)) {
          files.forEach((f) => {
            if (f && f.fileId) {
              foundMap.set(`${acc.id}:${f.fileId}`, {
                fileId: f.fileId,
                storage_account_id: acc.id,
              });
            }
          });
        }
      } catch (err) {
        for (const name of chunk) {
          try {
            const single = await acc.client.listFiles({
              path: '/photobooth/sessions',
              searchQuery: `name = "${name.replace(/["\\]/g, '')}"`,
              limit: 5,
            });
            if (Array.isArray(single)) {
              single.forEach((f) => {
                if (f && f.fileId) {
                  foundMap.set(`${acc.id}:${f.fileId}`, {
                    fileId: f.fileId,
                    storage_account_id: acc.id,
                  });
                }
              });
            }
          } catch (_) {}
        }
      }
    }
  }

  return Array.from(foundMap.values());
}

/**
 * Hapus file di ImageKit lintas akun.
 * Menerima array string fileId (default 'primary') ATAU array objek { fileId, storage_account_id, url }.
 */
async function deleteFileIds(fileItems = [], settingDoc = null) {
  if (!Array.isArray(fileItems) || fileItems.length === 0) {
    return { deleted: 0, failed: [] };
  }

  const allAccounts = await imagekit.getAllAccounts(settingDoc);
  const accountMap = new Map(allAccounts.map((a) => [a.id, a]));
  const sortedByEndpoint = [...allAccounts]
    .filter((a) => a.urlEndpoint)
    .sort((a, b) => b.urlEndpoint.length - a.urlEndpoint.length);

  // Kelompokkan fileId berdasarkan akun pemiliknya
  const grouped = new Map();

  for (const item of fileItems) {
    if (!item) continue;

    let fileId = '';
    let accountId = '';
    let url = '';

    if (typeof item === 'string') {
      fileId = item.trim();
      accountId = 'primary';
    } else if (typeof item === 'object') {
      fileId = String(item.fileId || item.id || '').trim();
      accountId = String(item.storage_account_id || item.accountId || '').trim();
      url = String(item.url || '').trim();
    }

    if (!fileId) continue;

    // Jika accountId belum tercatat tapi ada URL, cocokkan dengan urlEndpoint akun
    if (!accountId && url) {
      const matched = sortedByEndpoint.find((a) => url.startsWith(a.urlEndpoint));
      if (matched) accountId = matched.id;
    }
    if (!accountId || !accountMap.has(accountId)) {
      accountId = 'primary';
    }

    if (!grouped.has(accountId)) grouped.set(accountId, new Set());
    grouped.get(accountId).add(fileId);
  }

  let deleted = 0;
  const failed = [];

  for (const [accountId, idSet] of grouped.entries()) {
    const acc = accountMap.get(accountId);
    if (!acc || !acc.client) continue;

    const cleanIds = Array.from(idSet);
    for (let i = 0; i < cleanIds.length; i += 100) {
      const chunk = cleanIds.slice(i, i + 100);
      try {
        const res = await acc.client.bulkDeleteFiles(chunk);
        const okCount = Array.isArray(res?.successfullyDeletedFileIds)
          ? res.successfullyDeletedFileIds.length
          : chunk.length;
        deleted += okCount;
      } catch (err) {
        for (const id of chunk) {
          try {
            await acc.client.deleteFile(id);
            deleted++;
          } catch (singleErr) {
            const msg = String(singleErr?.message || '');
            if (!msg.toLowerCase().includes('not found') && !msg.includes('404')) {
              failed.push({ id, accountId, error: msg });
            }
          }
        }
      }
    }
  }

  return { deleted, failed };
}

module.exports = {
  getPrefixByType,
  getAuthParams,
  getSessionAuthPool,
  uploadBufferToImageKit,
  mirrorUrlToImageKit,
  testImageKitAccount,
  findSessionFileIdsByNames,
  deleteFileIds,
};