const path = require('path');
const imagekit = require('../config/imagekit');

function getPrefixByType(fileType) {
  if (fileType === 'raw') return 'raw-';
  if (fileType === 'video') return 'live-';
  if (fileType === 'gif') return 'slide-';
  if (fileType === 'print') return 'print-';
  return 'studio-';
}

function getAuthParams() {
  return imagekit.getAuthenticationParameters();
}

async function uploadBufferToImageKit(buffer, filename, folder = '/photobooth/sessions') {
  const res = await imagekit.upload({
    file: buffer,
    fileName: filename,
    folder,
    useUniqueFileName: false,
  });
  return {
    filename: res.name,
    url: res.url,
    fileId: res.fileId,
  };
}

async function mirrorUrlToImageKit(sourceUrl, filename, folder = '/photobooth/frames') {
  if (!sourceUrl || !sourceUrl.startsWith('http')) return null;
  if (process.env.IMAGEKIT_URL_ENDPOINT && sourceUrl.startsWith(process.env.IMAGEKIT_URL_ENDPOINT)) {
    return { url: sourceUrl, fileId: '' };
  }
  const res = await imagekit.upload({
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

/**
 * Cari fileId langsung di folder /photobooth/sessions ImageKit berdasarkan daftar nama file
 * (pengaman jika fileId belum sempat tercatat di MongoDB)
 */
async function findSessionFileIdsByNames(filenames = []) {
  const cleanNames = [
    ...new Set(
      filenames
        .map((f) => path.basename(String(f || '').split('?')[0]).trim())
        .filter(Boolean)
    ),
  ];

  if (cleanNames.length === 0) return [];

  const foundIds = [];
  for (let i = 0; i < cleanNames.length; i += 20) {
    const chunk = cleanNames.slice(i, i + 20);
    const escapedList = chunk.map((n) => `"${n.replace(/["\\]/g, '')}"`).join(', ');
    try {
      const files = await imagekit.listFiles({
        path: '/photobooth/sessions',
        searchQuery: `name IN [${escapedList}]`,
        limit: 100,
      });
      if (Array.isArray(files)) {
        files.forEach((f) => {
          if (f && f.fileId) foundIds.push(f.fileId);
        });
      }
    } catch (err) {
      // Fallback cari satu per satu jika query IN gagal
      for (const name of chunk) {
        try {
          const single = await imagekit.listFiles({
            path: '/photobooth/sessions',
            searchQuery: `name = "${name.replace(/["\\]/g, '')}"`,
            limit: 5,
          });
          if (Array.isArray(single)) {
            single.forEach((f) => {
              if (f && f.fileId) foundIds.push(f.fileId);
            });
          }
        } catch (_) {}
      }
    }
  }

  return [...new Set(foundIds)];
}

async function deleteFileIds(fileIds = []) {
  const cleanIds = [...new Set(fileIds.filter(Boolean))];
  if (cleanIds.length === 0) return { deleted: 0, failed: [] };

  let deleted = 0;
  const failed = [];

  for (let i = 0; i < cleanIds.length; i += 100) {
    const chunk = cleanIds.slice(i, i + 100);
    try {
      const res = await imagekit.bulkDeleteFiles(chunk);
      const okCount = Array.isArray(res?.successfullyDeletedFileIds)
        ? res.successfullyDeletedFileIds.length
        : chunk.length;
      deleted += okCount;
    } catch (err) {
      // Jika ada 1 fileId yang sudah hilang duluan, bulkDelete bisa throw -> hapus satu per satu
      for (const id of chunk) {
        try {
          await imagekit.deleteFile(id);
          deleted++;
        } catch (singleErr) {
          const msg = String(singleErr?.message || '');
          // Abaikan jika memang sudah tidak ada di ImageKit (404)
          if (!msg.toLowerCase().includes('not found') && !msg.includes('404')) {
            failed.push({ id, error: msg });
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
  uploadBufferToImageKit,
  mirrorUrlToImageKit,
  findSessionFileIdsByNames,
  deleteFileIds,
};