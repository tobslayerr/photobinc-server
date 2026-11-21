const express = require('express');
const { requireAuth } = require('../middlewares/auth');
const ctrl = require('../controllers/operatorController');

const router = express.Router();

// Dapat diakses oleh role 'operator' maupun 'admin'
router.use(requireAuth(['admin', 'operator']));

router.get('/', ctrl.renderDashboard);
router.get('/api/payment-queue', ctrl.getPaymentQueue);
router.post('/api/admit-payment', ctrl.admitPayment);
router.post('/api/reject-payment', ctrl.rejectPayment);
router.get('/api/print-queue', ctrl.getPrintQueue);
router.post('/api/mark-printed', ctrl.markPrinted);

module.exports = router;