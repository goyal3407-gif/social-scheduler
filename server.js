// Social Scheduler by Goyal Kumar
// Express backend + MongoDB storage (MONGODB_URI in Vercel env vars), with
// local JSON files in data/ ONLY as a local-dev fallback. On Vercel the
// filesystem is ephemeral, so nothing durable may live in files there:
// users, sessions, posts, media, templates, settings, the Instagram token
// and import jobs all live in MongoDB (database "social_scheduler", a
// separate database in the same Atlas cluster as PureNest).
// Login: email + password accounts (first user is the owner), scrypt hashes,
// HMAC-signed httpOnly session cookie (SESSION_SECRET from env — set it in
// Vercel or logins die on every redeploy/restart).
// Instagram token: paste it in Settings (verified live, encrypted at rest
// in MongoDB) or set INSTAGRAM_ACCESS_TOKEN / IG_USER_ID env vars.
// Never commit a token, a password hash, or any credential.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.disable('x-powered-by'); // don't advertise the stack in every response
const PORT = process.env.PORT || 3000;

// SESSION_SECRET signs login cookies: it MUST come from env vars in
// production. Without it a random per-process secret is generated and every
// user is logged out whenever the server restarts or Vercel redeploys —
// that was the main login bug. /api/db-status reports whether the env var
// is set (name only, never the value).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET is not set — sessions use a random secret and will NOT survive a restart or redeploy. Set SESSION_SECRET in Vercel env vars (all environments).');
}
const SESSION_COOKIE = 'ss_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

app.use(express.json({ limit: '15mb' })); // largest legit body is a ~12 MB base64 upload; 100 MB invited abuse
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Security headers (no new dependency): nosniff, no framing, no referrer
// leak, a real CSP that still allows Instagram CDN media + data: uploads,
// and a locked-down permissions policy. API JSON is never cached.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' https: data: blob:; font-src 'self'; connect-src 'self' https://graph.facebook.com; frame-ancestors 'none'; base-uri 'self'");
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Request log: method/path/status/ms only — never bodies, tokens or cookies.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (req.path.startsWith('/api')) console.log(`[api] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// Rate limiting (in-memory, per instance): 300 requests/min per IP on the
// API generally, 20/min on auth routes. Generous on purpose — the import
// poller hits every 1.5 s and publish polls every 5 s, so a tight limit
// would break real use. Returns 429 + Retry-After.
const rateBuckets = new Map();
function rateLimit(max, windowMs, name) {
  return (req, res, next) => {
    const key = `${name}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const rec = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
    rec.count += 1;
    rateBuckets.set(key, rec);
    if (rec.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'Too many requests — please wait a minute and try again.' });
    }
    return next();
  };
}
const apiRateLimit = rateLimit(300, 60000, 'api');
const authRateLimit = rateLimit(20, 60000, 'auth');
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
}, 60000).unref?.();

// Same-origin check on state-changing API calls: the frontend is
// same-origin, so a cross-origin POST/PATCH/DELETE with an Origin header
// is CSRF, not a user. The cron endpoint is exempt (bearer token instead).
app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !req.path.startsWith('/cron/')) {
    const origin = req.get('origin');
    if (origin) {
      try {
        const host = req.get('host') || '';
        const originHost = new URL(origin).host;
        // Local dev: the Vite dev server (localhost:5173) proxies /api to
        // this server (localhost:3000), so Origin and Host legitimately
        // differ by port. Allow localhost origins outside production only.
        const isLocalOrigin = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHost);
        if (originHost !== host && !(process.env.NODE_ENV !== 'production' && isLocalOrigin)) {
          return res.status(403).json({ ok: false, error: 'That request did not come from this site — please use the app itself.' });
        }
      } catch { /* malformed Origin: fall through to auth */ }
    }
  }
  next();
});

// Security: reject MongoDB operator keys ($gt, $ne, ...) and prototype
// pollution keys (__proto__, constructor) ANYWHERE in a JSON body, plus
// dotted keys. Request bodies are data, never query operators — an object
// smuggled in as a field value used to be cast to a string and corrupt the
// saved post. Legitimate bodies here only ever use plain field names.
function hasBadKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return false;
  if (Array.isArray(value)) return value.some((v) => hasBadKey(v, depth + 1));
  return Object.keys(value).some((k) =>
    k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype' || hasBadKey(value[k], depth + 1));
}
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && hasBadKey(req.body)) {
    return res.status(400).json({ ok: false, error: 'That request contained something the server does not accept — please try again.' });
  }
  next();
});

// Serve the Vite build when present. Hashed /assets/* files are immutable
// for a year; index.html is never cached (it references the new hashes).
const DIST = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST, {
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
}

function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'); }
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- auth (email + password, scrypt hashes, signed cookie) ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, user) {
  if (!user || !user.passwordHash || !user.salt) return false;
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = Buffer.from(hashPassword(password, user.salt), 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, role: u.role || 'member', createdAt: u.createdAt };
}
function signSession(sessionId, userId) {
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${sessionId}.${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(payload, 'utf8').toString('base64url') + '.' + sig;
}
async function verifySession(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    const a = Buffer.from(sig, 'utf8'); const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const [sessionId, userId, exp] = payload.split('.');
    if (!sessionId || !userId || !exp || Number(exp) < Date.now()) return null;
    // Logged-out sessions are rejected. A missing session record does NOT
    // reject (logins made while the DB was down still work from the cookie).
    try { if (await db.isSessionRevoked(sessionId)) return null; } catch { /* DB hiccup: trust the signed cookie */ }
    return { sessionId, userId };
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function getAuthUser(req) {
  const verified = await verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!verified) return null;
  return db.getUserById(verified.userId);
}
function isSecureRequest(req) {
  return process.env.NODE_ENV === 'production' || req.secure || req.get('x-forwarded-proto') === 'https';
}
async function setSessionCookie(req, res, userId) {
  const sessionId = uid('sess');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  try { await db.createSession({ id: sessionId, userId, expiresAt, revoked: false, createdAt: new Date().toISOString() }); } catch { /* login must not fail because the session ledger write failed */ }
  res.cookie(SESSION_COOKIE, signSession(sessionId, userId), {
    httpOnly: true, sameSite: 'lax', secure: isSecureRequest(req),
    path: '/', maxAge: SESSION_MAX_AGE_MS,
  });
  return sessionId;
}
async function clearSessionCookie(req, res) {
  const verified = await verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (verified) { try { await db.revokeSession(verified.sessionId); } catch { /* cookie is cleared below regardless */ } }
  res.cookie(SESSION_COOKIE, '', {
    httpOnly: true, sameSite: 'lax', secure: isSecureRequest(req),
    path: '/', maxAge: 0,
  });
}
async function requireAuth(req, res, next) {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Please log in first — your session has expired or you are not logged in.' });
  req.user = publicUser(user);
  req.userId = user.id;
  return next();
}
// Every /api/* route except /api/health, /api/db-status and /api/auth/*
// requires login.
app.use('/api', apiRateLimit, (req, res, next) => { if (req.path.startsWith('/auth/')) return authRateLimit(req, res, next); return next(); });
app.use('/api', ah(async (req, res, next) => {
  if (req.path === '/health' || req.path === '/db-status' || req.path.startsWith('/auth/') || req.path.startsWith('/cron/')) return next();
  // Make sure the database connection is up (no-op when already connected
  // or when no MONGODB_URI is set — JSON fallback is used then).
  await db.ensureMongo();
  return requireAuth(req, res, next);
}));

function validEmail(email) { return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()); }

