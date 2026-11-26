const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
const path = require('path');

const Setting = require('../models/Setting');
const Frame = require('../models/Frame');
const Voucher = require('../models/Voucher');
const Transaction = require('../models/Transaction');
const MediaAsset = require('../models/MediaAsset');
const { getAuthParams, findSessionFileIdsByNames, deleteFileIds } = require('../services/mediaService');
const { importFromWordPressJson, exportToWordPressJson } = require('../services/frameMapper');

const BULAN_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const MAX_STRIP_SLOTS = (Frame.LIMITS && Frame.LIMITS.strip) || 18;
const MAX_NEWS_SLOTS = (Frame.LIMITS && Frame.LIMITS.news) || 4;

function toInt(val, fallback = 0) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(val, fallback = 0) {
  if (val === '' || val === null || val === undefined) return fallback;
  const normalized = String(val).trim().replace(',', '.');
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : fallback;
}

function normalizeBasePackage(pkgName = '') {
  const low = String(pkgName).toLowerCase().trim();
  if (low.startsWith('strip_promo')) return 'STRIP_PROMO';
  if (low.startsWith('news')) return 'NEWS';
  return 'STRIP';
}

function resolveMappedFrame(frameInfo, packageName, frameMap) {
  const info = String(frameInfo || '').trim();
  const basePkg = normalizeBasePackage(packageName);
  const matchNum = /(\d+)/.exec(info);
  const id = matchNum ? parseInt(matchNum[1], 10) : 0;

  let type = '';
  if (info.toLowerCase().includes('strip')) type = 'strip';
  else if (info.toLowerCase().includes('news')) type = 'news';
  else if (id > 0) type = basePkg === 'NEWS' ? 'news' : 'strip';

  if (type && id > 0) {
    const f = frameMap.get(`${type}_${id}`);
    const order = f ? f.order : id;
    const labelType = type === 'news' ? 'News' : 'Strip';
    return {
      key: `${type}_${id}`,
      label: `Desain ${labelType} ${id} (Urutan ${order})`,
      url: f ? f.digital_url || f.url || '' : '',
      original_id: id,
      type,
    };
  }
  return { key: '', label: info || '-', url: '', original_id: 0, type: '' };
}

function buildSalesDateFilter(filter, startDate, endDate) {
  const nowWib = dayjs().tz('Asia/Jakarta');
  const query = { status: 'lunas' };

  if (filter === 'today') {
    const todayStr = nowWib.format('YYYY-MM-DD');
    query.created_at_wib = { $gte: `${todayStr} 00:00:00`, $lte: `${todayStr} 23:59:59` };
  } else if (filter === 'week') {
    const dayOfWeek = nowWib.day(); // 0 = Minggu, 1 = Senin
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = nowWib.subtract(diffToMonday, 'day').format('YYYY-MM-DD');
    const sunday = nowWib.add(6 - diffToMonday, 'day').format('YYYY-MM-DD');
    query.created_at_wib = { $gte: `${monday} 00:00:00`, $lte: `${sunday} 23:59:59` };
  } else if (filter === 'range' && startDate && endDate) {
    query.created_at_wib = { $gte: `${startDate} 00:00:00`, $lte: `${endDate} 23:59:59` };
  }

  return query;
}

