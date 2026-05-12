const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 5000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  description TEXT
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT,
  email TEXT,
  id_proof TEXT,
  document TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked',
  total REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(room_id) REFERENCES rooms(id)
);
CREATE TABLE IF NOT EXISTS site_content (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS booking_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  customer_id INTEGER,
  doc_type TEXT,
  file_path TEXT NOT NULL,
  original_name TEXT,
  uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS booking_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  guests INTEGER DEFAULT 1,
  room_type TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  type TEXT NOT NULL DEFAULT 'advance',
  notes TEXT,
  paid_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT UNIQUE NOT NULL,
  name TEXT,
  email TEXT,
  phone TEXT,
  first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
  visit_count INTEGER DEFAULT 1,
  ip TEXT,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT NOT NULL,
  path TEXT,
  ip TEXT,
  user_agent TEXT,
  referrer TEXT,
  visited_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_visits_vid ON visits(visitor_id);
CREATE INDEX IF NOT EXISTS idx_visitors_phone ON visitors(phone);
CREATE INDEX IF NOT EXISTS idx_visitors_email ON visitors(email);
CREATE INDEX IF NOT EXISTS idx_customers_contact ON customers(contact);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);

CREATE TABLE IF NOT EXISTS room_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  image TEXT,
  short_desc TEXT,
  description TEXT,
  features TEXT,
  display_order INTEGER DEFAULT 0
);
`);

// ---- Lightweight migrations: add columns if missing ----
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
addColumnIfMissing('rooms', 'image', 'TEXT');
addColumnIfMissing('rooms', 'features', 'TEXT');
addColumnIfMissing('bookings', 'guests', 'INTEGER DEFAULT 1');
addColumnIfMissing('bookings', 'guest_details', 'TEXT');
addColumnIfMissing('bookings', 'rooms_count', 'INTEGER DEFAULT 1');
addColumnIfMissing('booking_requests', 'guest_details', 'TEXT');
addColumnIfMissing('booking_requests', 'rooms_required', 'INTEGER DEFAULT 1');
addColumnIfMissing('booking_requests', 'country_code', 'TEXT');
addColumnIfMissing('booking_documents', 'guest_index', 'INTEGER DEFAULT 0');
addColumnIfMissing('booking_documents', 'guest_name', 'TEXT');
addColumnIfMissing('room_types', 'price', 'REAL DEFAULT 0');
addColumnIfMissing('customers', 'address', 'TEXT');
addColumnIfMissing('bookings', 'room_type', 'TEXT');
addColumnIfMissing('bookings', 'room_number', 'TEXT');
addColumnIfMissing('bookings', 'notes', 'TEXT');
addColumnIfMissing('booking_requests', 'address', 'TEXT');

// Seed room types (only if table is empty) — prices included in seed
const rtCount = db.prepare('SELECT COUNT(*) AS c FROM room_types').get().c;
if (rtCount === 0) {
  const seed = db.prepare(`INSERT INTO room_types (slug, name, image, short_desc, description, features, price, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  seed.run('suite',  'Suite',    'img/room-suite.jpg',       'Spacious luxury suite with living area',          'Our Suite offers an expansive layout with a separate living area, premium furnishings, and panoramic views. Perfect for extended stays, special celebrations, and discerning guests who appreciate fine detail.',    'King-size Bed, Separate Living Area, Smart TV, Mini Bar, City View, Premium Toiletries, 24x7 Room Service',    8000, 1);
  seed.run('deluxe', 'Deluxe',   'img/room-deluxe.jpg',      'Elegant deluxe room with modern comfort',          'The Deluxe room blends modern comfort with timeless elegance. Spacious enough to relax, refined enough to remember — ideal for couples or business travellers.',                                                   'Queen-size Bed, Work Desk, Smart TV, Tea/Coffee Maker, Air Conditioning, Premium Linens, Free Wi-Fi, Daily Housekeeping', 5000, 2);
  seed.run('twin',   'Twin Bed', 'img/twin-enhanced.png',    'Twin bed room ideal for friends or family',        'The Twin Bed room features two well-appointed single beds, perfect for friends, colleagues, or families travelling together. Bright, airy, and thoughtfully designed.',                                          'Two Single Beds, Smart TV, Tea/Coffee Maker, Air Conditioning, Free Wi-Fi, Wardrobe, Daily Housekeeping',      3500, 3);
}

// Ensure prices are always set (covers existing DBs with price = 0)
db.exec(`
  UPDATE room_types SET price = 8000 WHERE slug = 'suite'  AND (price IS NULL OR price = 0);
  UPDATE room_types SET price = 5000 WHERE slug = 'deluxe' AND (price IS NULL OR price = 0);
  UPDATE room_types SET price = 3500 WHERE slug = 'twin'   AND (price IS NULL OR price = 0);
`);

const defaults = {
  hotel_name: 'The Dream Residency',
  tagline: 'A Boutique Stay of Elegance & Comfort',
  about: 'Welcome to The Dream Residency — a premium boutique hotel offering modern rooms, fine dining, and personalized hospitality. Whether you are visiting for business, leisure, or a special celebration, our dedicated team ensures every moment of your stay is memorable.',
  hero_image: 'img/lobby.png',
  about_image: 'img/collage.png',
  dining_text: 'Savour authentic flavours at our in-house restaurant. From traditional Indian cuisine to continental favourites, our chefs craft every dish with care, using the freshest seasonal ingredients.',
  dining_image: '',
  amenities: 'Free Wi-Fi, 24x7 Room Service, Restaurant, Power Backup, Laundry, Travel Desk',
  phone: '+91 00000 00000',
  phone2: '',
  email: 'contact@dreamresidency.com',
  address: 'Your address here',
  // Admin / email / storage settings
  admin_email: process.env.ADMIN_EMAIL || 'doremon69sizuka@gmail.com',
  smtp_host: process.env.SMTP_HOST || 'smtp.gmail.com',
  smtp_port: process.env.SMTP_PORT || '587',
  smtp_user: process.env.SMTP_USER || 'doremon69sizuka@gmail.com',
  smtp_pass: process.env.SMTP_PASS || 'ljxl ihtv voan xtxe',
  smtp_from_name: 'The Dream Residency',
  document_storage_path: './uploads/customer_documents',
  default_checkin_time: '11:00'
};
const upsert = db.prepare('INSERT OR IGNORE INTO site_content (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) upsert.run(k, v);

// Migration: patch any existing empty image values to bundled img/ paths
db.exec(`
  UPDATE site_content SET value='img/lobby.png'        WHERE key='hero_image'  AND (value='' OR value IS NULL);
  UPDATE site_content SET value='img/corridor.jpg'     WHERE key='about_image' AND (value='' OR value IS NULL);
  UPDATE room_types   SET image='img/room-suite.jpg'   WHERE slug='suite'  AND (image='' OR image IS NULL);
  UPDATE room_types   SET image='img/room-deluxe.jpg'  WHERE slug='deluxe' AND (image='' OR image IS NULL);
  UPDATE room_types   SET image='img/twin-enhanced.png' WHERE slug='twin'  AND (image='' OR image IS NULL);
`);

const ADMIN_USER = 'Harsh@2003';
const ADMIN_PASS = 'Dream@2010';

function getSetting(key, fallback = '') {
  const r = db.prepare('SELECT value FROM site_content WHERE key=?').get(key);
  return (r && r.value) || fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO site_content (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value ?? ''));
}