// Simple login throttle: 10 failed attempts per email in 10 minutes, then
// a plain 429. In-memory per container — best-effort on serverless.
const loginAttempts = new Map();
function loginBlocked(email) {
  const rec = loginAttempts.get(email);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { loginAttempts.delete(email); return false; }
  return rec.count >= 10;
}
function recordFailedLogin(email) {
  const rec = loginAttempts.get(email) || { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  rec.count += 1;
  loginAttempts.set(email, rec);
}

app.post('/api/auth/signup', ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email address, like you@example.com.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters long.' });
  if (password.length > 128) return res.status(400).json({ ok: false, error: 'Password must be at most 128 characters long.' });
  const users = await db.listUsers();
  if (users.some((u) => u.email === email)) return res.status(409).json({ ok: false, error: 'An account with this email already exists — log in instead.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: uid('user'), email, salt,
    passwordHash: hashPassword(password, salt),
    role: users.length === 0 ? 'owner' : 'member',
    createdAt: new Date().toISOString(),
  };
  await db.saveUser(user);
  await setSessionCookie(req, res, user.id);
  res.json({ ok: true, user: publicUser(user) });
}));
app.post('/api/auth/login', ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!validEmail(email) || !password) return res.status(400).json({ ok: false, error: 'Enter your email and password.' });
  if (loginBlocked(email)) return res.status(429).json({ ok: false, error: 'Too many wrong attempts — wait 10 minutes and try again.' });
  const user = await db.getUserByEmail(email);
  if (!user || !verifyPassword(password, user)) {
    recordFailedLogin(email);
    return res.status(401).json({ ok: false, error: 'Wrong email or password. Check both and try again — or sign up if you have no account yet.' });
  }
  loginAttempts.delete(email);
  await setSessionCookie(req, res, user.id);
  res.json({ ok: true, user: publicUser(user) });
}));
app.get('/api/auth/me', ah(async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Not logged in. Please log in again.' });
  res.json({ ok: true, user: publicUser(user) });
}));
app.post('/api/auth/logout', ah(async (req, res) => {
  await clearSessionCookie(req, res);
  res.json({ ok: true });
}));
// Change password: the old password must be correct, the new one must be
// 8–128 chars. All other sessions are revoked — a password change logs
// every other device out.
app.post('/api/auth/change-password', ah(async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Please log in first — your session has expired or you are not logged in.' });
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');
  if (!verifyPassword(current, user)) return res.status(401).json({ ok: false, error: 'Your current password is not right — check it and try again.' });
  if (next.length < 8) return res.status(400).json({ ok: false, error: 'The new password must be at least 8 characters long.' });
  if (next.length > 128) return res.status(400).json({ ok: false, error: 'The new password must be at most 128 characters long.' });
  if (next === current) return res.status(400).json({ ok: false, error: 'The new password is the same as the old one — pick a different one.' });
  const salt = crypto.randomBytes(16).toString('hex');
  await db.updateUser(user.id, { salt, passwordHash: hashPassword(next, salt) });
  // Revoke every session except the one making this request.
  try {
    const verified = await verifySession(parseCookies(req)[SESSION_COOKIE]);
    if (verified) {
      const sessions = await db.listSessions();
      for (const s of sessions) {
        if (s.userId === user.id && s.id !== verified.sessionId) await db.revokeSession(s.id);
      }
    }
  } catch { /* password already changed; session cleanup is best-effort */ }
  res.json({ ok: true });
}));
// Delete my account: removes the user and everything that belongs to them
// (posts, media, templates, settings, Instagram connection, import jobs,
// sessions). If the deleted user was the owner, the oldest remaining user
// becomes the owner so the app is never ownerless.
app.delete('/api/auth/account', ah(async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Please log in first — your session has expired or you are not logged in.' });
  const wasOwner = user.role === 'owner';
  await clearSessionCookie(req, res);
  await db.deleteUserData(user.id);
  if (wasOwner) {
    const remaining = await db.listUsers();
    if (remaining.length) await db.updateUser(remaining[0].id, { role: 'owner' });
  }
  res.json({ ok: true });
}));

// ---------- per-user data helpers ----------
// Internal uses (stats, publish-due, next-best-time) need the full list,
// not the paginated API page.
async function getPosts(req) { return db.listPosts(req.userId, { all: true }); }
async function getMedia(req) { return db.listMedia(req.userId, { all: true }); }
function getTemplates(req) { return db.listTemplates(req.userId); }
async function getSettings(req) {
  const s = await db.getSettings(req.userId);
  return { instagramHandle: s.instagramHandle || '', ...s };
}
// Instagram credentials: a token pasted in Settings is stored server-side
// (encrypted in MongoDB) and takes priority; env vars are the fallback.
// The full token is never sent to the frontend — only a masked form.
// Accepts either a req-like object ({ userId }) or a bare userId string
// (used by the cron publisher, which has no request user).
function uidOf(x) { return typeof x === 'string' ? x : (x && x.userId) || ''; }
async function getInstagramStored(x) {
  const userId = uidOf(x);
  if (!userId) return {};
  const s = await db.getInstagram(userId);
  return s && typeof s === 'object' ? s : {};
}
async function getInstagramCreds(x) {
  const userId = uidOf(x);
  const stored = await getInstagramStored(userId);
  const token = stored.token || process.env.INSTAGRAM_ACCESS_TOKEN || '';
  const igUserId = stored.igUserId || process.env.IG_USER_ID || '';
  return { token, igUserId, username: stored.username || '', source: stored.token ? 'stored' : (process.env.INSTAGRAM_ACCESS_TOKEN ? 'env' : 'none') };
}
function maskToken(t) {
  if (!t) return '';
  if (t.length <= 8) return '••••••••';
  return t.slice(0, 4) + '…' + t.slice(-4);
}
async function igConfigured(req) { const c = await getInstagramCreds(req); return !!(c.token && c.igUserId); }

