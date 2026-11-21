const MediaAsset = require('../models/MediaAsset');
const Transaction = require('../models/Transaction');
const { deleteFileIds } = require('../services/mediaService');

exports.cleanupOldMedia = async (req, res) => {
  try {
    // Validasi token Vercel Cron atau panggilan manual dengan ?secret=
    const expectedSecret = process.env.CRON_SECRET;
    if (expectedSecret) {
      const authHeader = req.headers.authorization || '';
      const querySecret = req.query.secret || '';
      if (authHeader !== `Bearer ${expectedSecret}` && querySecret !== expectedSecret) {
        return res.status(401).json({ success: false, message: 'Unauthorized cron request.' });
      }
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 1. Cari seluruh file sesi yang sudah lebih dari 7 hari
    const oldAssets = await MediaAsset.find({
      deleted_from_storage: false,
      createdAt: { $lt: sevenDaysAgo },
    })
      .limit(200)
      .lean();

    // 2. Cari file cetak (print_photo) yang sudah dicetak > 24 jam lalu
    const printedTrx = await Transaction.find({
      print_status: 1,
      print_file_id: { $ne: '' },
      updatedAt: { $lt: oneDayAgo },
    })
      .select('_id print_file_id')
      .limit(200)
      .lean();

    const fileIdsToDelete = [];
    oldAssets.forEach((a) => { if (a.fileId) fileIdsToDelete.push(a.fileId); });
    printedTrx.forEach((t) => { if (t.print_file_id) fileIdsToDelete.push(t.print_file_id); });

    if (fileIdsToDelete.length > 0) {
      await deleteFileIds(fileIdsToDelete);
    }

    if (oldAssets.length > 0) {
      await MediaAsset.updateMany(
        { _id: { $in: oldAssets.map((a) => a._id) } },
        { $set: { deleted_from_storage: true } }
      );
    }

    if (printedTrx.length > 0) {
      await Transaction.updateMany(
        { _id: { $in: printedTrx.map((t) => t._id) } },
        { $set: { print_file_id: '', print_url: '' } }
      );
    }

    return res.json({
      success: true,
      cleanedSessionFiles: oldAssets.length,
      cleanedPrintedFiles: printedTrx.length,
      totalImageKitDeleted: fileIdsToDelete.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};