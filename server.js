const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production';
const DB_FILE = path.join(__dirname, 'db.json');

// ---------------------------------------------------------------------
// Tiny JSON-file "database". Fine for a demo/local app; swap for a real
// database (Postgres, SQLite, etc.) if you deploy this for real.
// ---------------------------------------------------------------------
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, history: {}, customTheaters: [] }, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  if (!db.customTheaters) db.customTheaters = []; // backward-compatible with older db.json files
  return db;
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

app.use(express.json());
app.use(cookieParser());
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

function sanitizeUsername(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_\-.]/g, '');
}

// For API calls: returns a 401 JSON response if not authenticated.
function authMiddleware(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.username = payload.username;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// For page loads: redirects to /login instead of returning JSON.
function requirePage(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login');
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.redirect('/login');
  }
}

// ---------------------------------------------------------------------
// PAGES
// ---------------------------------------------------------------------
app.get('/login', (req, res) => {
  const token = req.cookies.token;
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET);
      return res.redirect('/');
    } catch (e) { /* fall through to show login */ }
  }
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.get('/', requirePage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/pages/index.html'));
});
app.get('/theaters', requirePage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/pages/theaters.html'));
});
app.get('/history', requirePage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/pages/history.html'));
});
app.get('/about', requirePage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/pages/about.html'));
});
app.get('/add-theater', requirePage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/pages/add-theater.html'));
});

// ---------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------
app.post('/api/signup', async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '');

  if (!username) return res.status(400).json({ error: 'Enter a username (letters, numbers, _ . -).' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const db = loadDB();
  if (db.users[username]) {
    return res.status(409).json({ error: 'That username is taken. Try logging in instead.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const since = new Date().toISOString();
  db.users[username] = { passwordHash, since };
  db.history[username] = [];
  saveDB(db);

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ username, since });
});

app.post('/api/login', async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '');

  const db = loadDB();
  const user = db.users[username];
  if (!user) return res.status(404).json({ error: 'No account with that username yet.' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password.' });

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ username, since: user.since });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = db.users[req.username];
  if (!user) return res.status(404).json({ error: 'Account no longer exists.' });
  res.json({ username: req.username, since: user.since });
});

// ---------------------------------------------------------------------
// THEATERS + FORECAST LOGIC
// Mirrors the notebook's approach: a theater baseline (median nightly
// audience) multiplied by day-of-week, seasonal, and booking-demand
// factors, clipped the same way the notebook clips target_ratio.
// ---------------------------------------------------------------------
const dowPatterns = {
  multiplex: [1.25, 0.80, 0.78, 0.85, 0.95, 1.35, 1.50],
  single:    [1.10, 0.85, 0.82, 0.85, 0.90, 1.15, 1.25],
  premium:   [1.30, 0.75, 0.72, 0.80, 0.90, 1.40, 1.60],
  drivein:   [0.90, 0.60, 0.60, 0.65, 0.80, 1.50, 1.70]
};

const TYPE_KEYS = ['multiplex', 'single', 'premium', 'drivein'];

// Builtin sample theaters carry their pattern directly (same shape custom
// theaters will use), so forecast logic doesn't need to branch on source.
const builtinTheaters = [
  { id: 'BN-1042', name: 'Metro Grand Multiplex', area: 'Downtown', type: 'multiplex', median: 400, phase: 0.2 },
  { id: 'BN-2087', name: 'Riverside Picture House', area: 'Riverside', type: 'single', median: 90, phase: 0.9 },
  { id: 'BN-3311', name: 'Starlight IMAX', area: 'Uptown', type: 'premium', median: 590, phase: 0.4 },
  { id: 'BN-4456', name: 'Neon Junction Cineplex', area: 'Suburb East', type: 'multiplex', median: 250, phase: 1.4 },
  { id: 'BN-5528', name: 'Old Town Talkies', area: 'Old Town', type: 'single', median: 65, phase: 2.1 },
  { id: 'BN-6690', name: 'Skyline Multiplex', area: 'Business District', type: 'multiplex', median: 330, phase: 0.7 },
  { id: 'BN-7742', name: 'Coastal Drive-In', area: 'Coastal Road', type: 'drivein', median: 140, phase: 1.9 },
  { id: 'BN-8815', name: 'Palace Premiere', area: 'City Center', type: 'premium', median: 460, phase: 0.55 }
].map((t) => ({ ...t, pattern: dowPatterns[t.type], custom: false }));