// Plain-words version of an Instagram Graph API error.
function friendlyGraphError(data, fallback) {
  const err = data && data.error;
  const msg = (err && (err.message || '')) || '';
  const code = err && err.code;
  if (code === 190 || /invalid oauth|expired|invalid token/i.test(msg)) {
    return 'Instagram says this token is invalid or expired. Generate a fresh token in your Meta app dashboard (API Setup → Generate token) and paste it again.';
  }
  if (code === 100 || /permission|not authorized|does not exist/i.test(msg)) {
    return 'Instagram rejected the request — the token may lack permission or the Instagram User ID may be wrong. Generate a fresh token with instagram_business_basic and instagram_business_content_publish, check the User ID, and try again.';
  }
  if (msg) return `Instagram said: ${msg} Generate a fresh token and try again if this keeps happening.`;
  return fallback;
}

// ---------- health / stats ----------
app.get('/api/health', ah(async (req, res) => {
  res.json({ ok: true, service: 'social-scheduler', db: db.getStatus().db, instagramConfigured: await igConfigured(req).catch(() => false) });
}));
app.get('/health', (req, res) => res.json({ ok: true, service: 'social-scheduler' }));
// Database + login health: names/booleans only, never values. If db is
// "json", data does NOT survive redeploys — set MONGODB_URI in Vercel.
// If sessionSecretFromEnv is false, logins die on every restart — set
// SESSION_SECRET in Vercel.
app.get('/api/db-status', (req, res) => {
  const s = db.getStatus();
  res.json({
    ok: true,
    db: s.db,
    database: s.database,
    mongoReady: s.mongoReady,
    uriConfigured: s.uriConfigured,
    sessionSecretFromEnv: s.sessionSecretFromEnv,
    tokenEncryptionAvailable: s.tokenEncryptionAvailable,
    lastError: s.lastError,
    warning: s.db !== 'mongodb'
      ? 'Database is local JSON files — accounts and posts will disappear on redeploy. Set MONGODB_URI in Vercel env vars.'
      : (!s.sessionSecretFromEnv ? 'SESSION_SECRET is not set — logins will not survive a restart or redeploy. Set SESSION_SECRET in Vercel env vars.' : null),
  });
});
app.get('/api/stats', ah(async (req, res) => {
  const posts = await getPosts(req); const media = await getMedia(req);
  res.json({
    ok: true,
    scheduled: posts.filter((p) => p.status === 'scheduled').length,
    published: posts.filter((p) => p.status === 'published').length,
    failed: posts.filter((p) => p.status === 'failed').length,
    drafts: posts.filter((p) => p.status === 'draft').length,
    mediaCount: media.length,
    total: posts.length,
  });
}));
// Export my data: the user's own posts, media, templates and settings as
// JSON. The Instagram token is never included.
app.get('/api/export', ah(async (req, res) => {
  const [posts, media, templates, settings] = await Promise.all([
    db.listPosts(req.userId), db.listMedia(req.userId), db.listTemplates(req.userId), db.getSettings(req.userId),
  ]);
  res.setHeader('Content-Disposition', 'attachment; filename="social-scheduler-export.json"');
  res.json({ ok: true, exportedAt: new Date().toISOString(), user: req.user, posts, media, templates, settings });
}));

// ---------- settings ----------
app.get('/api/settings', ah(async (req, res) => {
  const s = await getSettings(req);
  const ig = await getInstagramCreds(req);
  const stored = await getInstagramStored(req);
  const settingsResponse = {
    ok: true,
    instagramHandle: s.instagramHandle || ig.username || '',
    instagramConnected: !!(ig.token && ig.igUserId),
    tokenConfigured: !!(ig.token && ig.igUserId),
    instagramUsername: ig.username || '',
    maskedToken: maskToken(ig.token),
    tokenSource: ig.source,
    igUserIdSet: !!ig.igUserId,
    tokenEncrypted: stored.token ? !!stored.encrypted : null,
    instagramProfile: stored.profile || null,
    connectedAt: stored.connectedAt || '',
    setupDone: s.setupDone === true,
  };
  res.json(settingsResponse);
}));
app.post('/api/settings', ah(async (req, res) => {
  const s = { ...(await getSettings(req)), ...(req.body || {}) };
  // Settings hold simple values only — objects/arrays are rejected so a
  // crafted value cannot corrupt the stored settings.
  for (const [k, v] of Object.entries(req.body || {})) {
    if (v !== null && typeof v === 'object') return res.status(400).json({ ok: false, error: `The setting “${k}” is not valid — settings can only hold simple text or on/off values.` });
  }
  // Tokens and the connected flag are never set from this form — the
  // connection state comes only from /api/instagram/connect (verified
  // against the Graph API) or the env fallback.
  delete s.token; delete s.accessToken; delete s.instagramConnected; delete s.tokenConfigured;
  delete s.maskedToken; delete s.tokenSource; delete s.instagramUsername;
  delete s.instagramProfile; delete s.tokenEncrypted;
  await db.saveSettings(req.userId, s);
  const ig = await getInstagramCreds(req);
  const stored = await getInstagramStored(req);
  res.json({ ok: true, instagramHandle: s.instagramHandle || ig.username || '', instagramConnected: !!(ig.token && ig.igUserId), tokenConfigured: !!(ig.token && ig.igUserId), instagramUsername: ig.username || '', maskedToken: maskToken(ig.token), tokenSource: ig.source, igUserIdSet: !!ig.igUserId, tokenEncrypted: stored.token ? !!stored.encrypted : null, instagramProfile: stored.profile || null, connectedAt: stored.connectedAt || '', setupDone: s.setupDone === true });
}));

