const express = require('express');
const multer = require('multer');
const ctrl = require('../controllers/nativeApiController');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
});

router.get('/config', ctrl.getConfig);
router.get('/frames', ctrl.getFrames);
router.post('/voucher/validate', ctrl.validateVoucher);
router.post('/transaction/create', ctrl.createTransaction);
router.get('/transaction/check', ctrl.checkPayment);
router.get('/media/imagekit-auth', ctrl.getImageKitAuth);
router.post('/media/register', ctrl.registerUploadedMedia);
router.post('/media/upload', upload.single('file'), ctrl.uploadMediaFallback);
router.post('/session/finalize', ctrl.finalizeSession);

module.exports = router;