function getAllTheaters(db) {
  return [...builtinTheaters, ...(db.customTheaters || [])];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

function computeForecast(theater, date, onlinePct, offlinePct) {
  const dow = date.getDay();
  const dowMult = theater.pattern[dow];

  const doy = dayOfYear(date);
  const seasonal = 1 + 0.12 * Math.sin((2 * Math.PI * doy) / 365.25 + theater.phase);

  const onlineSignal = 0.6 + (onlinePct / 100) * 0.9;
  const offlineSignal = 0.6 + (offlinePct / 100) * 0.9;
  const bookingBlend = 1 + 0.30 * ((onlineSignal - 1) * 0.6 + (offlineSignal - 1) * 0.4);

  let ratio = dowMult * seasonal * bookingBlend;
  ratio = clamp(ratio, 0.3, 3.5);

  const pred = Math.round(theater.median * ratio);
  return {
    pred,
    low: Math.round(pred * 0.88),
    high: Math.round(pred * 1.12),
    dowMult,
    seasonal,
    bookingBlend,
    dow
  };
}

app.get('/api/theaters', (req, res) => {
  const db = loadDB();
  res.json(getAllTheaters(db));
});

// ---- Add / remove custom theaters (persisted in db.json) ----
app.post('/api/theaters', authMiddleware, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const area = String(req.body.area || '').trim().slice(0, 60);
  let type = String(req.body.type || 'multiplex').trim().toLowerCase();
  if (!TYPE_KEYS.includes(type)) type = 'multiplex';

  const median = Math.round(clamp(Number(req.body.median), 10, 2000));
  if (!name) return res.status(400).json({ error: 'Enter a theater name.' });
  if (!area) return res.status(400).json({ error: 'Enter an area or neighborhood.' });
  if (!Number.isFinite(median)) return res.status(400).json({ error: 'Enter a baseline nightly audience (10–2000).' });

  let pattern = Array.isArray(req.body.pattern) ? req.body.pattern.map(Number) : null;
  if (!pattern || pattern.length !== 7 || pattern.some((n) => !Number.isFinite(n))) {
    pattern = dowPatterns[type];
  } else {
    pattern = pattern.map((n) => Number(clamp(n, 0.3, 2.5).toFixed(2)));
  }

  const db = loadDB();
  const id = 'CT-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const theater = {
    id, name, area, type, median, pattern,
    phase: Math.random() * 2 * Math.PI,
    custom: true,
    createdBy: req.username,
    createdAt: new Date().toISOString()
  };

  db.customTheaters = db.customTheaters || [];
  db.customTheaters.push(theater);
  saveDB(db);
  res.json(theater);
});

app.delete('/api/theaters/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const list = db.customTheaters || [];
  const idx = list.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Theater not found.' });
  if (list[idx].createdBy !== req.username) {
    return res.status(403).json({ error: 'You can only remove theaters you added.' });
  }
  list.splice(idx, 1);
  db.customTheaters = list;
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/forecast', authMiddleware, (req, res) => {
  const { theaterId, date, onlinePct, offlinePct } = req.body;
  const db = loadDB();
  const theater = getAllTheaters(db).find((t) => t.id === theaterId);
  if (!theater) return res.status(400).json({ error: 'Unknown theater.' });

  const d = new Date(`${date}T12:00:00`);
  if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid date.' });

  const result = computeForecast(
    theater,
    d,
    clamp(Number(onlinePct) || 50, 0, 100),
    clamp(Number(offlinePct) || 50, 0, 100)
  );
  res.json({ theater, date, result });
});

app.get('/api/forecast/trend', authMiddleware, (req, res) => {
  const { theaterId, date, onlinePct, offlinePct } = req.query;
  const db = loadDB();
  const theater = getAllTheaters(db).find((t) => t.id === theaterId);
  if (!theater) return res.status(400).json({ error: 'Unknown theater.' });

  const center = new Date(`${date}T12:00:00`);
  if (isNaN(center.getTime())) return res.status(400).json({ error: 'Invalid date.' });

  const on = clamp(parseInt(onlinePct || '50', 10), 0, 100);
  const off = clamp(parseInt(offlinePct || '50', 10), 0, 100);

  const points = [];
  for (let i = -7; i <= 6; i++) {
    const d = new Date(center.getTime() + i * 86400000);
    const r = computeForecast(theater, d, on, off);
    points.push({ offset: i, date: d.toISOString().slice(0, 10), pred: r.pred });
  }
  res.json({ points });
});

// ---------------------------------------------------------------------
// PER-USER FORECAST HISTORY
// ---------------------------------------------------------------------
app.get('/api/history', authMiddleware, (req, res) => {
  const db = loadDB();
  res.json(db.history[req.username] || []);
});

app.post('/api/history', authMiddleware, (req, res) => {
  const db = loadDB();
  const list = db.history[req.username] || [];
  list.unshift({ ...req.body, printedAt: new Date().toISOString() });
  db.history[req.username] = list.slice(0, 20);
  saveDB(db);
  res.json(db.history[req.username]);
});

app.delete('/api/history', authMiddleware, (req, res) => {
  const db = loadDB();
  db.history[req.username] = [];
  saveDB(db);
  res.json([]);
});

app.listen(PORT, () => {
  console.log(`Cinema forecast server running at http://localhost:${PORT}`);
});