// =========================================================================
// 1. REKAP PENJUALAN (/admin/sales)
// =========================================================================
exports.getSalesPage = async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all');
    const startDate = String(req.query.start_date || '');
    const endDate = String(req.query.end_date || '');

    const query = buildSalesDateFilter(filter, startDate, endDate);
    const [transactions, allFrames, allLunasFrames] = await Promise.all([
      Transaction.find(query).sort({ created_at_wib: 1 }).lean(),
      Frame.find({}).lean(),
      Transaction.find({ status: 'lunas', frame_info: { $ne: '' } }).select('frame_info package_name').lean(),
    ]);

    const frameMap = new Map(allFrames.map((f) => [`${f.type}_${f.original_id}`, f]));
    const groupedMap = new Map();

    let totalRevenue = 0;
    const chartPackages = { STRIP: 0, NEWS: 0, STRIP_PROMO: 0 };
    const chartAddons = { STRIP: 0, NEWS: 0, STRIP_PROMO: 0 };
    const chartFrames = {};

    for (const row of transactions) {
      const parentId = row.parent_order_id || row.order_id;
      if (!groupedMap.has(parentId)) {
        groupedMap.set(parentId, {
          order_id: parentId,
          date: row.created_at_wib,
          items: [],
          total: 0,
        });
      }

      const isAddon = Boolean(row.parent_order_id && row.parent_order_id !== row.order_id);
      const basePkg = normalizeBasePackage(row.package_name);
      const mapped = resolveMappedFrame(row.frame_info, row.package_name, frameMap);

      const group = groupedMap.get(parentId);
      group.items.push({
        id: row.order_id,
        name: String(row.package_name || '').toUpperCase(),
        frame: mapped.label,
        link: row.media_link || '',
        files: row.all_files ? row.all_files.split(',').map((s) => s.trim()).filter(Boolean) : [],
        is_addon: isAddon,
        print_status: row.print_status || 0,
        payment_method: String(row.payment_method || 'QRIS').toUpperCase(),
      });
      group.total += Number(row.amount || 0);
      totalRevenue += Number(row.amount || 0);

      if (isAddon) {
        if (chartAddons[basePkg] !== undefined) chartAddons[basePkg]++;
      } else {
        if (chartPackages[basePkg] !== undefined) chartPackages[basePkg]++;
      }

      if (row.frame_info) {
        const fKey = mapped.label.toUpperCase();
        chartFrames[fKey] = (chartFrames[fKey] || 0) + 1;
      }
    }

    // Urutkan terbaru di atas
    const groupedList = Array.from(groupedMap.values()).reverse();

    // Statistik visual desain frame terfavorit (all-time lunas)
    const favMap = new Map();
    for (const row of allLunasFrames) {
      const mapped = resolveMappedFrame(row.frame_info, row.package_name, frameMap);
      if (!mapped.key) continue;
      if (!favMap.has(mapped.key)) {
        favMap.set(mapped.key, { label: mapped.label, url: mapped.url, qty: 0 });
      }
      favMap.get(mapped.key).qty++;
    }
    const favoriteFrames = Array.from(favMap.values()).sort((a, b) => b.qty - a.qty);

    return res.render('admin/sales', {
      pageTitle: 'Rekap Penjualan',
      activeMenu: 'sales',
      filter,
      startDate,
      endDate,
      totalRevenue,
      groupedList,
      chartPackages,
      chartAddons,
      chartFrames,
      favoriteFrames,
    });
  } catch (err) {
    return res.status(500).send(`Error memuat rekap penjualan: ${err.message}`);
  }
};

