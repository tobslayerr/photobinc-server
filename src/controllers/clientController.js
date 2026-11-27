const path = require('path');
const imagekit = require('../config/imagekit');
const Transaction = require('../models/Transaction');
const MediaAsset = require('../models/MediaAsset');

async function getAllowedImageKitMeta() {
  const endpoints = await imagekit.getAllowedUrlEndpoints();
  const hostnames = new Set(['ik.imagekit.io']);

  if (process.env.IMAGEKIT_URL_ENDPOINT) {
    try {
      hostnames.add(new URL(process.env.IMAGEKIT_URL_ENDPOINT).hostname);
    } catch (_) {}
  }

  for (const ep of endpoints) {
    try {
      hostnames.add(new URL(ep).hostname);
    } catch (_) {}
  }

  return { endpoints, hostnames };
}

async function isAllowedMediaUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;

    const { endpoints, hostnames } = await getAllowedImageKitMeta();
    if (hostnames.has(u.hostname)) return true;
    return endpoints.some((ep) => rawUrl.startsWith(ep));
  } catch {
    return false;
  }
}

function isImageKitHost(hostname, allowedHostnames) {
  if (hostname === 'ik.imagekit.io') return true;
  return Boolean(allowedHostnames && allowedHostnames.has(hostname));
}

function withImageKitOriginal(url, allowedHostnames = null) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (isImageKitHost(u.hostname, allowedHostnames)) {
      u.searchParams.set('tr', 'orig-true');
      return u.toString();
    }
  } catch (_) {}
  return url;
}

function withImageKitPreview(url, isImage, allowedHostnames = null) {
  if (!isImage || !url) return url;
  try {
    const u = new URL(url);
    if (isImageKitHost(u.hostname, allowedHostnames)) {
      u.searchParams.set('tr', 'w-800,q-85,f-auto');
      return u.toString();
    }
  } catch (_) {}
  return url;
}

function resolveExtension(filename, rawUrl, fallback = 'jpg') {
  let ext = path.extname(filename || '').replace('.', '').toLowerCase();
  if (!ext && rawUrl) {
    try {
      ext = path.extname(new URL(rawUrl).pathname).replace('.', '').toLowerCase();
    } catch (_) {}
  }
  if (ext === 'jpeg') ext = 'jpg';
  return ext || fallback;
}

function syncAliasExtension(aliasName, contentType) {
  const ct = String(contentType || '').toLowerCase();
  let detectedExt = '';

  if (ct.includes('image/png')) detectedExt = 'png';
  else if (ct.includes('image/webp')) detectedExt = 'webp';
  else if (ct.includes('image/jpeg') || ct.includes('image/jpg')) detectedExt = 'jpg';
  else if (ct.includes('image/gif')) detectedExt = 'gif';
  else if (ct.includes('video/mp4')) detectedExt = 'mp4';
  else if (ct.includes('video/webm')) detectedExt = 'webm';
  else if (ct.includes('video/quicktime')) detectedExt = 'mov';

  if (!detectedExt) return aliasName;

  const currentExt = path.extname(aliasName).replace('.', '').toLowerCase();
  if (currentExt === detectedExt || (currentExt === 'jpeg' && detectedExt === 'jpg')) {
    return aliasName;
  }

  const base = currentExt ? aliasName.slice(0, -(currentExt.length + 1)) : aliasName;
  return `${base}.${detectedExt}`;
}