// ---------- Instagram connect (paste token, verified live) ----------
async function graphGet(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return r.json().catch(() => null);
}
app.post('/api/instagram/connect', ah(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  let igUserId = String(req.body?.igUserId || '').trim();
  if (!token) return res.status(400).json({ ok: false, error: 'Paste your Instagram access token first.' });
  if (!igUserId) igUserId = process.env.IG_USER_ID || '';
  if (!igUserId) {
    // No User ID given: try to resolve it from the token itself. /me with
    // a valid token returns the account; we only accept it if a second
    // check proves it is an Instagram Business account (has media_count).
    try {
      const me = await graphGet('https://graph.facebook.com/v27.0/me?fields=id,username&access_token=' + encodeURIComponent(token));
      if (me && me.id && !me.error) {
        const check = await graphGet('https://graph.facebook.com/v27.0/' + encodeURIComponent(me.id) + '?fields=username,media_count&access_token=' + encodeURIComponent(token));
        if (check && check.id && check.media_count !== undefined) igUserId = me.id;
      }
    } catch { /* fall through to the missing-ID error below */ }
  }
  if (!igUserId) return res.status(400).json({ ok: false, error: 'Instagram User ID is missing — paste it below (it is the number in your Meta app, API Setup page), or set IG_USER_ID on the server.' });
  // Verify the token live against the Graph API before storing anything.
  let data;
  try {
    data = await graphGet('https://graph.facebook.com/v27.0/' + encodeURIComponent(igUserId) + '?fields=username&access_token=' + encodeURIComponent(token));
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'Could not reach Instagram to verify the token — check your connection and try again.' });
  }
  if (!data || data.error) {
    return res.status(400).json({ ok: false, error: friendlyGraphError(data, 'Instagram rejected this token. Generate a fresh token in the Meta app dashboard and try again.') });
  }
  if (!data.id) return res.status(400).json({ ok: false, error: 'Instagram did not recognise this token for that User ID. Check the User ID and generate a fresh token, then try again.' });
  await db.saveInstagram(req.userId, { token, igUserId, username: data.username || '', connectedAt: new Date().toISOString() });
  res.json({ ok: true, username: data.username || '', igUserId, maskedToken: maskToken(token), instagramConnected: true, tokenSource: 'stored' });
}));
app.post('/api/instagram/disconnect', ah(async (req, res) => {
  await db.clearInstagram(req.userId);
  const ig = await getInstagramCreds(req);
  res.json({ ok: true, instagramConnected: !!(ig.token && ig.igUserId), tokenSource: ig.source, maskedToken: maskToken(ig.token), instagramUsername: ig.username || '' });
}));

