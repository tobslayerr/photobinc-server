const express = require('express');
const ctrl = require('../controllers/clientController');

const router = express.Router();

router.get('/download-foto', ctrl.renderDownloadPage);
router.get('/live-ar', ctrl.renderLiveArPage);
router.get('/api/download', ctrl.proxyDownload);
router.get('/api/ar-target', ctrl.proxyArTarget);

module.exports = router;