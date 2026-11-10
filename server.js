// Social Scheduler by Goyal Kumar
// Express backend + JSON-file storage (Vercel serverless safe: reads/writes
// data/*.json when writable, otherwise falls back to in-memory state).
// Login: email + password accounts (first user is the owner), scrypt hashes
// in data/users.json, HMAC-signed httpOnly session cookie (SESSION_SECRET).
// Instagram token: paste it in Settings (verified live, stored server-side
// in data/instagram.json) or set INSTAGRAM_ACCESS_TOKEN / IG_USER_ID env vars.
// Never commit a token or a password hash.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
try { fs.mkdirSync(DATA, { recursive: true }); } catch { /* read-only fs */ }

// Sessions are HMAC-signed cookies (no server-side session store, so this
// works on Vercel serverless too). SESSION_SECRET signs them: set it in env
// (Vercel -> Settings -> Environment Variables) so sessions survive redeploys.
// Without SESSION_SECRET a random per-process secret is generated and all
// sessions reset whenever the server restarts / redeploys.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'ss_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

app.use(express.json({ limit: '100mb' })); // base64 media uploads (up to 60 MB files)
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Serve the Vite build when present.
const DIST = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST));
}

// ---------- storage (JSON files, in-memory fallback) ----------
const memory = { posts: [], media: [], templates: [], settings: {} };
function load(name, fallback) {
  try {
    const f = path.join(DATA, name + '.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { /* fall through */ }
  return memory[name] !== undefined ? memory[name] : fallback;
}
function save(name, data) {
  memory[name] = data;
  try { fs.writeFileSync(path.join(DATA, name + '.json'), JSON.stringify(data, null, 2)); } catch { /* Vercel fs is read-only; memory holds it for this container */ }
}
function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'); }
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- auth (email + password, scrypt hashes, signed cookie) ----------
function getUsers() { return load('users', []); }
function saveUsers(users) { save('users', users); }
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, role: u.role || 'member', createdAt: u.createdAt };
}
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
function signSession(userId) {
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(payload, 'utf8').toString('base64url') + '.' + sig;
}
function verifySession(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    const a = Buffer.from(sig, 'utf8'); const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const [userId, exp] = payload.split('.');
    if (!userId || !exp || Number(exp) < Date.now()) return null;
    return userId;
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
function getAuthUser(req) {
  const userId = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!userId) return null;
  return getUsers().find((u) => u.id === userId) || null;
}
function isSecureRequest(req) {
  return process.env.NODE_ENV === 'production' || req.secure || req.get('x-forwarded-proto') === 'https';
}
function setSessionCookie(req, res, userId) {
  res.cookie(SESSION_COOKIE, signSession(userId), {
    httpOnly: true, sameSite: 'lax', secure: isSecureRequest(req),
    path: '/', maxAge: SESSION_MAX_AGE_MS,
  });
}
function clearSessionCookie(req, res) {
  res.cookie(SESSION_COOKIE, '', {
    httpOnly: true, sameSite: 'lax', secure: isSecureRequest(req),
    path: '/', maxAge: 0,
  });
}
function requireAuth(req, res, next) {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Please log in first.' });
  req.user = publicUser(user);
  return next();
}
// Every /api/* route except /api/health and /api/auth/* requires login.
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/')) return next();
  return requireAuth(req, res, next);
});

function validEmail(email) { return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()); }

app.post('/api/auth/signup', ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  const users = getUsers();
  if (users.some((u) => u.email === email)) return res.status(409).json({ ok: false, error: 'An account with this email already exists — log in instead.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: uid('user'), email, salt,
    passwordHash: hashPassword(password, salt),
    role: users.length === 0 ? 'owner' : 'member',
    createdAt: new Date().toISOString(),
  };
  users.push(user); saveUsers(users);
  setSessionCookie(req, res, user.id);
  res.json({ ok: true, user: publicUser(user) });
}));
app.post('/api/auth/login', ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = getUsers().find((u) => u.email === email);
  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
  }
  setSessionCookie(req, res, user.id);
  res.json({ ok: true, user: publicUser(user) });
}));
app.get('/api/auth/me', (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Not logged in.' });
  res.json({ ok: true, user: publicUser(user) });
});
app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