// ---------- Instagram import (profile + existing media) ----------
// Runs as a background job so the UI can poll progress. Fetches the profile
// (username, picture, bio, media count) and pages through the account's
// media, saving media into the library and each item into the queue as a
// published post with its original caption and permalink. Followers and DMs
// are NOT imported — Meta does not allow it.
// Jobs are persisted in MongoDB (not memory), so polling survives Vercel
// serverless cold starts. If a run stalls (container frozen), the next
// poll resumes it.
const runningImports = new Set();
async function runInstagramImport(job) {
  if (runningImports.has(job.id)) return;
  runningImports.add(job.id);
  try {
    const ig = await getInstagramCreds({ userId: job.userId });
    if (!ig.token || !ig.igUserId) throw new Error('Instagram is not connected — connect it first.');
    const base = 'https://graph.facebook.com/v27.0';
    const profile = await graphGet(base + '/' + encodeURIComponent(ig.igUserId) + '?fields=username,profile_picture_url,biography,media_count&access_token=' + encodeURIComponent(ig.token));
    if (!profile || profile.error) throw new Error(friendlyGraphError(profile, 'Instagram rejected the request. The token may lack permission — generate a fresh token with instagram_business_basic and try again.'));
    job.profile = {
      username: profile.username || '',
      profilePictureUrl: profile.profile_picture_url || '',
      biography: profile.biography || '',
      mediaCount: profile.media_count || 0,
    };
    job.updatedAt = new Date().toISOString();
    await db.saveImportJob(job);
    const stored = await db.getInstagram(job.userId);
    await db.saveInstagram(job.userId, { ...stored, username: profile.username || stored.username || '', profile: job.profile, importedAt: new Date().toISOString() });
    const settings = await db.getSettings(job.userId);
    if (profile.username && !settings.instagramHandle) { settings.instagramHandle = profile.username; await db.saveSettings(job.userId, settings); }

    let nextUrl = base + '/' + encodeURIComponent(ig.igUserId) + '/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,permalink&limit=50&access_token=' + encodeURIComponent(ig.token);
    let pages = 0;
    // Load the user's existing library + queue ONCE, then dedupe in memory
    // (Sets) — the old code re-read both full lists on every page of 50.
    const existingMedia = await db.listMedia(job.userId, { all: true });
    const existingPosts = await db.listPosts(job.userId, { all: true });
    const seenMediaIds = new Set(existingMedia.map((m) => m.instagramId).filter(Boolean));
    const seenMediaUrls = new Set(existingMedia.map((m) => m.url).filter(Boolean));
    const seenPostIds = new Set(existingPosts.map((p) => p.instagramId).filter(Boolean));
    const seenPostLinks = new Set(existingPosts.map((p) => p.liveUrl).filter(Boolean));
    while (nextUrl && pages < 10) {
      pages++;
      const page = await graphGet(nextUrl);
      if (!page || page.error) throw new Error(friendlyGraphError(page, 'Instagram stopped the import. The token may lack permission.'));
      const items = Array.isArray(page.data) ? page.data : [];
      job.fetched += items.length;
      const newMedia = [];
      const newPosts = [];
      for (const item of items) {
        const mediaUrl = item.media_url || item.thumbnail_url || '';
        const isVideo = item.media_type === 'VIDEO';
        const kind = isVideo ? 'video' : 'image';
        const alreadyMedia = seenMediaIds.has(item.id) || (mediaUrl && seenMediaUrls.has(mediaUrl));
        if (!alreadyMedia && mediaUrl) {
          newMedia.push({
            id: uid('media'), userId: job.userId, url: mediaUrl, title: (item.caption || '').slice(0, 80) || `${item.media_type || 'Post'} ${item.id}`,
            kind, size: 0, duration: 0, folder: 'Instagram import',
            tags: [], favorite: false, usedCount: 0,
            instagramId: item.id, permalink: item.permalink || '', createdAt: item.timestamp || new Date().toISOString(),
          });
          job.importedMedia++;
          seenMediaIds.add(item.id);
          if (mediaUrl) seenMediaUrls.add(mediaUrl);
        }
        const alreadyPost = seenPostIds.has(item.id) || (item.permalink && seenPostLinks.has(item.permalink));
        if (!alreadyPost) {
          newPosts.push({
            id: uid('post'), userId: job.userId,
            mediaUrl, mediaType: kind,
            caption: item.caption || '', hashtags: '', cta: '',
            platform: 'Instagram',
            scheduleTime: item.timestamp || new Date().toISOString(),
            status: 'published', format: isVideo ? 'REELS' : 'FEED',
            liveUrl: item.permalink || '', instagramId: item.id,
            createdAt: new Date().toISOString(),
          });
          job.importedPosts++;
          seenPostIds.add(item.id);
          if (item.permalink) seenPostLinks.add(item.permalink);
        }
      }
      if (newMedia.length) await db.saveMediaBulk(newMedia);
      if (newPosts.length) await db.savePostsBulk(newPosts);
      job.updatedAt = new Date().toISOString();
      await db.saveImportJob(job);
      nextUrl = page.paging && page.paging.next ? page.paging.next : null;
    }
    job.status = 'done';
    job.done = true;
    job.updatedAt = new Date().toISOString();
    job.message = job.fetched === 0
      ? 'No media found on this Instagram account yet — nothing to import.'
      : `Imported ${job.importedMedia} media item${job.importedMedia === 1 ? '' : 's'} and ${job.importedPosts} post${job.importedPosts === 1 ? '' : 's'} from Instagram.`;
  } catch (e) {
    job.status = 'error';
    job.done = true;
    job.updatedAt = new Date().toISOString();
    job.error = e.message || 'Import failed.';
  } finally {
    runningImports.delete(job.id);
    try { await db.saveImportJob(job); } catch { /* job state already saved best-effort */ }
  }
}
app.post('/api/instagram/import', ah(async (req, res) => {
  const ig = await getInstagramCreds(req);
  if (!ig.token || !ig.igUserId) {
    return res.status(400).json({ ok: false, error: 'Instagram is not connected — connect it first (Settings, or step 1 of the setup wizard).' });
  }
  const job = { id: uid('job'), userId: req.userId, status: 'running', done: false, fetched: 0, importedMedia: 0, importedPosts: 0, profile: null, error: null, message: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await db.saveImportJob(job);
  runInstagramImport(job); // async — poll GET /api/instagram/import/:jobId
  res.json({ ok: true, jobId: job.id });
}));
app.get('/api/instagram/import/:jobId', ah(async (req, res) => {
  const job = await db.getImportJob(req.userId, req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Import job not found — it may have been started before the last redeploy. Start a new import.' });
  // Resume a stalled run: on serverless the container that started the
  // import can freeze after the response; the next poll picks it back up.
  if (job.status === 'running' && !runningImports.has(job.id)) {
    const updatedAt = job.updatedAt ? new Date(job.updatedAt).getTime() : 0;
    if (!updatedAt || Date.now() - updatedAt > 25000) runInstagramImport(job);
  }
  res.json({ ok: true, job });
}));

// ---------- posts ----------
const STATUSES = ['scheduled', 'draft', 'published', 'failed'];
const FORMATS = ['REELS', 'FEED', 'STORY'];
const PLATFORMS = ['Instagram', 'YouTube', 'Facebook', 'TikTok'];
function validPostInput(b, { requireMedia = true } = {}) {
  // Field values must be plain strings — an object/array value used to be
  // cast to a string by the database layer and corrupt the saved post.
  const STR_FIELDS = ['mediaUrl', 'mediaType', 'caption', 'hashtags', 'cta', 'platform', 'scheduleTime', 'status', 'format', 'liveUrl'];
  for (const k of STR_FIELDS) if (b[k] !== undefined && typeof b[k] !== 'string') return 'One of the fields in that post is not valid — please try again.';
  // Drafts are plans: they may be saved without media or a time yet, and
  // the media is added later in Studio. Scheduled posts must have media.
  const needsMedia = requireMedia && (b.status || 'scheduled') !== 'draft';
  if (needsMedia && !b.mediaUrl) return 'Add a media link first — a post needs a video or image URL.';
  if (b.mediaUrl && typeof b.mediaUrl !== 'string') return 'That media link is not valid.';
  if (b.mediaUrl && !/^(https?:\/\/|data:image\/|data:video\/)/i.test(b.mediaUrl)) return 'That media link is not valid — paste a full https:// link to a video or image.';
  if (b.status && !STATUSES.includes(b.status)) return 'That post status is not valid.';
  if (b.format && !FORMATS.includes(b.format)) return 'That format is not valid — use REELS, FEED or STORY.';
  if (b.platform && !PLATFORMS.includes(b.platform)) return 'That platform is not valid.';
  if (b.scheduleTime) {
    const d = new Date(b.scheduleTime);
    if (Number.isNaN(d.getTime())) return 'That date/time is not valid — pick a date and time from the calendar picker.';
  }
  if (b.hashtags && b.hashtags.split(/[\s,]+/).filter((t) => t.replace(/^#/, '').trim()).length > 30) return 'Instagram allows at most 30 hashtags per post — remove some and try again.';
  return null;
}
function buildPost(b, userId) {
  return {
    id: uid('post'), userId,
    mediaUrl: b.mediaUrl,
    mediaType: b.mediaType || 'video',
    caption: b.caption || '',
    hashtags: b.hashtags || '',
    cta: b.cta || '',
    platform: b.platform || 'Instagram',
    // Drafts may have no time yet; scheduled posts default to now.
    scheduleTime: b.scheduleTime || ((b.status || 'scheduled') === 'draft' ? '' : new Date().toISOString()),
    status: b.status || 'scheduled',
    format: b.format || 'REELS',
    liveUrl: b.liveUrl || '',
    createdAt: new Date().toISOString(),
  };
}
app.get('/api/posts', ah(async (req, res) => res.json({ ok: true, posts: await db.listPosts(req.userId, { limit: req.query.limit, offset: req.query.offset }) })));
app.post('/api/posts', ah(async (req, res) => {
  const b = req.body || {};
  const err = validPostInput(b);
  if (err) return res.status(400).json({ ok: false, error: err });
  const post = buildPost(b, req.userId);
  await db.savePost(post);
  res.json({ ok: true, post });
}));
// Bulk import: one request for many rows instead of one request per row
// (a 100-row CSV used to take 100 round trips and often timed out).
app.post('/api/posts/bulk', ah(async (req, res) => {
  const rows = Array.isArray(req.body?.posts) ? req.body.posts : null;
  if (!rows) return res.status(400).json({ ok: false, error: 'Send a list of posts to import.' });
  if (rows.length > 500) return res.status(400).json({ ok: false, error: 'Import at most 500 posts at a time.' });
  const valid = [];
  const errors = [];
  rows.forEach((b, i) => {
    const err = validPostInput(b || {});
    if (err) { errors.push(`Row ${i + 1}: ${err}`); return; }
    valid.push(buildPost(b, req.userId));
  });
  if (valid.length) await db.savePostsBulk(valid);
  res.json({ ok: true, imported: valid.length, failed: rows.length - valid.length, errors: errors.slice(0, 10) });
}));
app.patch('/api/posts/:id', ah(async (req, res) => {
  const b = req.body || {};
  const err = validPostInput(b, { requireMedia: false });
  if (err) return res.status(400).json({ ok: false, error: err });
  const allowed = ['mediaUrl', 'mediaType', 'caption', 'hashtags', 'cta', 'platform', 'scheduleTime', 'status', 'format', 'liveUrl'];
  const patch = {};
  for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k];
  const updated = await db.updatePost(req.userId, req.params.id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: 'That post no longer exists — it may have been deleted. Refresh the queue.' });
  res.json({ ok: true, post: updated });
}));
app.delete('/api/posts/:id', ah(async (req, res) => {
  const ok = await db.deletePost(req.userId, req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'That post no longer exists.' });
  res.json({ ok: true });
}));
// Duplicate a post: a fresh copy, saved as a draft, "(copy)" in the caption.
// The copy must not carry the original's Instagram identity or publish
// container, or it would confuse imports and re-publishes.
app.post('/api/posts/:id/duplicate', ah(async (req, res) => {
  const orig = await db.getPost(req.userId, req.params.id);
  if (!orig) return res.status(404).json({ ok: false, error: 'That post no longer exists — it may have been deleted.' });
  const copy = {
    ...orig,
    id: uid('post'),
    userId: req.userId,
    caption: `${orig.caption || ''} (copy)`.trim(),
    status: 'draft',
    liveUrl: '',
    instagramId: undefined,
    containerId: undefined,
    createdAt: new Date().toISOString(),
  };
  delete copy.instagramId;
  delete copy.containerId;
  await db.savePost(copy);
  res.json({ ok: true, post: copy });
}));
// Reschedule: { scheduleTime } or { addDays } (e.g. +1 day).
app.post('/api/posts/:id/reschedule', ah(async (req, res) => {
  const post = await db.getPost(req.userId, req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: 'That post no longer exists — it may have been deleted.' });
  let next;
  if (req.body && req.body.scheduleTime) {
    next = new Date(req.body.scheduleTime);
  } else if (req.body && Number.isFinite(Number(req.body.addDays))) {
    const base = post.scheduleTime ? new Date(post.scheduleTime) : new Date();
    next = new Date(base.getTime() + Number(req.body.addDays) * 86400000);
  } else {
    return res.status(400).json({ ok: false, error: 'Give a new date/time, or a number of days to move it by.' });
  }
  if (Number.isNaN(next.getTime())) return res.status(400).json({ ok: false, error: 'That date/time is not valid — pick a date and time from the calendar picker.' });
  const patch = { scheduleTime: next.toISOString() };
  // A published/failed post moved to a new time goes back to the queue.
  if (post.status === 'published' || post.status === 'failed') patch.status = 'scheduled';
  const updated = await db.updatePost(req.userId, req.params.id, patch);
  res.json({ ok: true, post: updated });
}));
// Next free 7:00 PM slot, computed from the user's own saved posts only:
// the first day in the next 14 days with no scheduled/draft post at 7pm
// (server local time; the Studio UI recomputes the same in browser time).
app.get('/api/next-best-time', ah(async (req, res) => {
  const posts = await getPosts(req);
  const taken = new Set();
  for (const p of posts) {
    if (!p.scheduleTime || (p.status !== 'scheduled' && p.status !== 'draft')) continue;
    const d = new Date(p.scheduleTime);
    if (Number.isNaN(d.getTime())) continue;
    taken.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`);
  }
  const now = new Date();
  for (let day = 0; day < 14; day++) {
    const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, 19, 0, 0, 0);
    if (cand.getTime() <= now.getTime()) continue;
    const key = `${cand.getFullYear()}-${cand.getMonth()}-${cand.getDate()}-19`;
    if (!taken.has(key)) {
      return res.json({ ok: true, suggestedTime: cand.toISOString(), reason: 'Next free 7:00 PM slot in your own schedule — no post is scheduled then.' });
    }
  }
  return res.json({ ok: true, suggestedTime: null, reason: 'No free 7:00 PM slot in the next 14 days.' });
}));

// ---------- Instagram publish (Graph API) ----------
// media_type "REELS" (NOT "REEL"), container -> FINISHED -> media_publish.
// Vercel Hobby functions stop at 60s, so polling is capped at ~45s and the
// container id is saved on the post: if publishing is still processing,
// pressing Publish again resumes the same container instead of making a
// duplicate. FEED videos use media_type VIDEO and Stories use STORIES —
// sending a video as an image container was a publish failure.
async function graph(path, method, body) {
  const url = `https://graph.facebook.com/v27.0${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return res.json().catch(() => null);
}
function publishContainerBody(post, token) {
  const isReel = (post.format || 'REELS') === 'REELS';
  const isStory = post.format === 'STORY';
  const isVideo = post.mediaType !== 'image';
  const caption = [post.caption, post.hashtags ? post.hashtags.split(/[\s,]+/).filter(Boolean).map((h) => (h.startsWith('#') ? h : '#' + h)).join(' ') : ''].filter(Boolean).join('\n');
  if (isReel) return { media_type: 'REELS', video_url: post.mediaUrl, caption, access_token: token };
  if (isStory) return isVideo
    ? { media_type: 'STORIES', video_url: post.mediaUrl, caption, access_token: token }
    : { media_type: 'STORIES', image_url: post.mediaUrl, caption, access_token: token };
  return isVideo
    ? { media_type: 'VIDEO', video_url: post.mediaUrl, caption, access_token: token }
    : { image_url: post.mediaUrl, caption, access_token: token };
}
async function markFailed(userId, postId, error) {
  const short = String(error || 'Publish failed.').slice(0, 200);
  await db.updatePost(userId, postId, {
    status: 'failed', containerId: null,
    lastPublishError: short, failedAt: new Date().toISOString(),
  });
  return short;
}
// Publish one post via the Graph API. Reusable by the manual Publish
// button, by /api/publish-due and by the cron endpoint — the logic lives
// here once. Returns { ok, liveUrl, mediaId } on success,
// { ok:false, retry:true, containerId, error } when Instagram is still
// processing (press Publish again to resume the same container), or
// { ok:false, error } on a hard failure (post is marked failed).
async function attemptPublish(userId, post, ig) {
  const token = ig.token;
  const igId = ig.igUserId;
  let containerId = post.containerId || null;
  try {
    await db.updatePost(userId, post.id, { publishAttempts: (post.publishAttempts || 0) + 1 });
    if (containerId) {
      // Resume a container from an earlier attempt instead of duplicating it.
      const s = await graph('/' + containerId + '?fields=status_code&access_token=' + encodeURIComponent(token), 'GET');
      if (s && s.error) containerId = null; // container gone — make a fresh one
      else if (s && s.status_code === 'ERROR') containerId = null;
      else if (s && s.status_code === 'FINISHED') { /* fall through to publish */ }
      else if (s) {
        return { ok: false, retry: true, containerId, error: 'Instagram is still processing this video — wait a minute, then press Publish again. Nothing was published yet and nothing was duplicated.' };
      }
    }
    if (!containerId) {
      const created = await graph(`/${igId}/media`, 'POST', publishContainerBody(post, token));
      if (!created || created.error) {
        const err = friendlyGraphError(created, 'Instagram could not create this post. Check the media link is a public video/image and try again.');
        await markFailed(userId, post.id, err);
        return { ok: false, error: err };
      }
      containerId = created.id;
      await db.updatePost(userId, post.id, { containerId });
    }
    // Poll container status until FINISHED (max ~45s elapsed: Vercel stops
    // at 60s, so the loop is capped by wall-clock, not just iterations).
    let status = '';
    const pollStarted = Date.now();
    for (let i = 0; i < 9 && Date.now() - pollStarted < 45000; i++) {
      const s = await graph('/' + containerId + '?fields=status_code&access_token=' + encodeURIComponent(token), 'GET');
      status = (s && s.status_code) || '';
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || (s && s.error)) {
        const err = 'Instagram could not process this media — the file may be in a format Instagram does not accept. Try a standard MP4 (H.264) or JPG and publish again.';
        await markFailed(userId, post.id, err);
        return { ok: false, error: err };
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (status !== 'FINISHED') {
      return { ok: false, retry: true, containerId, error: 'Instagram is still processing this video — wait a minute, then press Publish again. Nothing was published yet and nothing was duplicated.' };
    }
    const published = await graph(`/${igId}/media_publish`, 'POST', { creation_id: containerId, access_token: token });
    if (!published || published.error) {
      const err = friendlyGraphError(published, 'Instagram could not publish this post.');
      await markFailed(userId, post.id, err);
      return { ok: false, error: err };
    }
    const media = await graph('/' + published.id + '?fields=permalink,media_type&access_token=' + encodeURIComponent(token), 'GET');
    await db.updatePost(userId, post.id, { status: 'published', liveUrl: (media && media.permalink) || '', containerId: null, lastPublishError: '' });
    // The library item this came from has now been used once.
    try {
      const library = await db.listMedia(userId, { all: true });
      const item = library.find((m) => m.url && post.mediaUrl && m.url === post.mediaUrl);
      if (item) await db.updateMedia(userId, item.id, { usedCount: (item.usedCount || 0) + 1 });
    } catch { /* usedCount is a nicety, never fail a publish over it */ }
    return { ok: true, liveUrl: (media && media.permalink) || '', mediaId: published.id };
  } catch (e) {
    // A failed publish attempt — including a network failure reaching
    // Instagram — marks the post failed so it is visible in the Queue as
    // needing attention, instead of silently staying "scheduled".
    try { await markFailed(userId, post.id, 'Could not reach Instagram — check your connection and try publishing again in a minute.'); } catch { /* post may have been deleted; the error below still stands */ }
    return { ok: false, error: 'Could not reach Instagram — check your connection and try publishing again in a minute.' };
  }
}
app.post('/api/posts/:id/publish', ah(async (req, res) => {
  const ig = await getInstagramCreds(req);
  if (!ig.token || !ig.igUserId) {
    return res.status(400).json({ ok: false, error: 'Instagram is not connected — add your access token in Settings (or set INSTAGRAM_ACCESS_TOKEN and IG_USER_ID on the server) to publish from here.' });
  }
  const post = await db.getPost(req.userId, req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: 'That post no longer exists — it may have been deleted.' });
  if (typeof post.mediaUrl === 'string' && post.mediaUrl.startsWith('data:')) {
    return res.status(400).json({ ok: false, error: 'This post’s media was uploaded as a file stored in the app, and Instagram can only publish from a public web link. Add the same video by public link (Media Library → Add by link), then publish that post.' });
  }
  const result = await attemptPublish(req.userId, post, ig);
  if (result.ok) return res.json({ ok: true, liveUrl: result.liveUrl, mediaId: result.mediaId });
  if (result.retry) return res.json({ ok: false, retry: true, containerId: result.containerId, error: result.error });
  return res.status(502).json({ ok: false, error: result.error });
}));
// Posts that are due for one user: scheduled posts whose time has passed
// (and that have a public link), plus failed posts that have been tried
// fewer than twice (one automatic retry for transient Graph errors).
async function duePostsFor(userId, max) {
  const now = Date.now();
  const posts = await db.listPosts(userId, { all: true });
  const due = posts
    .filter((p) => p.mediaUrl && !String(p.mediaUrl).startsWith('data:') && p.scheduleTime && new Date(p.scheduleTime).getTime() <= now)
    .filter((p) => p.status === 'scheduled' || (p.status === 'failed' && (p.publishAttempts || 0) < 2))
    .sort((a, b) => new Date(a.scheduleTime) - new Date(b.scheduleTime));
  return due.slice(0, max);
}
// Publish everything that is due for the signed-in user, right now.
// This is what the Dashboard/Queue "Publish due" button calls, and what a
// cron job should call on a schedule (see /api/cron/publish-due).
app.post('/api/publish-due', ah(async (req, res) => {
  const ig = await getInstagramCreds(req);
  if (!ig.token || !ig.igUserId) {
    return res.status(400).json({ ok: false, error: 'Instagram is not connected — add your access token in Settings to publish from here.' });
  }
  const due = await duePostsFor(req.userId, 5);
  const published = [];
  const failed = [];
  const retrying = [];
  for (const post of due) {
    const result = await attemptPublish(req.userId, post, ig);
    if (result.ok) published.push({ id: post.id, liveUrl: result.liveUrl });
    else if (result.retry) retrying.push({ id: post.id, error: result.error });
    else failed.push({ id: post.id, error: result.error });
  }
  res.json({ ok: true, due: due.length, published, failed, retrying });
}));
// Cron endpoint: publishes due posts for EVERY user. Guarded by a bearer
// token (CRON_SECRET env var) instead of a login cookie, so Vercel Cron
// (or any cron) can call it: POST /api/cron/publish-due with header
// "Authorization: Bearer <CRON_SECRET>". Without CRON_SECRET set, the
// endpoint refuses to run. Max 3 posts per user per run, so a bad token or
// a stuck queue can never publish a flood.
app.post('/api/cron/publish-due', ah(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: 'Auto-publish is not configured — set CRON_SECRET in the server environment variables.' });
  const auth = req.get('authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(given, 'utf8'); const b = Buffer.from(secret, 'utf8');
  if (!given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'Not authorised.' });
  }
  const users = await db.listUsers();
  const summary = [];
  for (const user of users) {
    const ig = await getInstagramCreds(user.id);
    if (!ig.token || !ig.igUserId) { summary.push({ userId: user.id, skipped: 'instagram-not-connected' }); continue; }
    const due = await duePostsFor(user.id, 3);
    let published = 0; let failed = 0;
    for (const post of due) {
      const result = await attemptPublish(user.id, post, ig);
      if (result.ok) published++;
      else if (!result.retry) failed++;
    }
    summary.push({ userId: user.id, due: due.length, published, failed });
  }
  res.json({ ok: true, ranAt: new Date().toISOString(), summary });
}));