// On startup: write any environment variables into the DB so they work on
// fresh deployments (Render, Railway, etc.) where data.db starts empty.
{
  const envMap = {
    smtp_host:      process.env.SMTP_HOST,
    smtp_port:      process.env.SMTP_PORT,
    smtp_user:      process.env.SMTP_USER,
    smtp_pass:      process.env.SMTP_PASS,
    smtp_from_name: process.env.SMTP_FROM_NAME,
    admin_email:    process.env.ADMIN_EMAIL,
  };
  for (const [k, v] of Object.entries(envMap)) {
    if (v && v.trim()) setSetting(k, v.trim());
  }
}

function resolveDocStorage() {
  let p = getSetting('document_storage_path', './uploads/customer_documents');
  if (!path.isAbsolute(p)) p = path.join(__dirname, p);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

// ---- SMTP: auto-detect provider settings from email domain ----
const SMTP_PROVIDERS = {
  'gmail.com':       { host: 'smtp.gmail.com',        port: 587 },
  'googlemail.com':  { host: 'smtp.gmail.com',        port: 587 },
  'outlook.com':     { host: 'smtp.office365.com',    port: 587 },
  'hotmail.com':     { host: 'smtp.office365.com',    port: 587 },
  'live.com':        { host: 'smtp.office365.com',    port: 587 },
  'office365.com':   { host: 'smtp.office365.com',    port: 587 },
  'yahoo.com':       { host: 'smtp.mail.yahoo.com',   port: 587 },
  'yahoo.co.in':     { host: 'smtp.mail.yahoo.com',   port: 587 },
  'yahoo.in':        { host: 'smtp.mail.yahoo.com',   port: 587 },
  'zoho.com':        { host: 'smtp.zoho.com',         port: 587 },
  'zoho.in':         { host: 'smtp.zoho.in',          port: 587 },
  'icloud.com':      { host: 'smtp.mail.me.com',      port: 587 },
  'me.com':          { host: 'smtp.mail.me.com',      port: 587 }
};
function detectSmtp(email) {
  if (!email || !email.includes('@')) return null;
  const dom = email.split('@')[1].toLowerCase().trim();
  return SMTP_PROVIDERS[dom] || null;
}

// Convert common cloud-share URLs to direct-access URLs
function normalizeImageUrl(u) {
  if (!u) return u;
  let s = String(u).trim();
  // Google Drive: file/d/<id>/view  OR  open?id=<id>
  let m = s.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  if (m) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
  m = s.match(/drive\.google\.com\/open\?id=([^&]+)/);
  if (m) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
  // Dropbox: replace ?dl=0 with ?raw=1
  if (s.includes('dropbox.com') && !/[?&]raw=1/.test(s)) {
    s = s.replace(/[?&]dl=\d/, '');
    s += (s.includes('?') ? '&' : '?') + 'raw=1';
  }
  return s;
}

function buildConfirmationEmail({ hotelName, checkinTime, hotelPhone, hotelAddress, name, bookingId, roomType, checkIn, checkOut, nights, guests, total }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ede8;padding:30px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <tr><td style="background:#1a3a5c;padding:32px 36px;text-align:center;">
        <h1 style="color:#c9a96e;margin:0;font-size:26px;letter-spacing:2px;">${hotelName}</h1>
        <p style="color:#a8c4d8;margin:6px 0 0;font-size:11px;letter-spacing:4px;text-transform:uppercase;">BOOKING CONFIRMED</p>
      </td></tr>
      <tr><td style="padding:32px 36px;">
        <p style="margin:0 0 18px;color:#374151;font-size:15px;">Dear <strong>${name}</strong>,</p>
        <p style="margin:0 0 24px;color:#555;font-size:14px;line-height:1.7;">We're delighted to confirm your reservation. We look forward to welcoming you to ${hotelName}.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e2d3d;border-radius:4px;overflow:hidden;margin-bottom:24px;">
          <tr><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a9bb5;">BOOKING NO.</td><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;color:#c9a96e;font-weight:700;font-size:16px;">#${bookingId}</td></tr>
          <tr><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a9bb5;">ROOM TYPE</td><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;color:#ffffff;font-size:14px;">${roomType}</td></tr>
          <tr><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a9bb5;">CHECK-IN</td><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;color:#ffffff;font-size:14px;">${checkIn} · ${checkinTime}</td></tr>
          <tr><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a9bb5;">CHECK-OUT</td><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;color:#ffffff;font-size:14px;">${checkOut} (${nights} night${nights>1?'s':''})</td></tr>
          <tr><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a9bb5;">GUESTS</td><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;color:#ffffff;font-size:14px;">${guests}</td></tr>
          <tr><td style="padding:12px 18px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#c9a96e;">TOTAL AMOUNT</td><td style="padding:12px 18px;color:#c9a96e;font-weight:700;font-size:18px;">₹${total.toLocaleString('en-IN')}</td></tr>
        </table>
        <p style="margin:0 0 18px;color:#555;font-size:13px;line-height:1.6;">Please carry your original photo ID (Aadhar/Passport) for check-in.</p>
        <div style="background:#f9f6f0;border:1px solid #e8dec5;border-radius:4px;padding:16px 18px;margin-bottom:20px;">
          <strong style="color:#1a3a5c;font-size:13px;">Contact Us</strong><br>
          <span style="color:#555;font-size:13px;">📞 ${hotelPhone}</span><br>
          <span style="color:#555;font-size:13px;">📍 ${hotelAddress}</span>
        </div>
        <p style="margin:0 0 6px;color:#555;font-size:13px;line-height:1.6;">If you have any questions, please don't hesitate to contact us. We're here to make your stay exceptional.</p>
        <p style="margin:18px 0 0;color:#1a3a5c;font-size:13px;"><em>Warm regards,</em><br><strong>${hotelName}</strong></p>
      </td></tr>
      <tr><td style="background:#1a3a5c;padding:16px 36px;text-align:center;">
        <p style="margin:0;color:#7a9bb5;font-size:11px;">This is an automated confirmation email. Please do not reply.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendMail({ to, subject, html, text }) {
  const host = getSetting('smtp_host');
  const user = getSetting('smtp_user');
  const pass = getSetting('smtp_pass');
  if (!host || !user || !pass) return { sent: false, reason: 'SMTP not configured. Open Site Content → Email Settings.' };
  const port = parseInt(getSetting('smtp_port', '587'));
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
  const fromName = getSetting('smtp_from_name', 'The Dream Residency');
  await transporter.sendMail({
    from: `"${fromName}" <${user}>`,
    to,
    cc: getSetting('admin_email') || undefined,
    subject,
    text,
    html
  });
  return { sent: true };
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(require('cookie-parser')());
app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
  secret: process.env.SESSION_SECRET || 'dream-residency-stable-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 }
}));

