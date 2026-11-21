const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');

const nativeApiRoutes = require('./routes/nativeApiRoutes');
const adminRoutes = require('./routes/adminRoutes');
const operatorRoutes = require('./routes/operatorRoutes');
const clientRoutes = require('./routes/clientRoutes');
const cronController = require('./controllers/cronController');
const { renderLogin, handleLogin, handleLogout } = require('./middlewares/auth');

const app = express();

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb', parameterLimit: 5000 }));
app.use(cookieParser());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, '../public')));

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('[DB Error]', err);
    res.status(500).json({ success: false, message: 'Koneksi database gagal.' });
  }
});

// Health Check & Cron Auto-Delete 7 Hari
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'Photobinc Express Backend', time: new Date().toISOString() });
});
app.get('/api/cron/cleanup-old-media', cronController.cleanupOldMedia);

// Login / Logout
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', renderLogin);
app.post('/login', handleLogin);
app.get('/logout', handleLogout);

// 1. React Native REST API (Prefix identik WordPress)
app.use('/wp-json/photobooth/v1', nativeApiRoutes);

// 2. Admin Dashboard (/admin/sales, /admin/frames, /admin/payment, /admin/vouchers)
app.use('/admin', adminRoutes);

// 3. Operator Dashboard (/operator)
app.use('/operator', operatorRoutes);

// 4. Halaman Client (/download-foto & /live-ar)
app.use('/', clientRoutes);

module.exports = app;