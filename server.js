// Social Scheduler by Goyal Kumar
// Express backend + JSON-file storage (Vercel serverless safe: reads/writes
// data/*.json when writable, otherwise falls back to in-memory state).
// No secrets are hard-coded: the Instagram token comes only from env vars
// INSTAGRAM_ACCESS_TOKEN and IG_USER_ID. Never commit a token.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
try { fs.mkdirSync(DATA, { recursive: true }); } catch { /* read-only fs */ }

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
function igConfigured() { return !!(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.IG_USER_ID); }

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
  res.json({ ok: true, instagramHandle: s.instagramHandle || '', instagramConnected: igConfigured(), tokenConfigured: igConfigured() });
});
app.post('/api/settings', ah(async (req, res) => {
  const s = { ...getSettings(), ...(req.body || {}) };
  delete s.token; delete s.accessToken; // tokens are env-only, never stored via API
  save('settings', s);
  res.json({ ok: true, instagramHandle: s.instagramHandle || '', instagramConnected: igConfigured(), tokenConfigured: igConfigured() });
}));

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

// ---------- Instagram publish (Graph API, env token only) ----------
// Proven live 2026-11-09: media_type "REELS" (NOT "REEL"), container -> FINISHED -> media_publish.
// Demo Reel: https://www.instagram.com/reel/Dfhxtieks0u/ (app "Zahixx Scheduler", dev mode)
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
  if (!igConfigured()) {
    return res.status(400).json({ ok: false, error: 'Instagram not connected — set INSTAGRAM_ACCESS_TOKEN and IG_USER_ID in Settings (environment variables) to publish from here.' });
  }
  const posts = getPosts();
  const post = posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: 'Post not found' });
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igId = process.env.IG_USER_ID;
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