// ---------- media library ----------
app.get('/api/media', ah(async (req, res) => res.json({ ok: true, media: await db.listMedia(req.userId, { limit: req.query.limit, offset: req.query.offset }) })));
app.post('/api/media', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.url) return res.status(400).json({ ok: false, error: 'Paste a media link first.' });
  if (typeof b.url !== 'string' || (b.title !== undefined && typeof b.title !== 'string') || (b.folder !== undefined && typeof b.folder !== 'string')) return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string'))) return res.status(400).json({ ok: false, error: 'Tags must be plain text — please try again.' });
  if (!/^https?:\/\//i.test(b.url)) return res.status(400).json({ ok: false, error: 'That media link is not valid — paste a full https:// link to a video or image.' });
  const item = {
    id: uid('media'), userId: req.userId, url: b.url, title: b.title || 'Untitled',
    kind: b.kind || (/\.(mp4|mov|webm)$/i.test(b.url) ? 'video' : 'image'),
    size: b.size || 0, duration: Number.isFinite(Number(b.duration)) ? Number(b.duration) : 0,
    width: Number.isFinite(Number(b.width)) ? Number(b.width) : 0,
    height: Number.isFinite(Number(b.height)) ? Number(b.height) : 0,
    folder: b.folder || 'General', tags: Array.isArray(b.tags) ? b.tags : [], favorite: false, usedCount: 0,
    createdAt: new Date().toISOString(),
  };
  await db.saveMedia(item);
  res.json({ ok: true, media: item });
}));
// Upload: the frontend sends base64 in JSON (no multipart parser).
// POST /api/media/upload { name, dataUrl, folder, tags }.
// Limits: Vercel serverless requests cap at ~4.5 MB, and one MongoDB
// document caps at 16 MB — so on the live site a file upload must stay
// small. Anything bigger: add it by public link instead.
app.post('/api/media/upload', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.dataUrl || !b.name) return res.status(400).json({ ok: false, error: 'Choose a file to upload first.' });
  if (!/^data:(image|video)\//i.test(b.dataUrl)) return res.status(400).json({ ok: false, error: 'That file does not look like an image or video — choose an MP4, MOV, JPG, PNG or WebP file.' });
  const decodedBytes = Math.round((b.dataUrl.length * 3) / 4);
  const mongoMode = db.isMongo();
  const maxBytes = mongoMode ? 9 * 1024 * 1024 : 60 * 1024 * 1024;
  if (decodedBytes > maxBytes) {
    return res.status(413).json({ ok: false, error: mongoMode
      ? 'That file is too big to store in the database (about 9 MB max). Add it by public link instead (Media Library → Add by link), or use a smaller file.'
      : 'That file is over the 60 MB limit — use a smaller file, or add it by link.' });
  }
  const item = {
    id: uid('media'), userId: req.userId, url: b.dataUrl, title: b.name,
    kind: /\.(mp4|mov|webm)$/i.test(b.name) ? 'video' : 'image',
    size: decodedBytes, duration: Number.isFinite(Number(b.duration)) ? Number(b.duration) : 0,
    width: Number.isFinite(Number(b.width)) ? Number(b.width) : 0,
    height: Number.isFinite(Number(b.height)) ? Number(b.height) : 0,
    folder: b.folder || 'Uploads', tags: Array.isArray(b.tags) ? b.tags : [], favorite: false, usedCount: 0,
    createdAt: new Date().toISOString(),
  };
  await db.saveMedia(item);
  res.json({ ok: true, media: item });
}));
app.patch('/api/media/:id', ah(async (req, res) => {
  const allowed = ['title', 'folder', 'tags', 'favorite', 'usedCount'];
  const patch = {};
  for (const k of allowed) if (req.body && req.body[k] !== undefined) patch[k] = req.body[k];
  if ((patch.title !== undefined && typeof patch.title !== 'string') || (patch.folder !== undefined && typeof patch.folder !== 'string')) return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.some((t) => typeof t !== 'string'))) return res.status(400).json({ ok: false, error: 'Tags must be plain text — please try again.' });
  if (patch.favorite !== undefined && typeof patch.favorite !== 'boolean') return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  if (patch.usedCount !== undefined && typeof patch.usedCount !== 'number') return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  const updated = await db.updateMedia(req.userId, req.params.id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: 'That media file no longer exists — it may have been deleted.' });
  res.json({ ok: true, media: updated });
}));
app.delete('/api/media/:id', ah(async (req, res) => {
  const ok = await db.deleteMedia(req.userId, req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'That media file no longer exists.' });
  res.json({ ok: true });
}));