exports.exportSalesExcel = async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all');
    const startDate = String(req.query.start_date || '');
    const endDate = String(req.query.end_date || '');

    const query = buildSalesDateFilter(filter, startDate, endDate);
    const [transactions, allFrames] = await Promise.all([
      Transaction.find(query).sort({ created_at_wib: 1 }).lean(),
      Frame.find({}).lean(),
    ]);
    const frameMap = new Map(allFrames.map((f) => [`${f.type}_${f.original_id}`, f]));

    const tsName = dayjs().tz('Asia/Jakarta').format('YYYYMMDD_HHmm');
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=Rekap_Photobooth_${tsName}.xls`);

    let html =
      '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>' +
      '<table border="1" style="font-family: Arial, sans-serif; font-size: 12px;">' +
      '<tr style="background-color:#1e293b; color:#ffffff; font-weight:bold; text-align:center;">' +
      '<th>TANGGAL & WAKTU (WIB)</th><th>INVOICE ID</th><th>TIPE ORDER</th><th>PAKET</th>' +
      '<th>METODE BAYAR</th><th>FRAME DIPILIH</th><th>HARGA</th><th>LINK ALBUM</th><th>DAFTAR FILE MEDIA</th></tr>';

    for (const row of transactions) {
      const isAddon = Boolean(row.parent_order_id && row.parent_order_id !== row.order_id);
      const bg = isAddon ? '#fef08a' : '#f8fafc';
      const mapped = resolveMappedFrame(row.frame_info, row.package_name, frameMap);
      const method = String(row.payment_method || 'QRIS').toUpperCase();
      html += `<tr style="background-color:${bg};">
        <td>${row.created_at_wib}</td>
        <td>${row.order_id}</td>
        <td>${isAddon ? 'Addon' : 'Utama'}</td>
        <td>${String(row.package_name || '').toUpperCase()}</td>
        <td>${method}</td>
        <td>${mapped.label}</td>
        <td>${row.amount}</td>
        <td>${row.media_link || ''}</td>
        <td>${String(row.all_files || '').replace(/,/g, ', ')}</td>
      </tr>`;
    }

    html += '</table></body></html>';
    return res.send(html);
  } catch (err) {
    return res.status(500).send(`Gagal export Excel: ${err.message}`);
  }
};

exports.deleteInvoice = async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) return res.status(400).json({ success: false, message: 'Order ID kosong.' });

    const rows = await Transaction.find({
      $or: [{ order_id: orderId }, { parent_order_id: orderId }],
    }).lean();

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan.' });
    }

    const fileIdSet = new Set();
    const filenameSet = new Set();
    const orderIds = rows.map((r) => r.order_id);

    const addFilenameFromUrl = (rawUrl) => {
      if (!rawUrl) return;
      try {
        const u = new URL(rawUrl);
        const base = path.basename(u.pathname).trim();
        if (base) filenameSet.add(base);
      } catch (_) {
        const base = path.basename(String(rawUrl).split('?')[0]).trim();
        if (base) filenameSet.add(base);
      }
    };

    for (const r of rows) {
      if (r.print_file_id) fileIdSet.add(r.print_file_id);
      if (r.print_url) addFilenameFromUrl(r.print_url);

      if (Array.isArray(r.media_assets)) {
        for (const a of r.media_assets) {
          if (a.fileId) fileIdSet.add(a.fileId);
          if (a.filename) filenameSet.add(path.basename(a.filename.trim()));
          if (a.url) addFilenameFromUrl(a.url);
        }
      }

      if (r.all_files) {
        r.all_files.split(',').forEach((f) => {
          const clean = path.basename(f.trim());
          if (clean) filenameSet.add(clean);
        });
      }

      // Cek juga parameter ?f= (base64) di media_link sebagai cadangan
      if (r.media_link) {
        try {
          const fParam = new URL(r.media_link).searchParams.get('f');
          if (fParam) {
            Buffer.from(fParam, 'base64')
              .toString('utf8')
              .split(',')
              .forEach((f) => {
                const clean = path.basename(f.trim());
                if (clean) filenameSet.add(clean);
              });
          }
        } catch (_) {}
      }
    }

    const filenames = Array.from(filenameSet);

    // 1. Cari fileId dari koleksi MediaAsset
    if (filenames.length > 0 || orderIds.length > 0) {
      const assets = await MediaAsset.find({
        $or: [{ filename: { $in: filenames } }, { order_id: { $in: orderIds } }],
      }).lean();
      assets.forEach((a) => {
        if (a.fileId) fileIdSet.add(a.fileId);
        if (a.filename) filenameSet.add(path.basename(a.filename.trim()));
      });
    }

    // 2. Sapu langsung ke API ImageKit (/photobooth/sessions) jika ada file yg belum tercatat fileId-nya
    const resolvedFromIk = await findSessionFileIdsByNames(Array.from(filenameSet));
    resolvedFromIk.forEach((id) => fileIdSet.add(id));

    // 3. Hapus seluruh file fisik di ImageKit.io
    const deleteResult = await deleteFileIds(Array.from(fileIdSet));

    // 4. Hapus catatan transaksi & MediaAsset di MongoDB
    await Promise.all([
      Transaction.deleteMany({ $or: [{ order_id: orderId }, { parent_order_id: orderId }] }),
      MediaAsset.deleteMany({
        $or: [{ filename: { $in: Array.from(filenameSet) } }, { order_id: { $in: orderIds } }],
      }),
    ]);

    return res.json({
      success: true,
      deletedFiles: deleteResult.deleted,
      failedCount: deleteResult.failed.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// 2. SETTING FRAME, HARGA, DESIMAL & DRAG-DROP URUTAN (/admin/frames)
// =========================================================================
exports.getFramesPage = async (req, res) => {
  try {
    const [setting, existingFrames] = await Promise.all([
      Setting.getGlobal(),
      Frame.find({}).lean(),
    ]);
    const frameMap = new Map(existingFrames.map((f) => [`${f.type}_${f.original_id}`, f]));

    const stripFrames = [];
    for (let i = 1; i <= MAX_STRIP_SLOTS; i++) {
      const f = frameMap.get(`strip_${i}`);
      const defaultSlots = {};
      for (let p = 1; p <= 6; p++) {
        const s = f?.slots?.[`p${p}`];
        defaultSlots[`p${p}`] = s
          ? {
              x: toFloat(s.x, 0),
              y: toFloat(s.y, 0),
              w: toFloat(s.w, 0),
              h: toFloat(s.h, 0),
            }
          : {
              x: p <= 3 ? 80 : 680,
              y: 120 + (p <= 3 ? p - 1 : p - 4) * 390,
              w: 440,
              h: 330,
            };
      }
      stripFrames.push({
        original_id: i,
        active: f ? Boolean(f.active) : false,
        order: f ? toInt(f.order, i) : i,
        url: f ? f.url || '' : '',
        w: f && Number.isFinite(Number(f.w)) && Number(f.w) > 0 ? toFloat(f.w, 1200) : 1200,
        h: f && Number.isFinite(Number(f.h)) && Number(f.h) > 0 ? toFloat(f.h, 1800) : 1800,
        slots: defaultSlots,
      });
    }

    // Urutkan tampilan admin persis sesuai urutan (order) yang tampil di aplikasi
    stripFrames.sort((a, b) => a.order - b.order || a.original_id - b.original_id);

    const newsFrames = [];
    for (let i = 1; i <= MAX_NEWS_SLOTS; i++) {
      const f = frameMap.get(`news_${i}`);
      const s1 = f?.slots?.p1;
      const s2 = f?.slots?.p2;
      const defaultSlots = {
        p1: s1
          ? {
              x: toFloat(s1.x, 0),
              y: toFloat(s1.y, 0),
              w: toFloat(s1.w, 0),
              h: toFloat(s1.h, 0),
            }
          : { x: 100, y: 300, w: 1000, h: 800 },
        p2: s2
          ? {
              x: toFloat(s2.x, 0),
              y: toFloat(s2.y, 0),
              w: toFloat(s2.w, 0),
              h: toFloat(s2.h, 0),
            }
          : { x: 100, y: 1150, w: 400, h: 300 },
      };
      newsFrames.push({
        original_id: i,
        active: f ? Boolean(f.active) : false,
        order: f ? toInt(f.order, i) : i,
        url: f ? f.url || '' : '',
        digital_url: f ? f.digital_url || '' : '',
        w: f && Number.isFinite(Number(f.w)) && Number(f.w) > 0 ? toFloat(f.w, 1200) : 1200,
        h: f && Number.isFinite(Number(f.h)) && Number(f.h) > 0 ? toFloat(f.h, 1600) : 1600,
        slots: defaultSlots,
      });
    }

    // Urutkan Newspaper persis sesuai urutan (order) yang tampil di aplikasi
    newsFrames.sort((a, b) => a.order - b.order || a.original_id - b.original_id);

    return res.render('admin/frames', {
      pageTitle: 'Pengaturan Frame & Harga',
      activeMenu: 'frames',
      setting,
      stripFrames,
      newsFrames,
      flashMsg: req.query.msg || '',
      flashErr: req.query.err || '',
    });
  } catch (err) {
    return res.status(500).send(`Error memuat halaman frame: ${err.message}`);
  }
};

exports.saveFramesAndSettings = async (req, res) => {
  try {
    const b = req.body;
    const setting = await Setting.getGlobal();

    setting.environment = b.environment === 'production' ? 'production' : 'sandbox';
    setting.midtrans_server_key = String(b.server_key || '').trim();
    setting.midtrans_client_key = String(b.client_key || '').trim();
    setting.price_strip = toInt(b.price_strip, 15000);
    setting.price_news = toInt(b.price_news, 20000);
    setting.price_strip_promo = toInt(b.price_strip_promo, 12000);
    setting.timer = toInt(b.timer, 6);
    await setting.save();

    const bulkOps = [];

    for (let i = 1; i <= MAX_STRIP_SLOTS; i++) {
      const slots = {};
      for (let j = 1; j <= 6; j++) {
        slots[`p${j}`] = {
          x: toFloat(b[`strip_f${i}_p${j}_x`], 0),
          y: toFloat(b[`strip_f${i}_p${j}_y`], 0),
          w: toFloat(b[`strip_f${i}_p${j}_w`], 0),
          h: toFloat(b[`strip_f${i}_p${j}_h`], 0),
        };
      }
      bulkOps.push({
        updateOne: {
          filter: { type: 'strip', original_id: i },
          update: {
            $set: {
              type: 'strip',
              original_id: i,
              active: Boolean(b[`strip_f${i}_active`]),
              order: Math.max(1, toInt(b[`strip_f${i}_order`], i)),
              url: String(b[`strip_f${i}_url`] || '').trim(),
              w: toFloat(b[`strip_f${i}_w`], 1200),
              h: toFloat(b[`strip_f${i}_h`], 1800),
              shots: 3,
              slots,
            },
          },
          upsert: true,
        },
      });
    }

    for (let i = 1; i <= MAX_NEWS_SLOTS; i++) {
      const slots = {};
      for (let j = 1; j <= 2; j++) {
        slots[`p${j}`] = {
          x: toFloat(b[`news_f${i}_p${j}_x`], 0),
          y: toFloat(b[`news_f${i}_p${j}_y`], 0),
          w: toFloat(b[`news_f${i}_p${j}_w`], 0),
          h: toFloat(b[`news_f${i}_p${j}_h`], 0),
        };
      }
      const printUrl = String(b[`news_f${i}_url`] || '').trim();
      const digitalUrl = String(b[`news_f${i}_digital_url`] || '').trim();

      bulkOps.push({
        updateOne: {
          filter: { type: 'news', original_id: i },
          update: {
            $set: {
              type: 'news',
              original_id: i,
              active: Boolean(b[`news_f${i}_active`]),
              order: Math.max(1, toInt(b[`news_f${i}_order`], i)),
              url: printUrl,
              digital_url: digitalUrl || printUrl,
              w: toFloat(b[`news_f${i}_w`], 1200),
              h: toFloat(b[`news_f${i}_h`], 1600),
              shots: 2,
              slots,
            },
          },
          upsert: true,
        },
      });
    }

    await Frame.bulkWrite(bulkOps);
    return res.redirect(
      '/admin/frames?msg=' +
        encodeURIComponent('Semua pengaturan frame, koordinat desimal, urutan, dan harga berhasil disimpan!')
    );
  } catch (err) {
    return res.redirect('/admin/frames?err=' + encodeURIComponent(`Gagal menyimpan: ${err.message}`));
  }
};

// Endpoint opsional untuk AJAX Quick-Sort Drag & Drop jika ingin simpan urutan tanpa reload
exports.reorderFrames = async (req, res) => {
  try {
    const type = String(req.body.type || '').trim();
    const orderList = Array.isArray(req.body.order) ? req.body.order : [];
    if (!['strip', 'news'].includes(type) || orderList.length === 0) {
      return res.status(400).json({ success: false, message: 'Parameter urutan tidak valid.' });
    }
    await Frame.reorderGroup(type, orderList);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.exportFramesJson = async (req, res) => {
  try {
    const jsonData = await exportToWordPressJson();
    const rawJsTs = req.query.js_ts ? String(req.query.js_ts).replace(/[^0-9_-]/g, '') : '';
    const ts = rawJsTs || dayjs().tz('Asia/Jakarta').format('YYYY-MM-DD_HH-mm-ss');
    res.setHeader('Content-Disposition', `attachment; filename=photobooth-frame-settings-${ts}.json`);
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify(jsonData, null, 2));
  } catch (err) {
    return res.status(500).send(`Gagal export JSON: ${err.message}`);
  }
};

exports.importFramesJson = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.redirect('/admin/frames?err=' + encodeURIComponent('Harap pilih file .json terlebih dahulu.'));
    }
    const parsed = JSON.parse(req.file.buffer.toString('utf8'));
    const mirrorImages = req.body.mirror_images === '1';

    const result = await importFromWordPressJson(parsed, { mirrorImages });
    const msg = `Import JSON berhasil! (${result.importedStrips} Strip, ${result.importedNews} News, ${result.mirroredImages} gambar disalin ke ImageKit.io)`;
    return res.redirect('/admin/frames?msg=' + encodeURIComponent(msg));
  } catch (err) {
    return res.redirect('/admin/frames?err=' + encodeURIComponent(`Format JSON tidak valid atau gagal import: ${err.message}`));
  }
};

// =========================================================================
// 3. SETTING MODE PEMBAYARAN (/admin/payment)
// =========================================================================
exports.getPaymentPage = async (req, res) => {
  try {
    const setting = await Setting.getGlobal();
    return res.render('admin/payment', {
      pageTitle: 'Setting Pembayaran',
      activeMenu: 'payment',
      setting,
      flashMsg: req.query.msg || '',
    });
  } catch (err) {
    return res.status(500).send(`Error: ${err.message}`);
  }
};

exports.savePaymentSettings = async (req, res) => {
  try {
    const setting = await Setting.getGlobal();
    setting.free_mode = req.body.ef_pb_free_mode === 'yes' ? 'yes' : 'no';
    setting.use_midtrans = req.body.ef_pb_use_midtrans === 'yes' ? 'yes' : 'no';
    setting.manual_qris_url = String(req.body.ef_pb_manual_qris_url || '').trim();
    if (req.body.manual_qris_file_id) {
      setting.manual_qris_file_id = String(req.body.manual_qris_file_id).trim();
    }
    await setting.save();

    const statusLabel =
      setting.free_mode === 'yes'
        ? 'Pengaturan Disimpan! MODE GRATIS AKTIF (Semua sesi langsung skip pembayaran).'
        : 'Pengaturan Pembayaran Berhasil Disimpan (Mode Berbayar Aktif).';
    return res.redirect('/admin/payment?msg=' + encodeURIComponent(statusLabel));
  } catch (err) {
    return res.status(500).send(`Gagal menyimpan payment: ${err.message}`);
  }
};

// =========================================================================
// 4. KELOLA VOUCHER 5 DIGIT (/admin/vouchers)
// =========================================================================
exports.getVouchersPage = async (req, res) => {
  try {
    const [setting, vouchers] = await Promise.all([
      Setting.getGlobal(),
      Voucher.find({}).sort({ createdAt: -1 }).lean(),
    ]);
    const nowUnix = Math.floor(Date.now() / 1000);
    return res.render('admin/vouchers', {
      pageTitle: 'Kelola Voucher',
      activeMenu: 'vouchers',
      setting,
      vouchers,
      nowUnix,
      flashMsg: req.query.msg || '',
      flashErr: req.query.err || '',
    });
  } catch (err) {
    return res.status(500).send(`Error memuat voucher: ${err.message}`);
  }
};

exports.saveGlobalVoucherExpiry = async (req, res) => {
  try {
    const iso = String(req.body.expiry_iso || '').trim(); // YYYY-MM-DDTHH:mm
    if (!iso) return res.redirect('/admin/vouchers?err=' + encodeURIComponent('Tanggal kedaluwarsa tidak valid.'));

    const dt = dayjs.tz(iso, 'Asia/Jakarta');
    const ts = dt.unix();
    const label = `${dt.format('DD')} ${BULAN_ID[dt.month()]} ${dt.format('YYYY, HH:mm')} WIB`;

    const setting = await Setting.getGlobal();
    setting.global_voucher_expiry_iso = iso;
    setting.global_voucher_expiry_ts = ts;
    setting.global_voucher_expiry_label = label;
    await setting.save();

    return res.redirect('/admin/vouchers?msg=' + encodeURIComponent(`Masa berlaku global diperbarui ke ${label}`));
  } catch (err) {
    return res.redirect('/admin/vouchers?err=' + encodeURIComponent(err.message));
  }
};

function generateRandom5Code() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Tanpa 0/O/1/I agar tidak membingungkan pengunjung
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

exports.createVouchers = async (req, res) => {
  try {
    const mode = req.body.mode === 'bulk' ? 'bulk' : 'single';
    const type = req.body.type === 'free' ? 'free' : 'discount';
    const amountStrip = type === 'free' ? 0 : toInt(req.body.amount_strip, 5000);
    const amountNews = type === 'free' ? 0 : toInt(req.body.amount_news, 5000);
    const usageLimit = Math.max(1, toInt(req.body.usage_limit, 1));
    const notes = String(req.body.notes || '').trim();

    let customExpiryTs = 0;
    if (req.body.custom_expiry_iso) {
      customExpiryTs = dayjs.tz(String(req.body.custom_expiry_iso), 'Asia/Jakarta').unix();
    }

    if (mode === 'single') {
      const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
      if (code.length < 3) {
        return res.redirect('/admin/vouchers?err=' + encodeURIComponent('Kode voucher minimal 3 karakter.'));
      }
      await Voucher.create({
        code,
        type,
        amount_strip: amountStrip,
        amount_news: amountNews,
        usage_limit: usageLimit,
        expiry_ts: customExpiryTs,
        notes,
      });
      return res.redirect('/admin/vouchers?msg=' + encodeURIComponent(`Voucher ${code} berhasil dibuat!`));
    }

    // Mode Generate Massal 5 Digit
    const qty = Math.min(100, Math.max(1, toInt(req.body.qty, 10)));
    const prefix = String(req.body.prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const createdCodes = [];

    for (let attempt = 0; attempt < qty * 4 && createdCodes.length < qty; attempt++) {
      const code = prefix ? `${prefix}${generateRandom5Code().slice(0, Math.max(2, 5 - prefix.length))}` : generateRandom5Code();
      try {
        await Voucher.create({
          code,
          type,
          amount_strip: amountStrip,
          amount_news: amountNews,
          usage_limit: usageLimit,
          expiry_ts: customExpiryTs,
          notes,
        });
        createdCodes.push(code);
      } catch (_) {
        // Lewati jika kebetulan duplikat
      }
    }

    return res.redirect('/admin/vouchers?msg=' + encodeURIComponent(`${createdCodes.length} kode voucher berhasil digenerate!`));
  } catch (err) {
    return res.redirect('/admin/vouchers?err=' + encodeURIComponent(`Gagal membuat voucher: ${err.message}`));
  }
};

exports.deleteVoucher = async (req, res) => {
  try {
    await Voucher.findByIdAndDelete(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// 5. IMAGEKIT DIRECT UPLOAD AUTH UNTUK ADMIN BROWSER (BEBAS LIMIT 4.5MB VERCEL)
// =========================================================================
exports.getAdminImageKitAuth = (req, res) => {
  try {
    const auth = getAuthParams();
    return res.json({
      success: true,
      data: {
        ...auth,
        publicKey: process.env.IMAGEKIT_PUBLIC_KEY || '',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};