const Setting = require('../models/Setting');
const Frame = require('../models/Frame');
const { mirrorUrlToImageKit } = require('./mediaService');

const toInt = (val, fallback = 0) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Mengimpor file JSON export dari WordPress (photobooth-frame-settings-*.json)
 * ke MongoDB, opsional menyalin semua gambar PNG frame ke ImageKit.io
 */
async function importFromWordPressJson(data, { mirrorImages = true } = {}) {
  if (!data || typeof data !== 'object') {
    throw new Error('Format JSON tidak valid.');
  }

  // 1. Update Setting Global
  const setting = await Setting.getGlobal();
  if (data.ef_pb_environment) setting.environment = data.ef_pb_environment;
  if (data.ef_pb_midtrans_server_key !== undefined) setting.midtrans_server_key = String(data.ef_pb_midtrans_server_key);
  if (data.ef_pb_midtrans_client_key !== undefined) setting.midtrans_client_key = String(data.ef_pb_midtrans_client_key);
  if (data.ef_pb_use_midtrans) setting.use_midtrans = data.ef_pb_use_midtrans;
  if (data.ef_pb_manual_qris_url !== undefined) setting.manual_qris_url = String(data.ef_pb_manual_qris_url);
  if (data.ef_pb_price_strip !== undefined) setting.price_strip = toInt(data.ef_pb_price_strip, 15000);
  if (data.ef_pb_price_news !== undefined) setting.price_news = toInt(data.ef_pb_price_news, 20000);
  if (data.ef_pb_price_strip_promo !== undefined) setting.price_strip_promo = toInt(data.ef_pb_price_strip_promo, 12000);
  if (data.ef_pb_timer !== undefined) setting.timer = toInt(data.ef_pb_timer, 6);
  await setting.save();

  let importedStrips = 0;
  let importedNews = 0;
  let mirroredImages = 0;

  // 2. Import 18 Frame Classic Strip
  for (let i = 1; i <= 18; i++) {
    let url = String(data[`pb_strip_f${i}_url`] || '').trim();
    let urlFileId = '';

    if (url && mirrorImages) {
      try {
        const mirrored = await mirrorUrlToImageKit(url, `strip_f${i}.png`, '/photobooth/frames');
        if (mirrored && mirrored.url) {
          url = mirrored.url;
          urlFileId = mirrored.fileId || '';
          mirroredImages++;
        }
      } catch (e) {
        console.warn(`[Import] Gagal mirror strip_f${i}, pakai URL asli:`, e.message);
      }
    }

    const slots = {};
    for (let j = 1; j <= 6; j++) {
      slots[`p${j}`] = {
        x: toInt(data[`pb_strip_f${i}_p${j}_x`], 0),
        y: toInt(data[`pb_strip_f${i}_p${j}_y`], 0),
        w: toInt(data[`pb_strip_f${i}_p${j}_w`], 0),
        h: toInt(data[`pb_strip_f${i}_p${j}_h`], 0),
      };
    }

    const activeRaw = data[`pb_strip_f${i}_active`];
    const active = activeRaw === undefined || activeRaw === '' ? Boolean(url) : toInt(activeRaw, 0) === 1;

    await Frame.findOneAndUpdate(
      { type: 'strip', original_id: i },
      {
        $set: {
          type: 'strip',
          original_id: i,
          active,
          order: toInt(data[`pb_strip_f${i}_order`], i),
          url,
          ...(urlFileId ? { url_file_id: urlFileId } : {}),
          w: toInt(data[`pb_strip_f${i}_w`], 1200),
          h: toInt(data[`pb_strip_f${i}_h`], 1800),
          shots: 3,
          slots,
        },
      },
      { upsert: true, new: true }
    );
    if (url) importedStrips++;
  }

  // 3. Import 3 Frame Newspaper
  for (let i = 1; i <= 3; i++) {
    let url = String(data[`pb_news_f${i}_url`] || '').trim();
    let digitalUrl = String(data[`pb_news_f${i}_digital_url`] || '').trim();
    let urlFileId = '';
    let digitalFileId = '';

    if (url && mirrorImages) {
      try {
        const mirrored = await mirrorUrlToImageKit(url, `news_f${i}_print.png`, '/photobooth/frames');
        if (mirrored && mirrored.url) {
          url = mirrored.url;
          urlFileId = mirrored.fileId || '';
          mirroredImages++;
        }
      } catch (e) {
        console.warn(`[Import] Gagal mirror news_f${i}_url, pakai URL asli:`, e.message);
      }
    }

    if (digitalUrl && mirrorImages) {
      try {
        const mirrored = await mirrorUrlToImageKit(digitalUrl, `news_f${i}_digital.png`, '/photobooth/frames');
        if (mirrored && mirrored.url) {
          digitalUrl = mirrored.url;
          digitalFileId = mirrored.fileId || '';
          mirroredImages++;
        }
      } catch (e) {
        console.warn(`[Import] Gagal mirror news_f${i}_digital_url, pakai URL asli:`, e.message);
      }
    }

    const slots = {};
    for (let j = 1; j <= 2; j++) {
      slots[`p${j}`] = {
        x: toInt(data[`pb_news_f${i}_p${j}_x`], 0),
        y: toInt(data[`pb_news_f${i}_p${j}_y`], 0),
        w: toInt(data[`pb_news_f${i}_p${j}_w`], 0),
        h: toInt(data[`pb_news_f${i}_p${j}_h`], 0),
      };
    }

    const activeRaw = data[`pb_news_f${i}_active`];
    const active = activeRaw === undefined || activeRaw === '' ? Boolean(url) : toInt(activeRaw, 0) === 1;

    await Frame.findOneAndUpdate(
      { type: 'news', original_id: i },
      {
        $set: {
          type: 'news',
          original_id: i,
          active,
          order: toInt(data[`pb_news_f${i}_order`], i),
          url,
          ...(urlFileId ? { url_file_id: urlFileId } : {}),
          digital_url: digitalUrl || url,
          ...(digitalFileId ? { digital_url_file_id: digitalFileId } : {}),
          w: toInt(data[`pb_news_f${i}_w`], 1200),
          h: toInt(data[`pb_news_f${i}_h`], 1600),
          shots: 2,
          slots,
        },
      },
      { upsert: true, new: true }
    );
    if (url) importedNews++;
  }

  return { importedStrips, importedNews, mirroredImages };
}