// ---------- templates ----------
const SEED_TEMPLATES = [
  { id: 'tpl-1', name: 'New post', text: 'Something new is here! Follow for more updates. #newpost' },
  { id: 'tpl-2', name: 'Behind the scenes', text: 'A little behind the scenes from today. What do you want to see next?' },
  { id: 'tpl-3', name: 'Question post', text: 'Quick question for you all — drop your answer in the comments!' },
];
app.get('/api/templates', ah(async (req, res) => {
  const t = await getTemplates(req);
  res.json({ ok: true, templates: t.length ? t : SEED_TEMPLATES });
}));
app.post('/api/templates', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.text) return res.status(400).json({ ok: false, error: 'Give the template a name and some text first.' });
  if (typeof b.name !== 'string' || typeof b.text !== 'string') return res.status(400).json({ ok: false, error: 'That template is not valid — please try again.' });
  const t = { id: uid('tpl'), userId: req.userId, name: b.name, text: b.text };
  await db.saveTemplate(t);
  res.json({ ok: true, template: t });
}));

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.json({ ok: true, service: 'social-scheduler', note: 'Frontend not built yet — run npm run build in frontend/.' });
});

// Plain-words errors: a too-big upload says so, bad JSON says so, and
// nothing ever leaks a credential or connection string.
app.use((err, req, res, next) => {
  console.error(err && err.message ? err.message : err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'That upload is too big for the live site (about 4 MB max per request). Add the file by public link instead (Media Library → Add by link), or use a smaller file.' });
  }
  if (err instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: 'That request was not valid — please try again.' });
  }
  res.status(500).json({ ok: false, error: 'Something went wrong on the server — please try again in a minute.' });
});

if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`Social Scheduler listening on ${PORT}`));
  const shutdown = () => {
    console.log('Shutting down…');
    server.close(() => {
      try { const mongoose = require('mongoose'); mongoose.disconnect().finally(() => process.exit(0)); } catch { process.exit(0); }
    });
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
module.exports = app;