async function resolveSessionMedia(req) {
  const oid = String(req.query.oid || '').trim();
  const filesEncoded = String(req.query.f || '').trim();
  let filenames = [];

  if (filesEncoded) {
    try {
      const decoded = Buffer.from(filesEncoded, 'base64').toString('utf8');
      filenames = decoded.split(',').map((s) => s.trim()).filter(Boolean);
    } catch (_) {}
  }

  let trx = null;
  if (oid) {
    trx = await Transaction.findOne({ order_id: oid }).sort({ createdAt: -1 }).lean();
    if (trx && trx.all_files) {
      filenames = trx.all_files.split(',').map((s) => s.trim()).filter(Boolean);
    }
  } else if (filenames.length > 0) {
    const sample = filenames[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    trx = await Transaction.findOne({ all_files: new RegExp(sample) }).sort({ createdAt: -1 }).lean();
    if (trx && trx.all_files) {
      const dbFiles = trx.all_files.split(',').map((s) => s.trim()).filter(Boolean);
      if (dbFiles.length > filenames.length) filenames = dbFiles;
    }
  }

  const urlMap = new Map();
  const typeMap = new Map();

  if (trx && Array.isArray(trx.media_assets)) {
    trx.media_assets.forEach((a) => {
      if (!a.filename) return;
      const cleanName = path.basename(a.filename.trim());
      if (a.url) urlMap.set(cleanName, a.url);
      if (a.type) typeMap.set(cleanName, String(a.type).toLowerCase());
    });
  }

  const cleanFilenames = filenames.map((fn) => path.basename(fn)).filter(Boolean);
  const missingNames = cleanFilenames.filter((fn) => !urlMap.has(fn) || !typeMap.has(fn));
  if (missingNames.length > 0) {
    const assetDocs = await MediaAsset.find({ filename: { $in: missingNames } }).lean();
    assetDocs.forEach((a) => {
      if (!a.filename) return;
      const cleanName = path.basename(a.filename.trim());
      if (a.url && !urlMap.has(cleanName)) urlMap.set(cleanName, a.url);
      if (a.type && !typeMap.has(cleanName)) typeMap.set(cleanName, String(a.type).toLowerCase());
    });
  }

  const { hostnames: allowedHostnames } = await getAllowedImageKitMeta();
  const fallbackEndpoint = (process.env.IMAGEKIT_URL_ENDPOINT || '').replace(/\/+$/, '');
  const urlsFrame = [];
  const urlsLive = [];
  const urlsGif = [];
  const urlsRaw = [];
  let isNewspaperHint = Boolean(trx && String(trx.package_name || '').toLowerCase().includes('news'));

  for (const clean of cleanFilenames) {
    const fullUrl = urlMap.get(clean) || (fallbackEndpoint ? `${fallbackEndpoint}/photobooth/sessions/${clean}` : '');
    if (!fullUrl) continue;

    const ext = resolveExtension(clean, fullUrl, '');

    if (
      /^news[-_]/i.test(clean) ||
      clean.toLowerCase().includes('newspaper') ||
      clean.toLowerCase().includes('koran')
    ) {
      isNewspaperHint = true;
    }

    const dbType = typeMap.get(clean) || '';
    const isRaw = dbType === 'raw' || /^(final_)?raw[-_]/i.test(clean);
    const isLive =
      dbType === 'video' ||
      /^(final_video|live)[-_]/i.test(clean) ||
      ['mp4', 'webm', 'mov'].includes(ext);
    const isSlide =
      dbType === 'gif' ||
      /^(final_gif|slide)[-_]/i.test(clean) ||
      (ext === 'gif' && !isRaw);

    const origUrl = withImageKitOriginal(fullUrl, allowedHostnames);

    if (isLive) urlsLive.push({ file: clean, url: origUrl, ext: ext || 'mp4' });
    else if (isSlide) urlsGif.push({ file: clean, url: origUrl, ext: ext || 'gif' });
    else if (isRaw) urlsRaw.push({ file: clean, url: origUrl, ext: ext || 'jpg' });
    else urlsFrame.push({ file: clean, url: origUrl, ext: ext || 'jpg' });
  }

  const isUploadComplete = urlsRaw.length > 0 && urlsFrame.length > 0;
  return {
    oid,
    filesEncoded,
    filenames: cleanFilenames,
    urlsFrame,
    urlsLive,
    urlsGif,
    urlsRaw,
    isUploadComplete,
    isNewspaperHint,
    allowedHostnames,
  };
}

exports.renderDownloadPage = async (req, res) => {
  try {
    const session = await resolveSessionMedia(req);
    const totalPosts =
      session.urlsFrame.length + session.urlsLive.length + session.urlsGif.length + session.urlsRaw.length;

    const nowTs = Math.floor(Date.now() / 1000);
    const mediaItems = [];

    session.urlsFrame.forEach((item, idx) => {
      const ext = item.ext || 'jpg';
      mediaItems.push({
        id: `frame_${idx}`,
        cat: 'frame',
        type: 'image',
        ext,
        filename: item.file,
        badge: idx === 0 ? 'FRAME UTAMA' : `FRAME #${idx + 1}`,
        thumbLabel: `Frame ${idx + 1}`,
        caption: 'Cakep banget! Ini dia hasil foto kolase frame kamu.',
        previewUrl: withImageKitPreview(item.url, true, session.allowedHostnames),
        url: item.url,
        alias_name: `Photobinc-Frame-${nowTs}-${idx + 1}.${ext}`,
        accent: '#facc15',
      });
    });

    session.urlsLive.forEach((item, idx) => {
      const ext = item.ext || 'mp4';
      mediaItems.push({
        id: `live_${idx}`,
        cat: 'live',
        type: 'video',
        ext,
        filename: item.file,
        badge: session.urlsLive.length > 1 ? `LIVE PHOTO #${idx + 1}` : 'LIVE PHOTO',
        thumbLabel: `Live ${idx + 1}`,
        caption: 'Momen di balik layar sebelum jepretan! Ala-ala Apple Live Photo.',
        previewUrl: item.url,
        url: item.url,
        alias_name: `Photobinc-Live-${idx + 1}-${nowTs}.${ext}`,
        accent: '#c084fc',
      });
    });

    session.urlsGif.forEach((item, idx) => {
      const ext = item.ext || 'gif';
      mediaItems.push({
        id: `gif_${idx}`,
        cat: 'gif',
        type: 'gif',
        ext,
        filename: item.file,
        badge: 'ANIMASI GIF',
        thumbLabel: `GIF ${idx + 1}`,
        caption: 'Gerak-gerak gemes! Klik "Video IG" biar tajam saat upload ke IG Story.',
        previewUrl: item.url,
        url: item.url,
        alias_name: `Photobinc-GIF-${nowTs}-${idx + 1}.${ext}`,
        accent: '#f472b6',
      });
    });

    session.urlsRaw.forEach((item, idx) => {
      const ext = item.ext || 'jpg';
      mediaItems.push({
        id: `raw_${idx}`,
        cat: 'raw',
        type: 'image',
        ext,
        filename: item.file,
        badge: `MENTAHAN ${idx + 1}`,
        thumbLabel: `Pose ${idx + 1}`,
        caption: 'Foto Full HD asli tanpa bingkai buat diedit suka-suka.',
        previewUrl: withImageKitPreview(item.url, true, session.allowedHostnames),
        url: item.url,
        alias_name: `Photobinc-RAW-${idx + 1}-${nowTs}.${ext}`,
        accent: '#38bdf8',
      });
    });

    const availableCats = [];
    if (session.urlsFrame.length > 0) availableCats.push({ key: 'frame', label: 'FRAME', count: session.urlsFrame.length, icon: 'ri-image-2-fill', color: '#facc15' });
    if (session.urlsLive.length > 0) availableCats.push({ key: 'live', label: 'LIVE', count: session.urlsLive.length, icon: 'ri-movie-2-fill', color: '#c084fc' });
    if (session.urlsGif.length > 0) availableCats.push({ key: 'gif', label: 'GIF', count: session.urlsGif.length, icon: 'ri-sparkling-fill', color: '#f472b6' });
    if (session.urlsRaw.length > 0) availableCats.push({ key: 'raw', label: 'POSE HD', count: session.urlsRaw.length, icon: 'ri-camera-3-fill', color: '#38bdf8' });

    let liveArUrl = '';
    if (session.urlsFrame.length > 0 && session.urlsLive.length > 0) {
      const qs = new URLSearchParams();
      if (session.oid) qs.set('oid', session.oid);
      if (session.filesEncoded) qs.set('f', session.filesEncoded);
      else if (session.filenames.length > 0) {
        qs.set('f', Buffer.from(session.filenames.join(','), 'utf8').toString('base64'));
      }
      liveArUrl = `/live-ar?${qs.toString()}`;
    }

    return res.render('client/download', {
      profileImg:
        process.env.PROFILE_IMG_URL ||
        'https://photobinc.erafmunj.com/wp-content/uploads/2026/09/Insta_Saver_@photobinc_dp_HD-1.jpg',
      oid: session.oid,
      totalPosts,
      isUploadComplete: session.isUploadComplete,
      liveArUrl,
      mediaItems,
      availableCats,
    });
  } catch (err) {
    return res.status(500).send(`Terjadi kesalahan memuat galeri: ${err.message}`);
  }
};

exports.renderLiveArPage = async (req, res) => {
  try {
    const session = await resolveSessionMedia(req);
    const frameUrls = session.urlsFrame.map((x) => `/api/ar-target?url=${encodeURIComponent(x.url)}`);
    const liveUrls = session.urlsLive.map((x) => x.url);

    return res.render('client/live-ar', {
      frameUrls,
      liveUrls,
      previewFrameUrl: frameUrls[0] || '',
      isNewspaperHint: session.isNewspaperHint,
    });
  } catch (err) {
    return res.status(500).send(`Terjadi kesalahan memuat Live AR: ${err.message}`);
  }
};

// FORCE DOWNLOAD FULL RESOLUSI (ANTI-PREVIEW, ANTI-CORS, SUPPORT PNG/JPG 4:4:4 & MULTI-ACCOUNT IMAGEKIT)
exports.proxyDownload = async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    const rawAlias = String(req.query.name || 'photobinc-media').replace(/[^a-zA-Z0-9._-]/g, '_');

    if (!rawUrl || !(await isAllowedMediaUrl(rawUrl))) {
      return res.status(400).send('URL media tidak valid.');
    }

    const { hostnames: allowedHostnames } = await getAllowedImageKitMeta();
    const origUrl = withImageKitOriginal(rawUrl, allowedHostnames);
    const attachmentUrlObj = new URL(origUrl);
    if (isImageKitHost(attachmentUrlObj.hostname, allowedHostnames)) {
      attachmentUrlObj.searchParams.set('ik-attachment', 'true');
    }
    const directAttachmentUrl = attachmentUrlObj.toString();

    let contentLength = 0;
    const headController = new AbortController();
    const headTimer = setTimeout(() => headController.abort(), 4000);
    try {
      const headRes = await fetch(origUrl, { method: 'HEAD', signal: headController.signal });
      if (headRes.ok) {
        contentLength = parseInt(headRes.headers.get('content-length') || '0', 10);
      }
    } catch (_) {
    } finally {
      clearTimeout(headTimer);
    }

    const MAX_VERCEL_BYTES = 3800000; // 3.8 MB aman di bawah limit 4.5 MB Vercel

    // File > 3.8 MB (misal Frame Full-HD 4:4:4 / PNG Lossless / Live Video 15 detik):
    // langsung redirect ke ImageKit orig-true + ik-attachment agar 100% utuh tanpa terpotong limit Vercel
    if (contentLength > MAX_VERCEL_BYTES) {
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, directAttachmentUrl);
    }

    const upstream = await fetch(origUrl);
    if (!upstream.ok) {
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, directAttachmentUrl);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_VERCEL_BYTES) {
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, directAttachmentUrl);
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const finalAliasName = syncAliasExtension(rawAlias, contentType);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${finalAliasName}"`);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buf);
  } catch (err) {
    return res.status(500).send('Gagal mengunduh file: ' + err.message);
  }
};