// Visitor cookie middleware — assigns each browser a long-lived ID
function ensureVisitorCookie(req, res, next) {
  let vid = req.cookies && req.cookies.dr_vid;
  if (!vid) {
    vid = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    res.cookie('dr_vid', vid, { httpOnly: false, maxAge: 1000 * 60 * 60 * 24 * 365 * 2, sameSite: 'lax' });
  }
  req.visitorId = vid;
  next();
}
app.use(ensureVisitorCookie);

app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const safe = file.originalname.replace(/[^a-z0-9.\-_]/gi, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Auth
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/me', (req, res) => res.json({ admin: !!(req.session && req.session.admin) }));

// Site content (public read)
app.get('/api/content', (_, res) => {
  const rows = db.prepare('SELECT key, value FROM site_content').all();
  const out = {};
  rows.forEach(r => out[r.key] = r.value);
  res.json(out);
});
app.put('/api/content', requireAdmin, (req, res) => {
  const body = req.body || {};
  // SMTP auto-config: when admin enters smtp_user (or admin_email), auto-fill host/port if blank
  const probeEmail = body.smtp_user || body.admin_email || '';
  const detected = detectSmtp(probeEmail);
  if (detected) {
    const curHost = (body.smtp_host !== undefined ? body.smtp_host : getSetting('smtp_host')) || '';
    const curPort = (body.smtp_port !== undefined ? body.smtp_port : getSetting('smtp_port')) || '';
    if (!curHost) body.smtp_host = detected.host;
    if (!curPort) body.smtp_port = String(detected.port);
  }
  // If smtp_user is set but no separate from-name, keep default
  for (const [k, v] of Object.entries(body)) setSetting(k, v);
  res.json({ ok: true, smtp_detected: !!detected });
});
// Image: accept either a file upload OR a URL (e.g. Google Drive / Dropbox / any direct image link)
app.post('/api/content/image', requireAdmin, upload.single('image'), (req, res) => {
  const key = req.body.key;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  let url;
  if (req.file) {
    url = '/uploads/' + req.file.filename;
  } else if (req.body.url && String(req.body.url).trim()) {
    url = normalizeImageUrl(String(req.body.url).trim());
  } else {
    return res.status(400).json({ error: 'Provide a file or a URL' });
  }
  setSetting(key, url);
  res.json({ ok: true, url });
});
// Allow saving a plain URL via JSON too
app.put('/api/content/image-url', requireAdmin, (req, res) => {
  const { key, url } = req.body || {};
  if (!key || !url) return res.status(400).json({ error: 'Missing key or url' });
  const normalized = normalizeImageUrl(url);
  setSetting(key, normalized);
  res.json({ ok: true, url: normalized });
});

// ---------- Room Types (the public "fixed" categories displayed on the website) ----------
function rtToPublic(rt) {
  if (!rt) return null;
  const featArr = String(rt.features || '').split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
  return {
    id: rt.id,
    slug: rt.slug,
    category: rt.slug,            // alias used by admin UI
    name: rt.name,
    image: rt.image || '',
    short_desc: rt.short_desc || '',
    description: rt.description || '',
    features: featArr,
    price: rt.price || 0,
    display_order: rt.display_order || 0
  };
}
function findRoomType(idOrSlug) {
  if (!idOrSlug) return null;
  const s = String(idOrSlug).toLowerCase().trim();
  if (/^\d+$/.test(s)) return db.prepare('SELECT * FROM room_types WHERE id=?').get(Number(s));
  // Match by slug first, then by name (case-insensitive) — handles "Twin Bed", "twin", "SUITE" etc.
  return db.prepare('SELECT * FROM room_types WHERE slug=? OR LOWER(name)=? LIMIT 1').get(s, s);
}
app.get('/api/room-types', (_, res) => {
  const rows = db.prepare('SELECT * FROM room_types ORDER BY display_order, id').all();
  res.json(rows.map(rtToPublic));
});
app.put('/api/room-types/:key', requireAdmin, (req, res) => {
  const rt = findRoomType(req.params.key);
  if (!rt) return res.status(404).json({ error: 'Not found' });
  const { name, image, short_desc, description, features, display_order, price } = req.body || {};
  const featStr = Array.isArray(features) ? features.join('\n') : (features ?? rt.features);
  db.prepare('UPDATE room_types SET name=?, image=?, short_desc=?, description=?, features=?, display_order=?, price=? WHERE id=?')
    .run(
      name ?? rt.name,
      image ?? rt.image,
      short_desc ?? rt.short_desc,
      description ?? rt.description,
      featStr,
      display_order ?? rt.display_order,
      price !== undefined ? Number(price) : (rt.price || 0),
      rt.id
    );
  res.json({ ok: true });
});
app.post('/api/room-types/:key/image', requireAdmin, upload.single('image'), (req, res) => {
  const rt = findRoomType(req.params.key);
  if (!rt) return res.status(404).json({ error: 'Not found' });
  let url;
  if (req.file) url = '/uploads/' + req.file.filename;
  else if (req.body.url && String(req.body.url).trim()) url = normalizeImageUrl(String(req.body.url).trim());
  else return res.status(400).json({ error: 'Provide a file or url' });
  db.prepare('UPDATE room_types SET image=? WHERE id=?').run(url, rt.id);
  res.json({ ok: true, url });
});

// ---------- Rooms (inventory) ----------
app.get('/api/rooms', (_, res) => res.json(db.prepare('SELECT * FROM rooms ORDER BY number').all()));
app.post('/api/rooms', requireAdmin, (req, res) => {
  const { number, category, price, status, description, image, features } = req.body;
  if (!number || !category || price === undefined) return res.status(400).json({ error: 'Number, category, price are required' });
  try {
    const r = db.prepare('INSERT INTO rooms (number, category, price, status, description, image, features) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(number, category, price, status || 'available', description || '', image || '', features || '');
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/rooms/:id', requireAdmin, (req, res) => {
  const { number, category, price, status, description, image, features } = req.body;
  const cur = db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE rooms SET number=?, category=?, price=?, status=?, description=?, image=?, features=? WHERE id=?')
    .run(
      number ?? cur.number,
      category ?? cur.category,
      price ?? cur.price,
      status ?? cur.status,
      description ?? cur.description,
      image ?? cur.image,
      features ?? cur.features,
      req.params.id
    );
  res.json({ ok: true });
});
app.post('/api/rooms/:id/image', requireAdmin, upload.single('image'), (req, res) => {
  const cur = db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  let url;
  if (req.file) url = '/uploads/' + req.file.filename;
  else if (req.body.url && String(req.body.url).trim()) url = normalizeImageUrl(String(req.body.url).trim());
  else return res.status(400).json({ error: 'Provide a file or url' });
  db.prepare('UPDATE rooms SET image=? WHERE id=?').run(url, req.params.id);
  res.json({ ok: true, url });
});
app.delete('/api/rooms/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM rooms WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Customers ----------
app.get('/api/customers', requireAdmin, (_, res) => res.json(db.prepare('SELECT * FROM customers ORDER BY id DESC').all()));

app.post('/api/customers', requireAdmin, upload.single('document'), (req, res) => {
  const { name, contact, email, id_proof } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!id_proof || !String(id_proof).trim()) return res.status(400).json({ error: 'ID proof number is required' });
  const document = req.file ? '/uploads/' + req.file.filename : null;
  const r = db.prepare('INSERT INTO customers (name, contact, email, id_proof, document) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), contact || '', email || '', id_proof.trim(), document);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/customers/:id', requireAdmin, upload.single('document'), (req, res) => {
  const { name, contact, email, id_proof } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!id_proof || !String(id_proof).trim()) return res.status(400).json({ error: 'ID proof number is required' });
  if (req.file) {
    db.prepare('UPDATE customers SET name=?, contact=?, email=?, id_proof=?, document=? WHERE id=?')
      .run(name.trim(), contact || '', email || '', id_proof.trim(), '/uploads/' + req.file.filename, req.params.id);
  } else {
    db.prepare('UPDATE customers SET name=?, contact=?, email=?, id_proof=? WHERE id=?')
      .run(name.trim(), contact || '', email || '', id_proof.trim(), req.params.id);
  }
  res.json({ ok: true });
});
// NOTE: Customer delete removed by design — admin must use Edit instead.

// ---------- Bookings ----------
app.get('/api/bookings', requireAdmin, (_, res) => {
  const rows = db.prepare(`
    SELECT b.*, c.name AS customer_name, c.contact AS customer_contact, c.email AS customer_email,
           r.number AS room_number, r.category AS room_category,
           COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid,
           COALESCE(b.total, 0) - COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS pending
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    JOIN rooms r ON r.id = b.room_id
    ORDER BY b.id DESC
  `).all();
  res.json(rows);
});
app.get('/api/bookings/:id', requireAdmin, (req, res) => {
  const b = db.prepare(`
    SELECT b.*, c.name AS customer_name, c.contact AS customer_contact, c.email AS customer_email, c.id_proof AS customer_id_proof,
           r.number AS room_number, r.category AS room_category, r.price AS room_price,
           COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    JOIN rooms r ON r.id = b.room_id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  let guests = [];
  if (b.guest_details) { try { guests = JSON.parse(b.guest_details); } catch {} }
  res.json({ ...b, guests });
});

// Helper: compute total = nights × room price × rooms_count
function computeTotal({ check_in, check_out, room_price, rooms_count }) {
  const ci = new Date(check_in), co = new Date(check_out);
  const nights = Math.max(1, Math.round((co - ci) / 86400000));
  return nights * (parseFloat(room_price) || 0) * Math.max(1, parseInt(rooms_count) || 1);
}

// Payments
app.get('/api/bookings/:id/payments', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM payments WHERE booking_id=? ORDER BY id DESC').all(req.params.id));
});
app.post('/api/bookings/:id/payments', requireAdmin, (req, res) => {
  const { amount, method, type, notes } = req.body || {};
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
  const r = db.prepare('INSERT INTO payments (booking_id, amount, method, type, notes) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.id, amt, method || 'cash', type || 'advance', notes || '');
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/payments/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM payments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/api/availability', (req, res) => {
  const { check_in, check_out } = req.query;
  if (!check_in || !check_out) return res.json(db.prepare("SELECT * FROM rooms WHERE status='available'").all());
  const taken = db.prepare(`
    SELECT room_id FROM bookings
    WHERE status IN ('booked','checked_in')
      AND NOT (check_out <= ? OR check_in >= ?)
  `).all(check_in, check_out).map(r => r.room_id);
  const placeholders = taken.length ? taken.map(() => '?').join(',') : null;
  const sql = placeholders
    ? `SELECT * FROM rooms WHERE id NOT IN (${placeholders})`
    : 'SELECT * FROM rooms';
  res.json(db.prepare(sql).all(...taken));
});

// Create booking — supports BOTH:
//   (a) existing customer flow — pass customer_id
//   (b) new customer in one step — pass `customer: { name, contact, email, id_proof }`
// Total is auto-calculated server-side from room price × nights × rooms_count.
app.post('/api/bookings', requireAdmin, (req, res) => {
  let { customer_id, room_id, check_in, check_out, guests, guest_details, rooms_count, customer } = req.body || {};
  if (!room_id || !check_in || !check_out) return res.status(400).json({ error: 'Room and dates are required' });

  // Inline customer creation if no id provided
  if (!customer_id) {
    if (!customer || !customer.name) return res.status(400).json({ error: 'Provide customer_id or new customer details' });
    if (!customer.id_proof || !String(customer.id_proof).trim()) return res.status(400).json({ error: 'ID proof number is required for new customer' });
    const r = db.prepare('INSERT INTO customers (name, contact, email, id_proof) VALUES (?, ?, ?, ?)')
      .run(String(customer.name).trim(), customer.contact || '', customer.email || '', String(customer.id_proof).trim());
    customer_id = r.lastInsertRowid;
  }

  const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(room_id);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const computedTotal = computeTotal({ check_in, check_out, room_price: room.price, rooms_count });
  const gd = guest_details ? (typeof guest_details === 'string' ? guest_details : JSON.stringify(guest_details)) : null;
  const guestCount = parseInt(guests) || (Array.isArray(guest_details) ? guest_details.length : 1);
  const roomsCount = Math.max(1, parseInt(rooms_count) || 1);

  const r = db.prepare('INSERT INTO bookings (customer_id, room_id, check_in, check_out, total, guests, guest_details, rooms_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(customer_id, room_id, check_in, check_out, computedTotal, guestCount, gd, roomsCount);
  db.prepare("UPDATE rooms SET status='booked' WHERE id=?").run(room_id);
  res.json({ id: r.lastInsertRowid, customer_id, total: computedTotal, nights: Math.max(1, Math.round((new Date(check_out) - new Date(check_in))/86400000)) });
});

// Edit booking guest_details / rooms_count after creation (e.g. when extra guest added)
app.put('/api/bookings/:id', requireAdmin, (req, res) => {
  const cur = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { guests, guest_details, rooms_count, check_in, check_out } = req.body || {};
  const gd = guest_details === undefined ? cur.guest_details : (typeof guest_details === 'string' ? guest_details : JSON.stringify(guest_details));
  const gCount = guests === undefined ? cur.guests : parseInt(guests) || 1;
  const rCount = rooms_count === undefined ? cur.rooms_count : Math.max(1, parseInt(rooms_count) || 1);
  const ci = check_in || cur.check_in;
  const co = check_out || cur.check_out;
  const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(cur.room_id);
  const newTotal = computeTotal({ check_in: ci, check_out: co, room_price: room ? room.price : 0, rooms_count: rCount });
  db.prepare('UPDATE bookings SET guests=?, guest_details=?, rooms_count=?, check_in=?, check_out=?, total=? WHERE id=?')
    .run(gCount, gd, rCount, ci, co, newTotal, req.params.id);
  res.json({ ok: true, total: newTotal });
});

app.put('/api/bookings/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE bookings SET status=? WHERE id=?').run(status, req.params.id);
  let roomStatus = 'available';
  if (status === 'checked_in') roomStatus = 'occupied';
  else if (status === 'booked') roomStatus = 'booked';
  db.prepare('UPDATE rooms SET status=? WHERE id=?').run(roomStatus, b.room_id);
  res.json({ ok: true });
});
app.delete('/api/bookings/:id', requireAdmin, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (b) {
    db.prepare('DELETE FROM bookings WHERE id=?').run(req.params.id);
    db.prepare("UPDATE rooms SET status='available' WHERE id=?").run(b.room_id);
  }
  res.json({ ok: true });
});

// ---------- Reports ----------
function reportRange(period, customStart, customEnd) {
  const now = new Date();
  let start, end = now.toISOString().slice(0, 10);
  if (period === 'today') { start = end; }
  else if (period === 'weekly') { const s = new Date(now); s.setDate(now.getDate() - 7); start = s.toISOString().slice(0, 10); }
  else if (period === 'monthly') { const s = new Date(now); s.setMonth(now.getMonth() - 1); start = s.toISOString().slice(0, 10); }
  else if (period === 'yearly') { const s = new Date(now); s.setFullYear(now.getFullYear() - 1); start = s.toISOString().slice(0, 10); }
  else if (period === 'custom' && customStart && customEnd) { start = customStart; end = customEnd; }
  else { const s = new Date(now); s.setFullYear(now.getFullYear() - 1); start = s.toISOString().slice(0, 10); }
  return { start, end };
}

app.get('/api/reports/:period', requireAdmin, (req, res) => {
  const { start, end } = reportRange(req.params.period, req.query.start, req.query.end);
  const bookings = db.prepare(`
    SELECT b.id, b.check_in, b.check_out, b.status, b.total, b.created_at,
           c.name AS customer, c.contact AS contact,
           r.number AS room, r.category,
           COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid,
           COALESCE(b.total, 0) - COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS pending
    FROM bookings b
    JOIN customers c ON c.id=b.customer_id
    JOIN rooms r ON r.id=b.room_id
    WHERE date(b.created_at) BETWEEN ? AND ?
       OR date(b.check_in)  BETWEEN ? AND ?
    ORDER BY b.created_at DESC
  `).all(start, end, start, end);

  const pmtRows = db.prepare(`
    SELECT p.*, b.id AS booking_id, c.name AS customer
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    JOIN customers c ON c.id = b.customer_id
    WHERE date(p.paid_at) BETWEEN ? AND ?
    ORDER BY p.paid_at DESC
  `).all(start, end);

  const totalBooked = bookings.reduce((s, r) => s + (r.total || 0), 0);
  const totalCollected = pmtRows.reduce((s, p) => s + (p.amount || 0), 0);
  const totalPending = bookings.filter(b => b.status !== 'cancelled').reduce((s, r) => s + (r.pending > 0 ? r.pending : 0), 0);

  const byMethod = {};
  pmtRows.forEach(p => { byMethod[p.method] = (byMethod[p.method] || 0) + p.amount; });
  const byStatus = {};
  bookings.forEach(b => { byStatus[b.status] = (byStatus[b.status] || 0) + 1; });

  const customerTotals = {};
  bookings.forEach(b => {
    const k = b.customer + '|' + b.contact;
    if (!customerTotals[k]) customerTotals[k] = { customer: b.customer, contact: b.contact, stays: 0, revenue: 0 };
    customerTotals[k].stays += 1;
    customerTotals[k].revenue += (b.total || 0);
  });
  const topCustomers = Object.values(customerTotals).sort((a,b) => b.revenue - a.revenue).slice(0, 10);

  const roomTotals = {};
  bookings.forEach(b => {
    const k = b.room + ' (' + b.category + ')';
    if (!roomTotals[k]) roomTotals[k] = { room: k, bookings: 0, revenue: 0 };
    roomTotals[k].bookings += 1;
    roomTotals[k].revenue += (b.total || 0);
  });
  const topRooms = Object.values(roomTotals).sort((a,b) => b.revenue - a.revenue);

  const totalRooms = db.prepare("SELECT COUNT(*) AS c FROM rooms").get().c;
  const days = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1);
  const occupiedNights = bookings
    .filter(b => b.status !== 'cancelled')
    .reduce((s, b) => {
      const ci = new Date(Math.max(new Date(b.check_in), new Date(start)));
      const co = new Date(Math.min(new Date(b.check_out), new Date(end)));
      return s + Math.max(0, Math.round((co - ci) / 86400000));
    }, 0);
  const occupancyPct = totalRooms > 0 ? Math.round((occupiedNights / (totalRooms * days)) * 100) : 0;

  res.json({
    start, end, days,
    totals: {
      bookings: bookings.length,
      booked: totalBooked,
      collected: totalCollected,
      pending: totalPending,
      occupancy: occupancyPct,
      occupied_nights: occupiedNights,
      total_room_nights: totalRooms * days
    },
    byMethod, byStatus, topCustomers, topRooms,
    rows: bookings,
    payments: pmtRows
  });
});

app.get('/api/reports/:period/csv', requireAdmin, (req, res) => {
  const { start, end } = reportRange(req.params.period, req.query.start, req.query.end);
  const rows = db.prepare(`
    SELECT b.id, c.name AS customer, c.contact, r.number AS room, r.category,
           b.check_in, b.check_out, b.status, b.total,
           COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid,
           COALESCE(b.total, 0) - COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS pending,
           b.created_at
    FROM bookings b
    JOIN customers c ON c.id=b.customer_id
    JOIN rooms r ON r.id=b.room_id
    WHERE date(b.created_at) BETWEEN ? AND ? OR date(b.check_in) BETWEEN ? AND ?
    ORDER BY b.created_at DESC
  `).all(start, end, start, end);
  const headers = ['id','customer','contact','room','category','check_in','check_out','status','total','paid','pending','created_at'];
  const csv = [headers.join(',')]
    .concat(rows.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="report-${start}-to-${end}.csv"`);
  res.send(csv);
});

// Dashboard summary — real business KPIs
app.get('/api/dashboard', requireAdmin, (_, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0,7) + '-01';
  const weekStartD = new Date(); weekStartD.setDate(weekStartD.getDate() - 7);
  const weekStart = weekStartD.toISOString().slice(0, 10);

  const totalRooms = db.prepare("SELECT COUNT(*) AS c FROM rooms").get().c;
  const occupiedRooms = db.prepare("SELECT COUNT(*) AS c FROM rooms WHERE status='occupied'").get().c;
  const bookedRooms = db.prepare("SELECT COUNT(*) AS c FROM rooms WHERE status='booked'").get().c;
  const availableRooms = db.prepare("SELECT COUNT(*) AS c FROM rooms WHERE status='available'").get().c;

  const todayCheckIns = db.prepare(`
    SELECT b.id, c.name, c.contact, r.number AS room, r.category, b.total,
      COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid
    FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN rooms r ON r.id=b.room_id
    WHERE b.check_in = ? AND b.status IN ('booked','checked_in')
  `).all(today);

  const todayCheckOuts = db.prepare(`
    SELECT b.id, c.name, c.contact, r.number AS room, r.category, b.total,
      COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid,
      COALESCE(b.total,0) - COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS pending
    FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN rooms r ON r.id=b.room_id
    WHERE b.check_out = ? AND b.status IN ('booked','checked_in')
  `).all(today);

  const inHouse = db.prepare(`
    SELECT b.id, c.name, c.contact, r.number AS room, r.category, b.check_out
    FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN rooms r ON r.id=b.room_id
    WHERE b.status='checked_in'
  `).all();

  const collectedToday = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE date(paid_at) = ?").get(today).s;
  const collectedWeek = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE date(paid_at) >= ?").get(weekStart).s;
  const collectedMonth = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE date(paid_at) >= ?").get(monthStart).s;

  const pendingDues = db.prepare(`
    SELECT COALESCE(SUM(b.total - COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0)), 0) AS s
    FROM bookings b WHERE b.status IN ('booked','checked_in')
  `).get().s;

  const pendingRequests = db.prepare("SELECT COUNT(*) AS c FROM booking_requests WHERE status='pending'").get().c;
  const totalCustomers = db.prepare("SELECT COUNT(*) AS c FROM customers").get().c;
  const totalVisitorsToday = db.prepare("SELECT COUNT(DISTINCT visitor_id) AS c FROM visits WHERE date(visited_at) = ?").get(today).c;
  const totalVisitorsWeek = db.prepare("SELECT COUNT(DISTINCT visitor_id) AS c FROM visits WHERE date(visited_at) >= ?").get(weekStart).c;

  res.json({
    rooms: { total: totalRooms, occupied: occupiedRooms, booked: bookedRooms, available: availableRooms,
             occupancy: totalRooms ? Math.round(((occupiedRooms+bookedRooms)/totalRooms)*100) : 0 },
    today: { check_ins: todayCheckIns, check_outs: todayCheckOuts, collected: collectedToday },
    in_house: inHouse,
    revenue: { today: collectedToday, week: collectedWeek, month: collectedMonth, pending_dues: pendingDues },
    counts: { pending_requests: pendingRequests, customers: totalCustomers, visitors_today: totalVisitorsToday, visitors_week: totalVisitorsWeek }
  });
});

// Visitor tracking (PUBLIC)
app.post('/api/track', (req, res) => {
  const vid = req.visitorId;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ua = req.headers['user-agent'] || '';
  const ref = req.headers.referer || req.body.referrer || '';
  const path = (req.body && req.body.path) || '/';
  const existing = db.prepare('SELECT * FROM visitors WHERE visitor_id=?').get(vid);
  if (existing) {
    db.prepare('UPDATE visitors SET last_seen=CURRENT_TIMESTAMP, visit_count=visit_count+1, ip=?, user_agent=? WHERE visitor_id=?')
      .run(ip, ua, vid);
  } else {
    db.prepare('INSERT INTO visitors (visitor_id, ip, user_agent) VALUES (?, ?, ?)').run(vid, ip, ua);
  }
  db.prepare('INSERT INTO visits (visitor_id, path, ip, user_agent, referrer) VALUES (?, ?, ?, ?, ?)')
    .run(vid, path, ip, ua, ref);
  res.json({ ok: true, visitor_id: vid });
});

app.post('/api/identify', (req, res) => {
  const vid = req.visitorId;
  const { name, email, phone } = req.body || {};
  const existing = db.prepare('SELECT * FROM visitors WHERE visitor_id=?').get(vid);
  if (!existing) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';
    db.prepare('INSERT INTO visitors (visitor_id, name, email, phone, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(vid, name || '', email || '', phone || '', ip, ua);
  } else {
    db.prepare('UPDATE visitors SET name=COALESCE(NULLIF(?,""), name), email=COALESCE(NULLIF(?,""), email), phone=COALESCE(NULLIF(?,""), phone), last_seen=CURRENT_TIMESTAMP WHERE visitor_id=?')
      .run(name || '', email || '', phone || '', vid);
  }
  res.json({ ok: true });
});

app.get('/api/visitors', requireAdmin, (_, res) => {
  const rows = db.prepare(`
    SELECT v.*, 
      (SELECT COUNT(*) FROM visits WHERE visitor_id = v.visitor_id) AS total_visits,
      (SELECT id FROM customers WHERE (contact = v.phone AND v.phone <> '') OR (email = v.email AND v.email <> '') LIMIT 1) AS customer_id
    FROM visitors v
    ORDER BY datetime(v.last_seen) DESC
  `).all();
  res.json(rows);
});

app.get('/api/visitors/:vid/history', requireAdmin, (req, res) => {
  const visits = db.prepare('SELECT * FROM visits WHERE visitor_id=? ORDER BY id DESC LIMIT 200').all(req.params.vid);
  const v = db.prepare('SELECT * FROM visitors WHERE visitor_id=?').get(req.params.vid);
  res.json({ visitor: v, visits });
});

app.delete('/api/visitors/:vid', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM visits WHERE visitor_id=?').run(req.params.vid);
  db.prepare('DELETE FROM visitors WHERE visitor_id=?').run(req.params.vid);
  res.json({ ok: true });
});

// Customer lookup by phone OR email OR name (used by Walk-In search)
app.get('/api/customers/lookup', requireAdmin, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ matches: [] });
  const rows = db.prepare(`
    SELECT c.*, 
      (SELECT COUNT(*) FROM bookings WHERE customer_id = c.id) AS booking_count,
      (SELECT MAX(check_out) FROM bookings WHERE customer_id = c.id) AS last_stay,
      (SELECT COALESCE(SUM(CAST(julianday(check_out) - julianday(check_in) AS INTEGER)), 0) FROM bookings WHERE customer_id = c.id) AS total_nights
    FROM customers c
    WHERE c.contact LIKE ? OR c.email LIKE ? OR c.name LIKE ?
    ORDER BY c.id DESC LIMIT 20
  `).all('%' + q + '%', '%' + q + '%', '%' + q + '%');
  res.json({ matches: rows });
});

