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

app.use(express.json({ limit: '100mb' })); // base64 media uploads (local dev)
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

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

// Serve the Vite build when present.
const DIST = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST));
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
app.use('/api', ah(async (req, res, next) => {
  if (req.path === '/health' || req.path === '/db-status' || req.path.startsWith('/auth/')) return next();
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

// ---------- per-user data helpers ----------
async function getPosts(req) { return db.listPosts(req.userId); }
async function getMedia(req) { return db.listMedia(req.userId); }
function getTemplates(req) { return db.listTemplates(req.userId); }
async function getSettings(req) {
  const s = await db.getSettings(req.userId);
  return { instagramHandle: s.instagramHandle || '', ...s };
}
// Instagram credentials: a token pasted in Settings is stored server-side
// (encrypted in MongoDB) and takes priority; env vars are the fallback.
// The full token is never sent to the frontend — only a masked form.
async function getInstagramStored(req) {
  const s = await db.getInstagram(req.userId);
  return s && typeof s === 'object' ? s : {};
}
async function getInstagramCreds(req) {
  const stored = await getInstagramStored(req);
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

// ---------- settings ----------
app.get('/api/settings', ah(async (req, res) => {
  const s = await getSettings(req);
  const ig = await getInstagramCreds(req);
  const stored = await getInstagramStored(req);
  res.json({
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
    setupDone: s.setupDone === true,
  });
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
  res.json({ ok: true, instagramHandle: s.instagramHandle || ig.username || '', instagramConnected: !!(ig.token && ig.igUserId), tokenConfigured: !!(ig.token && ig.igUserId), instagramUsername: ig.username || '', maskedToken: maskToken(ig.token), tokenSource: ig.source, igUserIdSet: !!ig.igUserId, tokenEncrypted: stored.token ? !!stored.encrypted : null, instagramProfile: stored.profile || null, setupDone: s.setupDone === true });
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
    while (nextUrl && pages < 10) {
      pages++;
      const page = await graphGet(nextUrl);
      if (!page || page.error) throw new Error(friendlyGraphError(page, 'Instagram stopped the import. The token may lack permission.'));
      const items = Array.isArray(page.data) ? page.data : [];
      job.fetched += items.length;
      const media = await db.listMedia(job.userId);
      const posts = await db.listPosts(job.userId);
      const newMedia = [];
      const newPosts = [];
      for (const item of items) {
        const mediaUrl = item.media_url || item.thumbnail_url || '';
        const isVideo = item.media_type === 'VIDEO';
        const kind = isVideo ? 'video' : 'image';
        const alreadyMedia = media.some((m) => m.instagramId === item.id || (mediaUrl && m.url === mediaUrl)) || newMedia.some((m) => m.instagramId === item.id);
        if (!alreadyMedia && mediaUrl) {
          newMedia.push({
            id: uid('media'), userId: job.userId, url: mediaUrl, title: (item.caption || '').slice(0, 80) || `${item.media_type || 'Post'} ${item.id}`,
            kind, size: 0, duration: 0, folder: 'Instagram import',
            tags: [], favorite: false, usedCount: 0,
            instagramId: item.id, permalink: item.permalink || '', createdAt: item.timestamp || new Date().toISOString(),
          });
          job.importedMedia++;
        }
        const alreadyPost = posts.some((p) => p.instagramId === item.id || (item.permalink && p.liveUrl === item.permalink)) || newPosts.some((p) => p.instagramId === item.id);
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
app.get('/api/posts', ah(async (req, res) => res.json({ ok: true, posts: await getPosts(req) })));
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
  const token = ig.token;
  const igId = ig.igUserId;
  let containerId = post.containerId || null;
  try {
    if (containerId) {
      // Resume a container from an earlier attempt instead of duplicating it.
      const s = await graph('/' + containerId + '?fields=status_code&access_token=' + encodeURIComponent(token), 'GET');
      if (s && s.error) containerId = null; // container gone — make a fresh one
      else if (s && s.status_code === 'ERROR') containerId = null;
      else if (s && s.status_code === 'FINISHED') { /* fall through to publish */ }
      else if (s) {
        return res.json({ ok: false, retry: true, containerId, error: 'Instagram is still processing this video — wait a minute, then press Publish again. Nothing was published yet and nothing was duplicated.' });
      }
    }
    if (!containerId) {
      const created = await graph(`/${igId}/media`, 'POST', publishContainerBody(post, token));
      if (!created || created.error) {
        await db.updatePost(req.userId, post.id, { status: 'failed' });
        return res.status(502).json({ ok: false, error: friendlyGraphError(created, 'Instagram could not create this post. Check the media link is a public video/image and try again.') });
      }
      containerId = created.id;
      await db.updatePost(req.userId, post.id, { containerId });
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
        await db.updatePost(req.userId, post.id, { status: 'failed', containerId: null });
        return res.status(502).json({ ok: false, error: 'Instagram could not process this media — the file may be in a format Instagram does not accept. Try a standard MP4 (H.264) or JPG and publish again.' });
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (status !== 'FINISHED') {
      return res.json({ ok: false, retry: true, containerId, error: 'Instagram is still processing this video — wait a minute, then press Publish again. Nothing was published yet and nothing was duplicated.' });
    }
    const published = await graph(`/${igId}/media_publish`, 'POST', { creation_id: containerId, access_token: token });
    if (!published || published.error) {
      await db.updatePost(req.userId, post.id, { status: 'failed', containerId: null });
      return res.status(502).json({ ok: false, error: friendlyGraphError(published, 'Instagram could not publish this post.') });
    }
    const media = await graph('/' + published.id + '?fields=permalink,media_type&access_token=' + encodeURIComponent(token), 'GET');
    await db.updatePost(req.userId, post.id, { status: 'published', liveUrl: (media && media.permalink) || '', containerId: null });
    res.json({ ok: true, liveUrl: (media && media.permalink) || '', mediaId: published.id });
  } catch (e) {
    // A failed publish attempt — including a network failure reaching
    // Instagram — marks the post failed so it is visible in the Queue as
    // needing attention, instead of silently staying "scheduled".
    try { await db.updatePost(req.userId, post.id, { status: 'failed' }); } catch { /* post may have been deleted; the error below still stands */ }
    return res.status(502).json({ ok: false, error: 'Could not reach Instagram — check your connection and try publishing again in a minute.' });
  }
}));

// ---------- media library ----------
app.get('/api/media', ah(async (req, res) => res.json({ ok: true, media: await getMedia(req) })));
app.post('/api/media', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.url) return res.status(400).json({ ok: false, error: 'Paste a media link first.' });
  if (typeof b.url !== 'string' || (b.title !== undefined && typeof b.title !== 'string') || (b.folder !== undefined && typeof b.folder !== 'string')) return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string'))) return res.status(400).json({ ok: false, error: 'Tags must be plain text — please try again.' });
  if (!/^https?:\/\//i.test(b.url)) return res.status(400).json({ ok: false, error: 'That media link is not valid — paste a full https:// link to a video or image.' });
  const item = {
    id: uid('media'), userId: req.userId, url: b.url, title: b.title || 'Untitled',
    kind: b.kind || (/\.(mp4|mov|webm)$/i.test(b.url) ? 'video' : 'image'),
    size: b.size || 0, duration: b.duration || 0,
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
    size: decodedBytes, duration: 0,
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

if (require.main === module) app.listen(PORT, () => console.log(`Social Scheduler listening on ${PORT}`));
module.exports = app;
