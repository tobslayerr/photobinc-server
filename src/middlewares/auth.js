const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'pb_session';

function signSession(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET || 'photobinc_dev_secret', {
    expiresIn: '12h',
  });
}

function getSessionFromReq(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'photobinc_dev_secret');
  } catch {
    return null;
  }
}

function requireAuth(allowedRoles = ['admin']) {
  return (req, res, next) => {
    const user = getSessionFromReq(req);
    if (!user || !allowedRoles.includes(user.role)) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ success: false, message: 'Sesi habis, silakan login ulang.' });
      }
      const nextUrl = encodeURIComponent(req.originalUrl || '/admin/sales');
      return res.redirect(`/login?next=${nextUrl}`);
    }
    req.user = user;
    res.locals.user = user;
    next();
  };
}

function renderLogin(req, res) {
  const user = getSessionFromReq(req);
  if (user) {
    return res.redirect(user.role === 'admin' ? '/admin/sales' : '/operator');
  }
  res.render('login', {
    error: req.query.err || '',
    nextUrl: req.query.next || '',
  });
}

function handleLogin(req, res) {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const nextUrl = String(req.body.next || '').trim();

  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const opUser = process.env.OPERATOR_USERNAME || 'operator';
  const opPass = process.env.OPERATOR_PASSWORD || 'operator123';

  let role = null;
  if (username === adminUser && password === adminPass) {
    role = 'admin';
  } else if (username === opUser && password === opPass) {
    role = 'operator';
  }

  if (!role) {
    return res.render('login', {
      error: 'Username atau password salah.',
      nextUrl,
    });
  }

  const token = signSession({ username, role });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000,
  });

  if (nextUrl && nextUrl.startsWith('/') && !nextUrl.startsWith('//')) {
    if (role === 'operator' && nextUrl.startsWith('/admin')) {
      return res.redirect('/operator');
    }
    return res.redirect(nextUrl);
  }

  return res.redirect(role === 'admin' ? '/admin/sales' : '/operator');
}

function handleLogout(req, res) {
  res.clearCookie(COOKIE_NAME);
  return res.redirect('/login');
}

module.exports = {
  requireAuth,
  getSessionFromReq,
  renderLogin,
  handleLogin,
  handleLogout,
};