// Customer's full history (bookings + documents + summary)
app.get('/api/customers/:id/history', requireAdmin, (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const bookings = db.prepare(`
    SELECT b.*, r.number AS room_number, r.category AS room_category,
           CAST(julianday(b.check_out) - julianday(b.check_in) AS INTEGER) AS nights,
           COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid
    FROM bookings b JOIN rooms r ON r.id=b.room_id
    WHERE b.customer_id=? ORDER BY b.id DESC
  `).all(req.params.id);
  // attach parsed guests
  bookings.forEach(b => { try { b.guests_list = b.guest_details ? JSON.parse(b.guest_details) : []; } catch { b.guests_list = []; } });
  const docs = db.prepare('SELECT * FROM booking_documents WHERE customer_id=? ORDER BY id DESC').all(req.params.id);
  const totalVisits = bookings.length;
  const totalNights = bookings.reduce((s,b) => s + (b.nights || 0), 0);
  const totalRevenue = bookings.reduce((s,b) => s + (b.total || 0), 0);
  const totalPaid = bookings.reduce((s,b) => s + (b.paid || 0), 0);
  res.json({
    customer: c,
    bookings,
    documents: docs,
    summary: {
      total_visits: totalVisits,
      total_nights: totalNights,
      total_revenue: totalRevenue,
      total_paid: totalPaid,
      first_visit: bookings.length ? bookings[bookings.length - 1].check_in : null,
      last_visit: bookings.length ? bookings[0].check_in : null
    }
  });
});

