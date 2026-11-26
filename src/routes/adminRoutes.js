const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middlewares/auth');
const ctrl = require('../controllers/adminController');

const router = express.Router();
const uploadJson = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB bulat (integer)
});

// Semua route di bawah /admin wajib login sebagai admin
router.use(requireAuth(['admin']));

router.get('/', (req, res) => res.redirect('/admin/sales'));

// Sales & Rekap
router.get('/sales', ctrl.getSalesPage);
router.get('/sales/export-excel', ctrl.exportSalesExcel);
router.delete('/sales/:orderId', ctrl.deleteInvoice);

// Frames, Harga & Visual Editor + Drag & Drop Reorder + Import/Export JSON WordPress
router.get('/frames', ctrl.getFramesPage);
router.post('/frames/save', ctrl.saveFramesAndSettings);
router.post('/frames/reorder', ctrl.reorderFrames);
router.get('/frames/export-json', ctrl.exportFramesJson);
router.post('/frames/import-json', uploadJson.single('import_file'), ctrl.importFramesJson);

// Payment Settings
router.get('/payment', ctrl.getPaymentPage);
router.post('/payment/save', ctrl.savePaymentSettings);

// Vouchers
router.get('/vouchers', ctrl.getVouchersPage);
router.post('/vouchers/expiry', ctrl.saveGlobalVoucherExpiry);
router.post('/vouchers/create', ctrl.createVouchers);
router.delete('/vouchers/:id', ctrl.deleteVoucher);

// Direct Upload Signature ImageKit untuk Admin Browser
router.get('/api/imagekit-auth', ctrl.getAdminImageKitAuth);

module.exports = router;