// SAME-ORIGIN PROXY GAMBAR TARGET WEBAR & THUMBNAIL OPERATOR (100% BEBAS CORS & MULTI-ACCOUNT IMAGEKIT)
exports.proxyArTarget = async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    const maxW = Math.min(1200, Math.max(300, parseInt(req.query.w || '900', 10) || 900));

    if (!rawUrl || !(await isAllowedMediaUrl(rawUrl))) {
      return res.status(400).send('URL gambar tidak valid.');
    }

    const { hostnames: allowedHostnames } = await getAllowedImageKitMeta();

    let fetchUrl = rawUrl;
    try {
      const u = new URL(rawUrl);
      if (isImageKitHost(u.hostname, allowedHostnames)) {
        u.searchParams.set('tr', `w-${maxW},q-90,f-jpg`);
        fetchUrl = u.toString();
      }
    } catch (_) {}

    let imgRes = await fetch(fetchUrl);
    if (!imgRes.ok) {
      imgRes = await fetch(withImageKitOriginal(rawUrl, allowedHostnames));
    }
    if (!imgRes.ok) {
      return res.status(imgRes.status).send('Gagal mengambil gambar dari storage.');
    }

    const buf = Buffer.from(await imgRes.arrayBuffer());
    res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(buf);
  } catch (err) {
    return res.status(500).send('Proxy gambar gagal: ' + err.message);
  }
};