// ---------- Booking requests (PUBLIC submit, with multi-guest details) ----------
app.post('/api/request-booking', (req, res) => {
  const { name, phone, country_code, email, check_in, check_out, guests, room_type, message, guest_details, rooms_required } = req.body || {};
  if (!name || !phone || !check_in || !check_out) return res.status(400).json({ error: 'Name, phone, check-in and check-out are required.' });
  // Future-only date enforcement
  const today = new Date(); today.setHours(0,0,0,0);
  if (new Date(check_in) < today) return res.status(400).json({ error: 'Check-in must be today or a future date.' });
  if (new Date(check_out) <= new Date(check_in)) return res.status(400).json({ error: 'Check-out must be after check-in.' });
  const fullPhone = country_code ? `${country_code} ${phone}`.trim() : phone;
  const gd = guest_details ? (typeof guest_details === 'string' ? guest_details : JSON.stringify(guest_details)) : null;
  const r = db.prepare(`INSERT INTO booking_requests (name, phone, country_code, email, check_in, check_out, guests, room_type, message, guest_details, rooms_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, fullPhone, country_code || '', email || '', check_in, check_out, parseInt(guests) || 1, room_type || '', message || '', gd, parseInt(rooms_required) || 1);
  // Identify the visitor at the same time
  const vid = req.visitorId;
  if (vid) {
    const existing = db.prepare('SELECT * FROM visitors WHERE visitor_id=?').get(vid);
    if (!existing) {
      db.prepare('INSERT INTO visitors (visitor_id, name, email, phone) VALUES (?, ?, ?, ?)')
        .run(vid, name, email || '', fullPhone);
    } else {
      db.prepare('UPDATE visitors SET name=?, email=?, phone=?, last_seen=CURRENT_TIMESTAMP WHERE visitor_id=?')
        .run(name, email || '', fullPhone, vid);
    }
  }
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.get('/api/booking-requests', requireAdmin, (_, res) => {
  const rows = db.prepare('SELECT * FROM booking_requests ORDER BY id DESC').all();
  rows.forEach(r => { try { r.guests_list = r.guest_details ? JSON.parse(r.guest_details) : []; } catch { r.guests_list = []; } });
  res.json(rows);
});

app.put('/api/booking-requests/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE booking_requests SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ ok: true });
});

app.post('/api/booking-requests/:id/confirm', requireAdmin, async (req, res) => {
  const { room_number } = req.body;
  const reqRow = db.prepare('SELECT * FROM booking_requests WHERE id=?').get(req.params.id);
  if (!reqRow) return res.status(404).json({ error: 'Request not found' });
  if (!room_number || !String(room_number).trim()) return res.status(400).json({ error: 'Room number is required' });

  const roomNum = String(room_number).trim();
  const rt = findRoomType(reqRow.room_type) || db.prepare('SELECT * FROM room_types ORDER BY id LIMIT 1').get();
  const rtSlug  = rt ? rt.slug  : 'suite';
  const rtPrice = rt ? (rt.price || 0) : 0;
  const rtName  = rt ? rt.name  : (reqRow.room_type || 'Room');

  // Find or create a room record matching the number + type
  let room = db.prepare('SELECT * FROM rooms WHERE number=?').get(roomNum);
  if (!room) {
    const rr = db.prepare('INSERT INTO rooms (number, category, price, status) VALUES (?, ?, ?, ?)')
      .run(roomNum, rtSlug, rtPrice, 'booked');
    room = db.prepare('SELECT * FROM rooms WHERE id=?').get(rr.lastInsertRowid);
  } else {
    db.prepare("UPDATE rooms SET status='booked' WHERE id=?").run(room.id);
  }

  // Find or create customer (match by phone)
  let cust = db.prepare('SELECT * FROM customers WHERE contact=?').get(reqRow.phone);
  if (!cust) {
    const r = db.prepare('INSERT INTO customers (name, contact, email) VALUES (?, ?, ?)')
      .run(reqRow.name, reqRow.phone, reqRow.email || '');
    cust = { id: r.lastInsertRowid, name: reqRow.name, contact: reqRow.phone, email: reqRow.email };
  }

  // Compute total — auto, server-side only
  const computedTotal = computeTotal({
    check_in: reqRow.check_in,
    check_out: reqRow.check_out,
    room_price: rtPrice,
    rooms_count: reqRow.rooms_required || 1
  });
  const nights = Math.max(1, Math.round((new Date(reqRow.check_out) - new Date(reqRow.check_in))/86400000));

  const bk = db.prepare('INSERT INTO bookings (customer_id, room_id, check_in, check_out, total, status, guests, guest_details, rooms_count, room_type, room_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(cust.id, room.id, reqRow.check_in, reqRow.check_out, computedTotal, 'booked', reqRow.guests || 1, reqRow.guest_details || null, reqRow.rooms_required || 1, roomTypeSlag, roomNum);
  db.prepare("UPDATE booking_requests SET status='confirmed' WHERE id=?").run(req.params.id);

  // Send confirmation email (no room number in customer-facing email per spec)
  let emailResult = { sent: false };
  if (reqRow.email) {
    const hotelName = getSetting('hotel_name', 'The Dream Residency');
    const checkinTime = getSetting('default_checkin_time', '11:00');
    const hotelPhone = getSetting('phone', '+91 00000 00000');
    const hotelAddress = getSetting('address', '');
    try {
      emailResult = await sendMail({
        to: reqRow.email,
        subject: `Booking Confirmed – ${hotelName} (Booking #${bk.lastInsertRowid})`,
        text: `Dear ${reqRow.name},\n\nYour booking at ${hotelName} is confirmed.\n\nBooking #${bk.lastInsertRowid}\nRoom Type: ${rtName}\nCheck-in: ${reqRow.check_in} at ${checkinTime}\nCheck-out: ${reqRow.check_out} (${nights} night${nights>1?'s':''})\nGuests: ${reqRow.guests || 1}\nTotal Amount: ₹${computedTotal.toLocaleString('en-IN')}\n\nPlease carry your original photo ID (Aadhar/Passport) for check-in.\n\nContact Us:\n${hotelPhone}\n${hotelAddress}\n\nWe look forward to welcoming you!\nWarm regards,\n${hotelName}`,
        html: buildConfirmationEmail({ hotelName, checkinTime, hotelPhone, hotelAddress, name: reqRow.name, bookingId: bk.lastInsertRowid, roomType: rtName, checkIn: reqRow.check_in, checkOut: reqRow.check_out, nights, guests: reqRow.guests || 1, total: computedTotal })
      });
    } catch (e) { emailResult = { sent: false, reason: e.message }; }
  }

  res.json({ ok: true, booking_id: bk.lastInsertRowid, customer_id: cust.id, total: computedTotal, email: emailResult });
});