function getPosts() { return load('posts', []); }
function getMedia() { return load('media', []); }
function getTemplates() {
  const t = load('templates', null);
  if (t && t.length) return t;
  return [
    { id: 'tpl-1', name: 'New post', text: 'Something new is here! Follow for more updates. #newpost' },
    { id: 'tpl-2', name: 'Behind the scenes', text: 'A little behind the scenes from today. What do you want to see next?' },
    { id: 'tpl-3', name: 'Question post', text: 'Quick question for you all — drop your answer in the comments!' },
  ];
}
function getSettings() {
  const s = load('settings', {});
  return { instagramHandle: s.instagramHandle || '', ...s };
}
// Instagram credentials: a token pasted in Settings is stored server-side
// only (data/instagram.json, git-ignored via data/*.json); env vars remain
// as a fallback when no stored token exists. The full token is never sent
// to the frontend — only a masked form (first 4 / last 4 chars).
function getInstagramStored() {
  const s = load('instagram', null);
  return s && typeof s === 'object' ? s : {};
}
function getInstagramCreds() {
  const stored = getInstagramStored();
  const token = stored.token || process.env.INSTAGRAM_ACCESS_TOKEN || '';
  const igUserId = stored.igUserId || process.env.IG_USER_ID || '';
  return { token, igUserId, username: stored.username || '', source: stored.token ? 'stored' : (process.env.INSTAGRAM_ACCESS_TOKEN ? 'env' : 'none') };
}
function maskToken(t) {
  if (!t) return '';
  if (t.length <= 8) return '••••••••';
  return t.slice(0, 4) + '…' + t.slice(-4);
}
function igConfigured() { const c = getInstagramCreds(); return !!(c.token && c.igUserId); }

// ---------- health / stats ----------
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'social-scheduler', instagramConfigured: igConfigured() }));
app.get('/health', (req, res) => res.json({ ok: true, service: 'social-scheduler' }));
app.get('/api/stats', (req, res) => {
  const posts = getPosts(); const media = getMedia();
  res.json({
    ok: true,
    scheduled: posts.filter((p) => p.status === 'scheduled').length,
    published: posts.filter((p) => p.status === 'published').length,
    failed: posts.filter((p) => p.status === 'failed').length,
    drafts: posts.filter((p) => p.status === 'draft').length,
    mediaCount: media.length,
    total: posts.length,
  });
});

// ---------- settings ----------
app.get('/api/settings', (req, res) => {
  const s = getSettings();
  const ig = getInstagramCreds();
  res.json({
    ok: true,
    instagramHandle: s.instagramHandle || ig.username || '',
    instagramConnected: igConfigured(),
    tokenConfigured: igConfigured(),
    instagramUsername: ig.username || '',
    maskedToken: maskToken(ig.token),
    tokenSource: ig.source,
    igUserIdSet: !!ig.igUserId,
    instagramProfile: getInstagramStored().profile || null,
    setupDone: s.setupDone === true,
  });
});
app.post('/api/settings', ah(async (req, res) => {
  const s = { ...getSettings(), ...(req.body || {}) };
  // Tokens and the connected flag are never set from this form — the
  // connection state comes only from /api/instagram/connect (verified
  // against the Graph API) or the env fallback.
  delete s.token; delete s.accessToken; delete s.instagramConnected; delete s.tokenConfigured;
  delete s.maskedToken; delete s.tokenSource; delete s.instagramUsername;
  save('settings', s);
  const ig = getInstagramCreds();
  res.json({ ok: true, instagramHandle: s.instagramHandle || ig.username || '', instagramConnected: igConfigured(), tokenConfigured: igConfigured(), instagramUsername: ig.username || '', maskedToken: maskToken(ig.token), tokenSource: ig.source, igUserIdSet: !!ig.igUserId, instagramProfile: getInstagramStored().profile || null, setupDone: s.setupDone === true });
}));

