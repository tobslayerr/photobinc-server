const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const Transaction = require('../models/Transaction');
const Frame = require('../models/Frame');

function withOrigParam(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.hostname === 'ik.imagekit.io') {
      u.searchParams.set('tr', 'orig-true');
      return u.toString();
    }
  } catch (_) {}
  return url;
}

exports.renderDashboard = (req, res) => {
  return res.render('operator/dashboard', { user: req.user });
};

exports.getPaymentQueue = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const todayWib = dayjs().tz('Asia/Jakarta').format('YYYY-MM-DD');

    const rows = await Transaction.find({
      status: 'pending',
      created_at_wib: { $gte: `${todayWib} 00:00:00`, $lte: `${todayWib} 23:59:59` },
    })
      .select('order_id package_name amount created_at_wib')
      .sort({ createdAt: 1 })
      .lean();

    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.admitPayment = async (req, res) => {
  try {
    const orderId = String(req.body.order_id || '').trim();
    const method = String(req.body.payment_method || 'qris').toLowerCase().trim();
    if (!orderId) return res.status(400).json({ success: false, message: 'order_id kosong' });

    await Transaction.updateOne(
      { order_id: orderId },
      { $set: { status: 'lunas', payment_method: method === 'cash' ? 'cash' : 'qris' } }
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.rejectPayment = async (req, res) => {
  try {
    const orderId = String(req.body.order_id || '').trim();
    if (!orderId) return res.status(400).json({ success: false, message: 'order_id kosong' });

    await Transaction.updateOne({ order_id: orderId }, { $set: { status: 'cancelled' } });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.getPrintQueue = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const [rows, allFrames] = await Promise.all([
      Transaction.find({
        status: 'lunas',
        print_status: 0,
        $or: [
          { print_url: { $exists: true, $nin: ['', null] } },
          { 'media_assets.0': { $exists: true } },
        ],
      })
        .select('order_id package_name frame_info print_url media_assets created_at_wib')
        .sort({ createdAt: 1 })
        .lean(),
      Frame.find({}).select('type original_id order').lean(),
    ]);

    const frameOrderMap = new Map(allFrames.map((f) => [`${f.type}_${f.original_id}`, f.order]));

    const formatted = rows
      .map((item) => {
        let rawPrintUrl = item.print_url || '';
        if (!rawPrintUrl && Array.isArray(item.media_assets)) {
          const found =
            item.media_assets.find((a) => a.type === 'print' && a.url) ||
            item.media_assets.find((a) => a.type === 'photo' && a.url) ||
            item.media_assets[0];
          if (found) rawPrintUrl = found.url;
        }
        if (!rawPrintUrl) return null;

        let frameLabel = item.frame_info || '-';
        const lowInfo = frameLabel.toLowerCase();
        const m = /(\d+)/.exec(frameLabel);
        const id = m ? parseInt(m[1], 10) : 0;

        if (id > 0) {
          if (lowInfo.includes('strip') || (!lowInfo.includes('news') && String(item.package_name).toLowerCase().includes('strip'))) {
            const ord = frameOrderMap.get(`strip_${id}`) || id;
            frameLabel = `Desain Strip ${id} (Urutan ${ord})`;
          } else if (lowInfo.includes('news') || String(item.package_name).toLowerCase().includes('news')) {
            const ord = frameOrderMap.get(`news_${id}`) || id;
            frameLabel = `Desain News ${id} (Urutan ${ord})`;
          }
        }

        const origUrl = withOrigParam(rawPrintUrl);
        return {
          order_id: item.order_id,
          package_name: item.package_name,
          frame_info: frameLabel,
          print_url: origUrl,
          thumb_url: `/api/ar-target?url=${encodeURIComponent(origUrl)}&w=600`,
          created_at: item.created_at_wib,
        };
      })
      .filter(Boolean);

    return res.json({ success: true, data: formatted });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.markPrinted = async (req, res) => {
  try {
    const orderId = String(req.body.order_id || '').trim();
    if (!orderId) return res.status(400).json({ success: false, message: 'order_id kosong' });

    await Transaction.updateOne({ order_id: orderId }, { $set: { print_status: 1 } });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};