// ---- Manual booking (walk-in / phone call) — directly confirmed ----
app.post('/api/manual-booking', requireAdmin, async (req, res) => {
  let { name, phone, email, address, id_proof, guests, room_type, room_number, check_in, check_out, notes, payment_amount, payment_method } = req.body || {};
  if (!name || !phone || !room_type || !room_number || !check_in || !check_out)
    return res.status(400).json({ error: 'Name, phone, room type, room number, and dates are required' });

  const roomNum = String(room_number).trim();
  const slug = String(room_type).toLowerCase();
  const rt = findRoomType(slug) || db.prepare('SELECT * FROM room_types ORDER BY id LIMIT 1').get();
  const rtPrice = rt ? (rt.price || 0) : 0;

  // Find or create room record
  let room = db.prepare('SELECT * FROM rooms WHERE number=?').get(roomNum);
  if (!room) {
    const rr = db.prepare('INSERT INTO rooms (number, category, price, status) VALUES (?, ?, ?, ?)')
      .run(roomNum, slug, rtPrice, 'booked');
    room = db.prepare('SELECT * FROM rooms WHERE id=?').get(rr.lastInsertRowid);
  } else {
    db.prepare("UPDATE rooms SET status='booked' WHERE id=?").run(room.id);
  }

  // Find or create customer
  let cust = db.prepare('SELECT * FROM customers WHERE contact=?').get(phone);
  if (!cust) {
    if (!id_proof) return res.status(400).json({ error: 'ID proof number is required for new customer' });
    const r = db.prepare('INSERT INTO customers (name, contact, email, id_proof, address) VALUES (?, ?, ?, ?, ?)')
      .run(String(name).trim(), phone, email || '', String(id_proof).trim(), address || '');
    cust = { id: r.lastInsertRowid, name, contact: phone, email };
  } else {
    if (id_proof) db.prepare('UPDATE customers SET id_proof=?, address=COALESCE(NULLIF(?,""),address) WHERE id=?').run(id_proof, address||'', cust.id);
  }

  const computedTotal = computeTotal({ check_in, check_out, room_price: rtPrice, rooms_count: 1 });

  const bk = db.prepare('INSERT INTO bookings (customer_id, room_id, check_in, check_out, total, status, guests, rooms_count, room_type, room_number, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(cust.id, room.id, check_in, check_out, computedTotal, 'booked', parseInt(guests)||1, 1, slug, roomNum, notes||'');

  // Record payment if provided
  if (payment_amount && parseFloat(payment_amount) > 0) {
    db.prepare('INSERT INTO payments (booking_id, amount, method, type, notes) VALUES (?, ?, ?, ?, ?)')
      .run(bk.lastInsertRowid, parseFloat(payment_amount), payment_method || 'cash', 'advance', 'Manual booking payment');
  }

  res.json({ ok: true, booking_id: bk.lastInsertRowid, customer_id: cust.id, total: computedTotal });
});

app.delete('/api/booking-requests/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM booking_requests WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Booking documents (per guest) ----------
const docStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, resolveDocStorage()),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-z0-9.\-_]/gi, '_');
    cb(null, `bk${req.params.id}_${Date.now()}_${safe}`);
  }
});
const docUpload = multer({ storage: docStorage, limits: { fileSize: 15 * 1024 * 1024 } });