// ---------- Instagram connect (paste token, verified live) ----------
app.post('/api/instagram/connect', ah(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  let igUserId = String(req.body?.igUserId || '').trim();
  if (!token) return res.status(400).json({ ok: false, error: 'Paste your Instagram access token first.' });
  if (!igUserId) igUserId = process.env.IG_USER_ID || '';
  if (!igUserId) return res.status(400).json({ ok: false, error: 'Instagram User ID is required — paste it below, or set IG_USER_ID on the server.' });
  // Verify the token live against the Graph API before storing anything.
  let data;
  try {
    const url = `https://graph.facebook.com/v27.0/${encodeURIComponent(igUserId)}?fields=username&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    data = await r.json().catch(() => null);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'Could not reach Instagram to verify the token — check your connection and try again.' });
  }
  if (!data || data.error) {
    return res.status(400).json({ ok: false, error: (data && data.error && data.error.message) || 'Instagram rejected this token. Generate a fresh token in the Meta app dashboard and try again.' });
  }
  if (!data.id) return res.status(400).json({ ok: false, error: 'Instagram did not recognise this token for that User ID.' });
  save('instagram', { token, igUserId, username: data.username || '', connectedAt: new Date().toISOString() });
  res.json({ ok: true, username: data.username || '', igUserId, maskedToken: maskToken(token), instagramConnected: true, tokenSource: 'stored' });
}));
app.post('/api/instagram/disconnect', ah(async (req, res) => {
  save('instagram', {});
  const ig = getInstagramCreds();
  res.json({ ok: true, instagramConnected: igConfigured(), tokenSource: ig.source, maskedToken: maskToken(ig.token), instagramUsername: ig.username || '' });
}));

// ---------- Instagram import (profile + existing media) ----------
// Runs as a background job so the UI can poll progress. Fetches the profile
// (username, picture, bio, media count) and pages through the account's
// media, saving media into the library and each item into the queue as a
// published post with its original caption and permalink. Followers and DMs
// are NOT imported — Meta does not allow it.
const importJobs = {};
async function graphGet(url) {
  const r = await fetch(url);
  const data = await r.json().catch(() => null);
  return data;
}
async function runInstagramImport(job) {
  try {
    const ig = getInstagramCreds();
    if (!ig.token || !ig.igUserId) throw new Error('Instagram is not connected — connect it first.');
    const base = 'https://graph.facebook.com/v27.0';
    const profile = await graphGet(`${base}/${encodeURIComponent(ig.igUserId)}?fields=username,profile_picture_url,biography,media_count&access_token=${encodeURIComponent(ig.token)}`);
    if (!profile || profile.error) throw new Error((profile && profile.error && profile.error.message) || 'Instagram rejected the request. The token may lack permission — generate a fresh token with instagram_business_basic and try again.');
    job.profile = {
      username: profile.username || '',
      profilePictureUrl: profile.profile_picture_url || '',
      biography: profile.biography || '',
      mediaCount: profile.media_count || 0,
    };
    const stored = getInstagramStored();
    save('instagram', { ...stored, username: profile.username || stored.username || '', profile: job.profile, importedAt: new Date().toISOString() });
    const settings = getSettings();
    if (profile.username && !settings.instagramHandle) { settings.instagramHandle = profile.username; save('settings', settings); }

    let nextUrl = `${base}/${encodeURIComponent(ig.igUserId)}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,permalink&limit=50&access_token=${encodeURIComponent(ig.token)}`;
    let pages = 0;
    while (nextUrl && pages < 10) {
      pages++;
      const page = await graphGet(nextUrl);
      if (!page || page.error) throw new Error((page && page.error && page.error.message) || 'Instagram stopped the import. The token may lack permission.');
      const items = Array.isArray(page.data) ? page.data : [];
      job.fetched += items.length;
      const media = getMedia();
      const posts = getPosts();
      for (const item of items) {
        const mediaUrl = item.media_url || item.thumbnail_url || '';
        const isVideo = item.media_type === 'VIDEO';
        const kind = isVideo ? 'video' : 'image';
        const alreadyMedia = media.some((m) => m.instagramId === item.id || (mediaUrl && m.url === mediaUrl));
        if (!alreadyMedia && mediaUrl) {
          media.push({
            id: uid('media'), url: mediaUrl, title: (item.caption || '').slice(0, 80) || `${item.media_type || 'Post'} ${item.id}`,
            kind, size: 0, duration: 0, folder: 'Instagram import',
            tags: [], favorite: false, usedCount: 0,
            instagramId: item.id, permalink: item.permalink || '', createdAt: item.timestamp || new Date().toISOString(),
          });
          job.importedMedia++;
        }
        const alreadyPost = posts.some((p) => p.instagramId === item.id || (item.permalink && p.liveUrl === item.permalink));
        if (!alreadyPost) {
          posts.push({
            id: uid('post'),
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
      save('media', media);
      save('posts', posts);
      nextUrl = page.paging && page.paging.next ? page.paging.next : null;
    }
    job.status = 'done';
    job.done = true;
    job.message = job.fetched === 0
      ? 'No media found on this Instagram account yet — nothing to import.'
      : `Imported ${job.importedMedia} media item${job.importedMedia === 1 ? '' : 's'} and ${job.importedPosts} post${job.importedPosts === 1 ? '' : 's'} from Instagram.`;
  } catch (e) {
    job.status = 'error';
    job.done = true;
    job.error = e.message || 'Import failed.';
  }
}
app.post('/api/instagram/import', ah(async (req, res) => {
  const ig = getInstagramCreds();
  if (!ig.token || !ig.igUserId) {
    return res.status(400).json({ ok: false, error: 'Instagram is not connected — connect it first (Settings, or step 1 of the setup wizard).' });
  }
  const job = { id: uid('job'), status: 'running', done: false, fetched: 0, importedMedia: 0, importedPosts: 0, profile: null, error: null, message: null, startedAt: new Date().toISOString() };
  importJobs[job.id] = job;
  runInstagramImport(job); // async — poll GET /api/instagram/import/:jobId
  res.json({ ok: true, jobId: job.id });
}));
app.get('/api/instagram/import/:jobId', (req, res) => {
  const job = importJobs[req.params.jobId];
  if (!job) return res.status(404).json({ ok: false, error: 'Import job not found.' });
  res.json({ ok: true, job });
});

// ---------- posts ----------
app.get('/api/posts', (req, res) => res.json({ ok: true, posts: getPosts() }));
app.post('/api/posts', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.mediaUrl) return res.status(400).json({ ok: false, error: 'mediaUrl is required' });
  const posts = getPosts();
  const post = {
    id: uid('post'),
    mediaUrl: b.mediaUrl,
    mediaType: b.mediaType || 'video',
    caption: b.caption || '',
    hashtags: b.hashtags || '',
    cta: b.cta || '',
    platform: b.platform || 'Instagram',
    scheduleTime: b.scheduleTime || new Date().toISOString(),
    status: b.status || 'scheduled',
    format: b.format || 'REELS',
    liveUrl: b.liveUrl || '',
    createdAt: new Date().toISOString(),
  };
  posts.push(post); save('posts', posts);
  res.json({ ok: true, post });
}));
app.patch('/api/posts/:id', ah(async (req, res) => {
  const posts = getPosts();
  const i = posts.findIndex((p) => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, error: 'Post not found' });
  const allowed = ['mediaUrl', 'mediaType', 'caption', 'hashtags', 'cta', 'platform', 'scheduleTime', 'status', 'format', 'liveUrl'];
  for (const k of allowed) if (req.body && req.body[k] !== undefined) posts[i][k] = req.body[k];
  save('posts', posts);
  res.json({ ok: true, post: posts[i] });
}));
app.delete('/api/posts/:id', ah(async (req, res) => {
  save('posts', getPosts().filter((p) => p.id !== req.params.id));
  res.json({ ok: true });
}));
// Duplicate a post: a fresh copy, saved as a draft, "(copy)" in the caption.
app.post('/api/posts/:id/duplicate', ah(async (req, res) => {
  const posts = getPosts();
  const orig = posts.find((p) => p.id === req.params.id);
  if (!orig) return res.status(404).json({ ok: false, error: 'Post not found' });
  const copy = {
    ...orig,
    id: uid('post'),
    caption: `${orig.caption || ''} (copy)`.trim(),
    status: 'draft',
    liveUrl: '',
    createdAt: new Date().toISOString(),
  };
  posts.push(copy); save('posts', posts);
  res.json({ ok: true, post: copy });
}));
// Reschedule: { scheduleTime } or { addDays } (e.g. +1 day).
app.post('/api/posts/:id/reschedule', ah(async (req, res) => {
  const posts = getPosts();
  const i = posts.findIndex((p) => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, error: 'Post not found' });
  let next;
  if (req.body && req.body.scheduleTime) {
    next = new Date(req.body.scheduleTime);
  } else if (req.body && Number.isFinite(Number(req.body.addDays))) {
    const base = posts[i].scheduleTime ? new Date(posts[i].scheduleTime) : new Date();
    next = new Date(base.getTime() + Number(req.body.addDays) * 86400000);
  } else {
    return res.status(400).json({ ok: false, error: 'Give a scheduleTime or addDays.' });
  }
  if (Number.isNaN(next.getTime())) return res.status(400).json({ ok: false, error: 'That date/time is not valid.' });
  posts[i].scheduleTime = next.toISOString();
  save('posts', posts);
  res.json({ ok: true, post: posts[i] });
}));
// Next free 7:00 PM slot, computed from the user's own saved posts only:
// the first day in the next 14 days with no scheduled/draft post at 7pm
// (server local time; the Studio UI recomputes the same in browser time).
app.get('/api/next-best-time', (req, res) => {
  const posts = getPosts();
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
});

// ---------- Instagram publish (Graph API, env token only) ----------
// media_type "REELS" (NOT "REEL"), container -> FINISHED -> media_publish.
async function graph(path, method, body) {
  const url = `https://graph.facebook.com/v27.0${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
app.post('/api/posts/:id/publish', ah(async (req, res) => {
  const ig = getInstagramCreds();
  if (!ig.token || !ig.igUserId) {
    return res.status(400).json({ ok: false, error: 'Instagram not connected — paste your access token in Settings (or set INSTAGRAM_ACCESS_TOKEN and IG_USER_ID in environment variables) to publish from here.' });
  }
  const posts = getPosts();
  const post = posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: 'Post not found' });
  const token = ig.token;
  const igId = ig.igUserId;
  const isReel = (post.format || 'REELS') === 'REELS';
  const caption = [post.caption, post.hashtags ? post.hashtags.split(/[,\s]+/).filter(Boolean).map((h) => (h.startsWith('#') ? h : '#' + h)).join(' ') : ''].filter(Boolean).join('\n');
  const containerBody = isReel
    ? { media_type: 'REELS', video_url: post.mediaUrl, caption, access_token: token }
    : { image_url: post.mediaUrl, caption, access_token: token };
  const created = await graph(`/${igId}/media`, 'POST', containerBody);
  if (!created || created.error) {
    post.status = 'failed'; save('posts', posts);
    return res.status(502).json({ ok: false, error: (created && created.error && created.error.message) || 'Failed to create media container' });
  }
  // Poll container status until FINISHED (max ~90s).
  let status = '';
  for (let i = 0; i < 18; i++) {
    const s = await graph(`/${created.id}?fields=status_code&access_token=${encodeURIComponent(token)}`, 'GET');
    status = s.status_code || '';
    if (status === 'FINISHED') break;
    if (status === 'ERROR') { post.status = 'failed'; save('posts', posts); return res.status(502).json({ ok: false, error: 'Instagram failed to process the media' }); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (status !== 'FINISHED') return res.json({ ok: false, error: 'Media is still processing — try publishing again in a minute', containerId: created.id });
  const published = await graph(`/${igId}/media_publish`, 'POST', { creation_id: created.id, access_token: token });
  if (!published || published.error) {
    post.status = 'failed'; save('posts', posts);
    return res.status(502).json({ ok: false, error: (published.error && published.error.message) || 'Publish failed' });
  }
  const media = await graph(`/${published.id}?fields=permalink,media_type&access_token=${encodeURIComponent(token)}`, 'GET');
  post.status = 'published';
  post.liveUrl = (media && media.permalink) || '';
  save('posts', posts);
  res.json({ ok: true, liveUrl: post.liveUrl, mediaId: published.id });
}));

// ---------- media library ----------
app.get('/api/media', (req, res) => res.json({ ok: true, media: getMedia() }));
app.post('/api/media', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.url) return res.status(400).json({ ok: false, error: 'url is required' });
  const media = getMedia();
  const item = {
    id: uid('media'), url: b.url, title: b.title || 'Untitled',
    kind: b.kind || (/\.(mp4|mov|webm)$/i.test(b.url) ? 'video' : 'image'),
    size: b.size || 0, duration: b.duration || 0,
    folder: b.folder || 'General', tags: Array.isArray(b.tags) ? b.tags : [], favorite: false, usedCount: 0,
    createdAt: new Date().toISOString(),
  };
  media.push(item); save('media', media);
  res.json({ ok: true, media: item });
}));
// Upload: multipart via raw body is avoided; the frontend sends base64 in JSON.
// POST /api/media/upload { name, dataUrl, folder, tags } — max ~60MB.
app.post('/api/media/upload', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.dataUrl || !b.name) return res.status(400).json({ ok: false, error: 'name and dataUrl are required' });
  const media = getMedia();
  const item = {
    id: uid('media'), url: b.dataUrl, title: b.name,
    kind: /\.(mp4|mov|webm)$/i.test(b.name) ? 'video' : 'image',
    size: Math.round((b.dataUrl.length * 3) / 4), duration: 0,
    folder: b.folder || 'Uploads', tags: Array.isArray(b.tags) ? b.tags : [], favorite: false, usedCount: 0,
    createdAt: new Date().toISOString(),
  };
  media.push(item); save('media', media);
  res.json({ ok: true, media: item });
}));
app.patch('/api/media/:id', ah(async (req, res) => {
  const media = getMedia();
  const i = media.findIndex((m) => m.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, error: 'Media not found' });
  const allowed = ['title', 'folder', 'tags', 'favorite', 'usedCount'];
  for (const k of allowed) if (req.body && req.body[k] !== undefined) media[i][k] = req.body[k];
  save('media', media);
  res.json({ ok: true, media: media[i] });
}));
app.delete('/api/media/:id', ah(async (req, res) => {
  save('media', getMedia().filter((m) => m.id !== req.params.id));
  res.json({ ok: true });
}));

// ---------- templates ----------
app.get('/api/templates', (req, res) => res.json({ ok: true, templates: getTemplates() }));
app.post('/api/templates', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.text) return res.status(400).json({ ok: false, error: 'name and text are required' });
  const templates = getTemplates();
  const t = { id: uid('tpl'), name: b.name, text: b.text };
  templates.push(t); save('templates', templates);
  res.json({ ok: true, template: t });
}));

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.json({ ok: true, service: 'social-scheduler', note: 'Frontend not built yet — run npm run build in frontend/.' });
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ ok: false, error: 'Server error' }); });

if (require.main === module) app.listen(PORT, () => console.log(`Social Scheduler listening on ${PORT}`));
module.exports = app;
