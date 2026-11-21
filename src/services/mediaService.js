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
  // Jika sudah di ImageKit kita sendiri, tidak perlu upload ulang
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

async function deleteFileIds(fileIds = []) {
  const cleanIds = [...new Set(fileIds.filter(Boolean))];
  if (cleanIds.length === 0) return;

  // ImageKit bulkDeleteFiles menerima maks 100 fileId per panggilan
  for (let i = 0; i < cleanIds.length; i += 100) {
    const chunk = cleanIds.slice(i, i + 100);
    try {
      await imagekit.bulkDeleteFiles(chunk);
    } catch (err) {
      // Fallback hapus satu per satu jika ada fileId yang sudah terhapus duluan
      for (const id of chunk) {
        try {
          await imagekit.deleteFile(id);
        } catch (_) {}
      }
    }
  }
}

module.exports = {
  getPrefixByType,
  getAuthParams,
  uploadBufferToImageKit,
  mirrorUrlToImageKit,
  deleteFileIds,
};