const path = require('path');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const imagekit = require('../config/imagekit');
const Setting = require('../models/Setting');
const Frame = require('../models/Frame');
const Voucher = require('../models/Voucher');
const Transaction = require('../models/Transaction');
const MediaAsset = require('../models/MediaAsset');
const {
  getPrefixByType,
  getSessionAuthPool,
  uploadBufferToImageKit,
} = require('../services/mediaService');
const { createSnapTransaction, checkMidtransStatus } = require('../services/midtransService');

const BULAN_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const MAX_STRIP_SLOTS = (Frame.LIMITS && Frame.LIMITS.strip) || 18;
const MAX_NEWS_SLOTS = (Frame.LIMITS && Frame.LIMITS.news) || 4;
const VALID_MEDIA_TYPES = new Set(['photo', 'video', 'gif', 'raw', 'print']);

function toNum(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSlot(slot) {
  return {
    x: toNum(slot?.x, 0),
    y: toNum(slot?.y, 0),
    w: toNum(slot?.w, 0),
    h: toNum(slot?.h, 0),
  };
}

function inferMediaType(explicitType, filename) {
  const cleanType = String(explicitType || '').toLowerCase().trim();
  const lowerName = String(filename || '').toLowerCase();

  // Pastikan file pose HD tidak pernah tersimpan sebagai 'photo' jika pola namanya jelas 'raw'
  if (/(^|[\/_\-])(final_raw_|raw[\-_])/.test(lowerName)) return 'raw';
  if (VALID_MEDIA_TYPES.has(cleanType)) return cleanType;
  if (lowerName.endsWith('.mp4') || /(^|[\/_\-])(final_video_|live[\-_])/.test(lowerName)) return 'video';
  if (lowerName.endsWith('.gif') || /(^|[\/_\-])(final_gif_|slide[\-_])/.test(lowerName)) return 'gif';
  if (/(^|[\/_\-])(final_print_|print[\-_])/.test(lowerName)) return 'print';
  return 'photo';
}

function getSafeFreePaymentMethod() {
  const enumVals = Transaction.schema?.path('payment_method')?.enumValues || [];
  if (enumVals.length === 0 || enumVals.includes('gratis')) return 'gratis';
  return 'voucher';
}

function formatWibReadable(unixSec) {
  const d = dayjs.unix(unixSec).tz('Asia/Jakarta');
  return `${d.format('DD')} ${BULAN_ID[d.month()]} ${d.format('YYYY, HH:mm')} WIB`;
}

function formatWibSql(unixSec) {
  return dayjs.unix(unixSec).tz('Asia/Jakarta').format('YYYY-MM-DD HH:mm:ss');
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

// 1. GET /wp-json/photobooth/v1/config
exports.getConfig = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const setting = await Setting.getGlobal();
    const isFreeMode = setting.free_mode === 'yes';

    const sessionPool = await imagekit.getSessionAccountPool(setting);
    const activeStorage = sessionPool[0] || imagekit.getPrimaryAccount();

    return res.json({
      success: true,
      data: {
        timer: setting.timer,
        prices: {
          strip: isFreeMode ? 0 : setting.price_strip,
          news: isFreeMode ? 0 : setting.price_news,
          strip_promo: isFreeMode ? 0 : setting.price_strip_promo,
        },
        payment: {
          environment: setting.environment,
          client_key: setting.midtrans_client_key,
          use_midtrans: isFreeMode ? 'no' : setting.use_midtrans,
          free_mode: isFreeMode,
          manual_qris_url: setting.manual_qris_url,
        },
        voucher_config: {
          expiry_iso: setting.global_voucher_expiry_iso,
          expiry_ts: setting.global_voucher_expiry_ts,
          expiry_label: setting.global_voucher_expiry_label,
        },
        // Penanda otomatis untuk React Native api.ts agar memakai ImageKit Direct Upload (+ failover)
        storage: {
          provider: 'imagekit',
          active_account_id: activeStorage.id || 'primary',
          public_key: activeStorage.publicKey || process.env.IMAGEKIT_PUBLIC_KEY || '',
          url_endpoint: activeStorage.urlEndpoint || process.env.IMAGEKIT_URL_ENDPOINT || '',
          folder: '/photobooth/sessions',
          failover_enabled: sessionPool.length > 1,
          pool_count: sessionPool.length,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 2. GET /wp-json/photobooth/v1/frames (18 Strip & 4 News, Float Coordinates, Anti-Cache)
exports.getFrames = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const [stripDocs, newsDocs] = await Promise.all([
      Frame.find({
        type: 'strip',
        original_id: { $gte: 1, $lte: MAX_STRIP_SLOTS },
        active: true,
        url: { $ne: '' },
      })
        .sort({ order: 1, original_id: 1 })
        .lean(),
      Frame.find({
        type: 'news',
        original_id: { $gte: 1, $lte: MAX_NEWS_SLOTS },
        active: true,
        url: { $ne: '' },
      })
        .sort({ order: 1, original_id: 1 })
        .lean(),
    ]);

    const strip = stripDocs.map((f) => ({
      original_id: f.original_id,
      order: f.order,
      url: f.url,
      w: toNum(f.w, 1200),
      h: toNum(f.h, 1800),
      shots: 3,
      slots: {
        p1: normalizeSlot(f.slots?.p1),
        p2: normalizeSlot(f.slots?.p2),
        p3: normalizeSlot(f.slots?.p3),
        p4: normalizeSlot(f.slots?.p4),
        p5: normalizeSlot(f.slots?.p5),
        p6: normalizeSlot(f.slots?.p6),
      },
    }));

    const news = newsDocs.map((f) => ({
      original_id: f.original_id,
      order: f.order,
      url: f.url,
      digital_url: f.digital_url || f.url,
      w: toNum(f.w, 1200),
      h: toNum(f.h, 1600),
      shots: 2,
      slots: {
        p1: normalizeSlot(f.slots?.p1),
        p2: normalizeSlot(f.slots?.p2),
      },
    }));

    return res.json({ success: true, data: { strip, news } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 3. POST /wp-json/photobooth/v1/voucher/validate
exports.validateVoucher = async (req, res) => {
  try {
    const rawCode = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const rawPkg = String(req.body.package || 'strip').toLowerCase().trim();
    const clientTs = parseInt(req.body.client_timestamp, 10);
    const nowUnix = clientTs > 1700000000 ? clientTs : Math.floor(Date.now() / 1000);

    const setting = await Setting.getGlobal();

    // Jika Mode Gratis aktif, langsung lolos tanpa memakai kuota voucher
    if (setting.free_mode === 'yes') {
      const isNews = rawPkg === 'news' || rawPkg === 'newspaper';
      const origPrice = isNews ? setting.price_news : setting.price_strip;
      return res.json({
        success: true,
        data: {
          code: rawCode || 'FREE-MODE',
          type: 'free',
          is_free: true,
          original_price: origPrice,
          discount: origPrice,
          final_price: 0,
          message: 'Mode Gratis sedang aktif! Langsung masuk ke sesi foto tanpa membayar.',
        },
      });
    }

    if (rawPkg === 'strip_promo') {
      return res.status(400).json({
        success: false,
        message: 'Paket Strip Promo tidak dapat digabungkan dengan kode voucher.',
      });
    }

    if (!rawCode) {
      return res.status(400).json({ success: false, message: 'Masukkan kode voucher terlebih dahulu.' });
    }

    const voucher = await Voucher.findOne({ code: rawCode });
    if (!voucher) {
      return res.status(404).json({ success: false, message: 'Kode voucher tidak ditemukan atau tidak valid.' });
    }

    if (voucher.usage_count >= voucher.usage_limit) {
      return res.status(400).json({ success: false, message: 'Maaf, kode voucher ini sudah pernah digunakan.' });
    }

    const expiryTs = voucher.expiry_ts > 0 ? voucher.expiry_ts : setting.global_voucher_expiry_ts;
    if (expiryTs > 0 && nowUnix > expiryTs) {
      return res.status(400).json({ success: false, message: 'Masa berlaku kode voucher ini sudah berakhir.' });
    }

    const isNews = rawPkg === 'news' || rawPkg === 'newspaper';
    const originalPrice = isNews ? setting.price_news : setting.price_strip;
    const discountEligible = isNews ? voucher.amount_news : voucher.amount_strip;

    let discount = 0;
    let finalPrice = originalPrice;
    let isFree = false;

    if (voucher.type === 'free') {
      discount = originalPrice;
      finalPrice = 0;
      isFree = true;
    } else if (discountEligible > 0) {
      discount = Math.min(originalPrice, discountEligible);
      finalPrice = Math.max(0, originalPrice - discount);
      if (finalPrice === 0) isFree = true;
    } else {
      return res.status(400).json({
        success: false,
        message: 'Kode voucher ini tidak berlaku untuk paket yang Anda pilih.',
      });
    }

    return res.json({
      success: true,
      data: {
        code: voucher.code,
        type: isFree ? 'free' : 'discount',
        is_free: isFree,
        original_price: originalPrice,
        discount,
        final_price: finalPrice,
        message: isFree
          ? 'Voucher Gratis 100% valid!'
          : `Voucher valid! Potongan Rp ${discount.toLocaleString('id-ID')}`,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 4. POST /wp-json/photobooth/v1/transaction/create
exports.createTransaction = async (req, res) => {
  try {
    const setting = await Setting.getGlobal();
    const isFreeMode = setting.free_mode === 'yes';
    const rawPkg = String(req.body.package || 'strip').toLowerCase().trim();
    const voucherCode = String(req.body.voucher_code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');

    const clientTs = parseInt(req.body.client_timestamp, 10);
    const nowUnix = clientTs > 1700000000 ? clientTs : Math.floor(Date.now() / 1000);
    const clientDatetimeWib = req.body.client_datetime_wib || formatWibReadable(nowUnix);
    const clientSqlDatetime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(req.body.client_sql_datetime || '')
      ? req.body.client_sql_datetime
      : formatWibSql(nowUnix);

    let packageType = 'strip';
    let originalPrice = setting.price_strip;
    let chosenPackageLabel = 'Classic Strip';

    if (rawPkg === 'news' || rawPkg === 'newspaper') {
      packageType = 'news';
      originalPrice = setting.price_news;
      chosenPackageLabel = 'Newspaper';
    } else if (rawPkg === 'strip_promo') {
      packageType = 'strip_promo';
      originalPrice = setting.price_strip_promo;
      chosenPackageLabel = 'Photostrip Promo';
    }

    let finalPrice = originalPrice;
    let discountAmount = 0;
    let isFree = false;
    let voucherApplied = false;

    if (isFreeMode) {
      // Bypass seluruh pembayaran & tidak memotong kuota voucher
      finalPrice = 0;
      discountAmount = originalPrice;
      isFree = true;
    } else if (voucherCode) {
      if (packageType === 'strip_promo') {
        return res.status(400).json({
          success: false,
          message: 'Paket Strip Promo tidak dapat digabungkan dengan voucher.',
        });
      }

      const voucher = await Voucher.findOne({ code: voucherCode });
      if (!voucher) {
        return res.status(404).json({ success: false, message: 'Kode voucher tidak ditemukan atau tidak valid.' });
      }

      const expiryTs = voucher.expiry_ts > 0 ? voucher.expiry_ts : setting.global_voucher_expiry_ts;
      if (expiryTs > 0 && nowUnix > expiryTs) {
        return res.status(400).json({ success: false, message: 'Masa berlaku kode voucher ini sudah berakhir.' });
      }

      const discountToApply = packageType === 'news' ? voucher.amount_news : voucher.amount_strip;
      if (voucher.type === 'free') {
        finalPrice = 0;
        discountAmount = originalPrice;
        isFree = true;
      } else if (voucher.type === 'discount' && discountToApply > 0) {
        discountAmount = Math.min(originalPrice, discountToApply);
        finalPrice = Math.max(0, originalPrice - discountAmount);
        if (finalPrice === 0) isFree = true;
      } else {
        return res.status(400).json({
          success: false,
          message: 'Kode voucher ini tidak berlaku untuk paket yang Anda pilih.',
        });
      }

      // Klaim Atomik: mencegah 1 voucher dipakai 2x secara bersamaan
      const claimed = await Voucher.findOneAndUpdate(
        {
          _id: voucher._id,
          $expr: { $lt: ['$usage_count', '$usage_limit'] },
        },
        {
          $inc: { usage_count: 1 },
          $set: { used_package: chosenPackageLabel, used_at: clientDatetimeWib },
        },
        { new: true }
      );

      if (!claimed) {
        return res.status(400).json({
          success: false,
          message: 'Kode voucher ini baru saja digunakan. Tidak dapat diklaim dua kali.',
        });
      }
      voucherApplied = true;
    }

    const rand3 = Math.floor(100 + Math.random() * 900);
    const orderId = `PB-APP-${packageType.toUpperCase()}-${nowUnix}${rand3}`;
    const initialStatus = isFree ? 'lunas' : 'pending';

    let dbPackageName = packageType;
    if (isFreeMode) {
      dbPackageName = `${packageType} (MODE GRATIS)`;
    } else if (voucherApplied) {
      dbPackageName = `${packageType} (Voucher ${isFree ? 'GRATIS' : 'DISKON'}: ${voucherCode})`;
    }

    const paymentMethod = isFreeMode
      ? getSafeFreePaymentMethod()
      : isFree
        ? 'voucher'
        : 'qris';

    await Transaction.create({
      order_id: orderId,
      package_name: dbPackageName,
      amount: finalPrice,
      status: initialStatus,
      payment_method: paymentMethod,
      created_at_wib: clientSqlDatetime,
    });

    // Jika mode Midtrans aktif & transaksi berbayar (> 0)
    if (!isFree && setting.use_midtrans === 'yes' && setting.midtrans_server_key) {
      const token = await createSnapTransaction({
        serverKey: setting.midtrans_server_key,
        environment: setting.environment,
        orderId,
        amount: finalPrice,
        packageType,
        itemName: chosenPackageLabel,
      });

      return res.json({
        success: true,
        data: {
          is_manual: false,
          free_mode: false,
          token,
          order_id: orderId,
          package: packageType,
          voucher_code: voucherApplied ? voucherCode : '',
          voucher_type: voucherApplied ? (isFree ? 'free' : 'discount') : '',
          original_price: originalPrice,
          discount: discountAmount,
          final_price: finalPrice,
          price: finalPrice,
          is_free: false,
          message: 'Silakan selesaikan pembayaran melalui Midtrans.',
        },
      });
    }

    return res.json({
      success: true,
      data: {
        is_manual: true,
        free_mode: isFreeMode,
        qris_url: isFreeMode ? '' : setting.manual_qris_url,
        order_id: orderId,
        package: packageType,
        voucher_code: voucherApplied ? voucherCode : '',
        voucher_type: isFreeMode ? 'free_mode' : voucherApplied ? (isFree ? 'free' : 'discount') : '',
        original_price: originalPrice,
        discount: discountAmount,
        final_price: finalPrice,
        price: finalPrice,
        is_free: isFree,
        message: isFreeMode
          ? 'Mode Gratis aktif! Silakan langsung masuk ke sesi foto tanpa perlu membayar!'
          : isFree
            ? 'Selamat! Voucher Gratis 100% berhasil diklaim. Silakan langsung masuk ke sesi foto tanpa perlu membayar!'
            : voucherApplied
              ? `Selamat! Anda mendapatkan potongan harga Rp ${discountAmount.toLocaleString('id-ID')}. Total bayar: Rp ${finalPrice.toLocaleString('id-ID')}`
              : 'Silakan selesaikan pembayaran melalui kasir/QRIS.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 5. GET /wp-json/photobooth/v1/transaction/check?order_id=...
exports.checkPayment = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const orderId = String(req.query.order_id || '').trim();
    if (!orderId) {
      return res.json({ success: true, data: { status: 'pending' } });
    }

    const trx = await Transaction.findOne({ order_id: orderId });
    if (!trx) {
      return res.json({ success: true, data: { status: 'pending' } });
    }

    const st = String(trx.status || '').toLowerCase();
    if (['lunas', 'success', 'settlement', 'capture'].includes(st)) {
      return res.json({ success: true, data: { status: 'lunas' } });
    }
    if (['cancelled', 'cancel', 'failed'].includes(st)) {
      return res.json({ success: true, data: { status: 'cancelled' } });
    }

    // Jika mode Midtrans aktif, cek status live ke API Midtrans
    const setting = await Setting.getGlobal();
    if (setting.use_midtrans === 'yes' && setting.midtrans_server_key) {
      const liveStatus = await checkMidtransStatus({
        serverKey: setting.midtrans_server_key,
        environment: setting.environment,
        orderId,
      });
      if (liveStatus === 'lunas' || liveStatus === 'cancelled') {
        trx.status = liveStatus;
        await trx.save();
        return res.json({ success: true, data: { status: liveStatus } });
      }
    }

    return res.json({ success: true, data: { status: 'pending' } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 6A. GET /wp-json/photobooth/v1/media/imagekit-auth (Pool Signature Multi-Account Direct Upload)
exports.getImageKitAuth = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const accounts = await getSessionAuthPool();
    if (!accounts.length) {
      return res.status(500).json({
        success: false,
        message: 'Tidak ada akun ImageKit aktif yang terkonfigurasi.',
      });
    }

    // Field top-level diisi akun prioritas #1 agar tetap kompatibel dengan APK lama sebelum rebuild
    const first = accounts[0];
    return res.json({
      success: true,
      data: {
        accountId: first.id,
        label: first.label,
        token: first.token,
        expire: first.expire,
        signature: first.signature,
        publicKey: first.publicKey,
        urlEndpoint: first.urlEndpoint,
        folder: first.folder,
        accounts, // Daftar lengkap Primary + Cadangan aktif untuk auto-failover di tablet
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 6B. POST /wp-json/photobooth/v1/media/register (Catat URL + fileId + storage_account_id ke MongoDB)
exports.registerUploadedMedia = async (req, res) => {
  try {
    const { filename, url, fileId, type, storage_account_id } = req.body;
    if (!filename || !url) {
      return res.status(400).json({ success: false, message: 'filename dan url wajib diisi.' });
    }

    // Jika APK lama tidak mengirim storage_account_id, deteksi otomatis dari URL endpoint ImageKit
    let resolvedAccountId = String(storage_account_id || '').trim();
    if (!resolvedAccountId) {
      const matched = await imagekit.getAccountByUrl(url);
      resolvedAccountId = matched ? matched.id : 'primary';
    }

    const resolvedType = inferMediaType(type, filename);

    const asset = await MediaAsset.findOneAndUpdate(
      { filename },
      {
        $set: {
          filename,
          url,
          fileId: fileId || '',
          storage_account_id: resolvedAccountId,
          type: resolvedType,
        },
      },
      { upsert: true, new: true }
    );

    return res.json({
      success: true,
      data: {
        filename: asset.filename,
        url: asset.url,
        fileId: asset.fileId,
        storage_account_id: asset.storage_account_id,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 6C. POST /wp-json/photobooth/v1/media/upload (Fallback Multipart + Auto-Failover Multi-ImageKit)
exports.uploadMediaFallback = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Tidak ada file media yang dikirim.' });
    }

    const fileType = String(req.body.file_type || 'photo').toLowerCase();
    const ext = (path.extname(req.file.originalname || '').replace('.', '') || 'jpg').toLowerCase();
    const prefix = getPrefixByType(fileType);
    const filename = `${prefix}${Math.floor(Date.now() / 1000)}-${Math.floor(1000 + Math.random() * 9000)}.${ext}`;

    const uploaded = await uploadBufferToImageKit(req.file.buffer, filename, '/photobooth/sessions');

    await MediaAsset.findOneAndUpdate(
      { filename: uploaded.filename },
      {
        $set: {
          filename: uploaded.filename,
          url: uploaded.url,
          fileId: uploaded.fileId,
          storage_account_id: uploaded.storage_account_id || 'primary',
          type: inferMediaType(fileType, uploaded.filename),
        },
      },
      { upsert: true }
    );

    return res.json({
      success: true,
      data: {
        url: uploaded.url,
        filename: uploaded.filename,
        storage_account_id: uploaded.storage_account_id || 'primary',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// 7. POST /wp-json/photobooth/v1/session/finalize
exports.finalizeSession = async (req, res) => {
  try {
    const orderId = String(req.body.order_id || '').trim();
    const parentOrderId = req.body.parent_order_id ? String(req.body.parent_order_id).trim() : null;
    const pkg = String(req.body.package || 'strip').trim();
    const frameInfo = String(req.body.frame_info || '').trim();
    const filesArray = Array.isArray(req.body.files) ? req.body.files.map((f) => String(f).trim()).filter(Boolean) : [];
    const printFilename = String(req.body.print_filename || '').trim();

    if (!orderId || filesArray.length === 0) {
      return res.status(400).json({ success: false, message: 'Data order_id atau files tidak lengkap.' });
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const clientSqlDatetime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(req.body.client_sql_datetime || '')
      ? req.body.client_sql_datetime
      : formatWibSql(nowUnix);

    // Cari seluruh URL, fileId, dan storage_account_id ImageKit berdasarkan filename yang sudah diregister
    const allLookupNames = printFilename ? [...filesArray, printFilename] : [...filesArray];
    const assetDocs = await MediaAsset.find({ filename: { $in: allLookupNames } }).lean();
    const assetMap = new Map(assetDocs.map((a) => [a.filename, a]));

    const mediaAssets = filesArray.map((fname) => {
      const found = assetMap.get(fname);
      return {
        filename: fname,
        url: found ? found.url : '',
        fileId: found ? found.fileId : '',
        storage_account_id: found ? (found.storage_account_id || 'primary') : 'primary',
        type: found ? inferMediaType(found.type, fname) : inferMediaType('', fname),
      };
    });

    const printAsset = printFilename ? assetMap.get(printFilename) : null;
    const printUrl = printAsset ? printAsset.url : '';
    const printFileId = printAsset ? printAsset.fileId : '';
    const printStorageAccountId = printAsset ? (printAsset.storage_account_id || 'primary') : 'primary';

    // Tandai order_id pada koleksi MediaAsset
    await MediaAsset.updateMany({ filename: { $in: allLookupNames } }, { $set: { order_id: orderId } });

    const allFilesStr = filesArray.join(',');
    const encodedFiles = Buffer.from(allFilesStr, 'utf8').toString('base64');
    const baseUrl = getBaseUrl(req);
    const masterLink = `${baseUrl}/download-foto?oid=${encodeURIComponent(orderId)}&f=${encodeURIComponent(encodedFiles)}`;

    const existingOrder = await Transaction.findOne({ order_id: orderId });

    if (existingOrder) {
      existingOrder.parent_order_id = parentOrderId || existingOrder.parent_order_id;
      existingOrder.frame_info = frameInfo;
      existingOrder.status = 'lunas';
      existingOrder.media_link = masterLink;
      existingOrder.all_files = allFilesStr;
      existingOrder.print_url = printUrl;
      existingOrder.print_file_id = printFileId;
      existingOrder.print_storage_account_id = printStorageAccountId;
      existingOrder.print_status = 0;
      existingOrder.media_assets = mediaAssets;
      await existingOrder.save();
    } else {
      const setting = await Setting.getGlobal();
      const isFreeMode = setting.free_mode === 'yes';

      let price = setting.price_strip;
      if (pkg === 'news') price = setting.price_news;
      else if (pkg === 'strip_promo') price = setting.price_strip_promo;

      await Transaction.create({
        order_id: orderId,
        parent_order_id: parentOrderId,
        package_name: isFreeMode ? `${pkg} (MODE GRATIS)` : pkg,
        frame_info: frameInfo,
        amount: isFreeMode ? 0 : price,
        status: 'lunas',
        payment_method: isFreeMode ? getSafeFreePaymentMethod() : 'qris',
        media_link: masterLink,
        all_files: allFilesStr,
        print_url: printUrl,
        print_file_id: printFileId,
        print_storage_account_id: printStorageAccountId,
        print_status: 0,
        created_at_wib: clientSqlDatetime,
        media_assets: mediaAssets,
      });
    }

    return res.json({
      success: true,
      data: {
        message: 'Sesi berhasil disimpan',
        download_url: masterLink,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};