const express = require('express');
const ctrl = require('../controllers/clientController');

const router = express.Router();

router.get('/download-foto', ctrl.renderDownloadPage);
router.get('/live-ar', ctrl.renderLiveArPage);

module.exports = router;