app.get('/api/bookings/:id/documents', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM booking_documents WHERE booking_id=? ORDER BY guest_index, id DESC').all(req.params.id));
});

app.post('/api/bookings/:id/documents', requireAdmin, docUpload.array('documents', 20), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  const docType = req.body.doc_type || 'ID Proof';
  const guestIndex = parseInt(req.body.guest_index) || 0;
  const guestName = req.body.guest_name || '';
  const stmt = db.prepare('INSERT INTO booking_documents (booking_id, customer_id, doc_type, file_path, original_name, guest_index, guest_name) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const saved = [];
  for (const f of (req.files || [])) {
    const r = stmt.run(req.params.id, b.customer_id, docType, f.path, f.originalname, guestIndex, guestName);
    saved.push({ id: r.lastInsertRowid, name: f.originalname, path: f.path, guest_index: guestIndex });
  }
  res.json({ ok: true, files: saved });
});

app.get('/api/documents/:id/download', requireAdmin, (req, res) => {
  const d = db.prepare('SELECT * FROM booking_documents WHERE id=?').get(req.params.id);
  if (!d || !fs.existsSync(d.file_path)) return res.status(404).send('Not found');
  res.download(d.file_path, d.original_name || path.basename(d.file_path));
});

app.delete('/api/documents/:id', requireAdmin, (req, res) => {
  const d = db.prepare('SELECT * FROM booking_documents WHERE id=?').get(req.params.id);
  if (d && fs.existsSync(d.file_path)) { try { fs.unlinkSync(d.file_path); } catch {} }
  db.prepare('DELETE FROM booking_documents WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Test email setup
app.post('/api/test-email', requireAdmin, async (_, res) => {
  const adminEmail = getSetting('admin_email');
  if (!adminEmail) return res.status(400).json({ error: 'Set Admin Email in Site Content first' });
  try {
    const r = await sendMail({
      to: adminEmail,
      subject: 'Test Email – The Dream Residency',
      text: 'This is a test email. Your SMTP configuration is working.',
      html: '<p>This is a test email. Your SMTP configuration is working.</p>'
    });
    if (!r.sent) return res.status(400).json({ error: r.reason || 'SMTP not configured' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hidden admin route
app.get('/admin-dream/login', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin-dream', (_, res) => res.redirect('/admin-dream/login'));
app.get('/admin', (_, res) => res.status(404).send('Not found'));

app.listen(PORT, '0.0.0.0', () => console.log(`Dream Residency running on port ${PORT}`));