/**
 * Mengekspor seluruh Setting & Frame dari MongoDB kembali ke format JSON WordPress
 * sehingga bisa langsung di-import ulang ke WordPress kapan saja.
 */
async function exportToWordPressJson() {
  const setting = await Setting.getGlobal();
  const frames = await Frame.find({}).lean();

  const out = {
    ef_pb_environment: setting.environment,
    ef_pb_midtrans_server_key: setting.midtrans_server_key,
    ef_pb_midtrans_client_key: setting.midtrans_client_key,
    ef_pb_use_midtrans: setting.use_midtrans,
    ef_pb_manual_qris_url: setting.manual_qris_url,
    ef_pb_price_strip: String(setting.price_strip),
    ef_pb_price_news: String(setting.price_news),
    ef_pb_price_strip_promo: String(setting.price_strip_promo),
    ef_pb_timer: String(setting.timer),
  };

  const frameMap = new Map(frames.map((f) => [`${f.type}_${f.original_id}`, f]));

  for (let i = 1; i <= 18; i++) {
    const f = frameMap.get(`strip_${i}`);
    out[`pb_strip_f${i}_active`] = f ? (f.active ? '1' : '0') : '0';
    out[`pb_strip_f${i}_order`] = f ? String(f.order) : String(i);
    out[`pb_strip_f${i}_url`] = f ? f.url || '' : '';
    out[`pb_strip_f${i}_w`] = f ? String(f.w) : '1200';
    out[`pb_strip_f${i}_h`] = f ? String(f.h) : '1800';
    for (let j = 1; j <= 6; j++) {
      const p = f?.slots?.[`p${j}`] || {};
      out[`pb_strip_f${i}_p${j}_x`] = String(p.x || 0);
      out[`pb_strip_f${i}_p${j}_y`] = String(p.y || 0);
      out[`pb_strip_f${i}_p${j}_w`] = String(p.w || 0);
      out[`pb_strip_f${i}_p${j}_h`] = String(p.h || 0);
    }
  }

  for (let i = 1; i <= 3; i++) {
    const f = frameMap.get(`news_${i}`);
    out[`pb_news_f${i}_active`] = f ? (f.active ? '1' : '0') : '0';
    out[`pb_news_f${i}_order`] = f ? String(f.order) : String(i);
    out[`pb_news_f${i}_url`] = f ? f.url || '' : '';
    out[`pb_news_f${i}_digital_url`] = f ? f.digital_url || '' : '';
    out[`pb_news_f${i}_w`] = f ? String(f.w) : '1200';
    out[`pb_news_f${i}_h`] = f ? String(f.h) : '1600';
    for (let j = 1; j <= 2; j++) {
      const p = f?.slots?.[`p${j}`] || {};
      out[`pb_news_f${i}_p${j}_x`] = String(p.x || 0);
      out[`pb_news_f${i}_p${j}_y`] = String(p.y || 0);
      out[`pb_news_f${i}_p${j}_w`] = String(p.w || 0);
      out[`pb_news_f${i}_p${j}_h`] = String(p.h || 0);
    }
  }

  return out;
}

module.exports = {
  importFromWordPressJson,
  exportToWordPressJson,
};