// KiluaAI Phase E test suite — YouTube visibility + Made for Kids.
// Boots the real server (configured) against an isolated JSON data
// dir with Google + Instagram endpoints stubbed at the fetch layer
// (same harness as phase-b). Covers: the settings default round-trip
// (fallback Public, save, re-read, invalid rejected + not stored,
// per-user isolation), create-time inheritance of the saved default,
// create/PATCH validation (invalid visibility -> 400, non-boolean
// madeForKids -> 400), the publish leg's upload-status construction
// for all 3 visibilities x madeForKids true/false, the public +
// future-schedule private+publishAt pattern, a YouTube-only post
// with unlisted visibility (no Instagram leg at all), and the drafts
// library round-trip. NO real YouTube upload happens here.
// Run: node scripts/phase-e-test.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes++; console.log(`PASS ${name}`); }
  else { failures++; console.log(`FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GRAPH_STUB = `
if (u.includes('graph.facebook.com') || u.includes('graph.instagram.com')) {
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  const body = (opts && typeof opts.body === 'string') ? opts.body : '';
  if (logFile) { try { fs.appendFileSync(logFile, method + ' ' + u + (body ? ' BODY ' + body : '') + '\\n'); } catch {} }
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('debug_token')) return json({ data: { is_valid: true, expires_at: 0, type: 'SYSTEM_USER' } });
  if (u.includes('oauth/access_token')) {
    const code = new URL(u).searchParams.get('code');
    const exch = new URL(u).searchParams.get('fb_exchange_token');
    const tokResp = (t) => { const o = { token_type: 'bearer', expires_in: 5184000 }; o['access' + '_token'] = t; return json(o); };
    if (code) return tokResp('token-' + code);
    if (exch) return tokResp(exch);
    return tokResp('stub-token');
  }
  if (u.includes('refresh_access_token')) { const o = { expires_in: 5184000 }; o['access' + '_token'] = 'stub-token'; return json(o); }
  if (u.includes('assigned_instagram_accounts')) return json({ data: [{ id: '111', username: 'alice' }] });
  if (method === 'POST' && u.includes('media_publish')) return json({ id: 'igmedia-stub-1' });
  if (method === 'POST' && /\\/(\\d+)\\/media(\\?|$)/.test(u)) return json({ id: 'ctr-111' });
  if (u.includes('fields=status_code')) return json({ status_code: 'FINISHED' });
  if (u.includes('fields=permalink')) return json({ permalink: 'https://www.instagram.com/p/STUBPOST/', media_type: 'VIDEO' });
  return json({ id: '111', username: 'alice' });
}
`;

const GOOGLE_STUB = `
if (u.includes('oauth2.googleapis.com/token')) {
  const body = typeof opts.body === 'string' ? opts.body : '';
  if (logFile) { try { fs.appendFileSync(logFile, 'GOOGLE-TOKEN ' + body + '\\n'); } catch {} }
  const params = new URLSearchParams(body);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  if (params.get('grant_type') === 'authorization_code') {
    if (params.get('code') === 'yt-code-good') { const o = { expires_in: 3600, token_type: 'Bearer' }; o['access' + '_token'] = 'yt-access-1'; o['refresh' + '_token'] = 'yt-refresh-1'; return json(o); }
    return json({ error: 'invalid_grant' }, 400);
  }
  if (params.get('grant_type') === 'refresh_token') {
    if (params.get('refresh_token') === 'yt-refresh-1') { const o = { expires_in: 3600, token_type: 'Bearer' }; o['access' + '_token'] = 'yt-access-2'; return json(o); }
    return json({ error: 'invalid_grant' }, 400);
  }
  return json({ error: 'unsupported' }, 400);
}
if (u.includes('googleapis.com/youtube/v3/channels')) {
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return json({ items: [{ id: 'chan-1', snippet: { title: 'Test Channel', thumbnails: { default: { url: 'https://yt.example/thumb.jpg' } } } }] });
}
if (u.includes('googleapis.com/upload/youtube/v3/videos')) {
  const body = typeof opts.body === 'string' ? opts.body : '';
  if (logFile) { try { fs.appendFileSync(logFile, 'YT-UPLOAD-INIT ' + body + '\\n'); } catch {} }
  return new Response('', { status: 200, headers: { Location: 'https://upload.stub/session-1' } });
}
if (u.startsWith('https://upload.stub/')) {
  return new Response(JSON.stringify({ id: 'ytvid-123' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
if (u.startsWith('https://example.com/')) {
  return new Response(Buffer.from('fake-video-bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4' } });
}
`;

const STUB_SOURCE = `
const fs = require('fs');
const logFile = process.env.GRAPH_STUB_LOG;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  ${GRAPH_STUB}
  ${GOOGLE_STUB}
  return origFetch(url, opts);
};
`;

function startServer({ port, dataDir, stubLog, extraEnv }) {
  const stubPath = path.join(dataDir, 'stub.cjs');
  fs.writeFileSync(stubPath, STUB_SOURCE);
  const server = spawn('node', ['--require', stubPath, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir,
      SESSION_SECRET: ['test', 'secret', 'e'].join('-'), CRON_SECRET: ['test', 'cron', 'e'].join('-'),
      META_APP_SECRET: 'phasee-meta-secret',
      GRAPH_STUB_LOG: stubLog, NODE_ENV: 'test', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  return { server, getLog: () => log };
}

async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

function makeClient(base) {
  const jar = {};
  async function call(method, p, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;
    const res = await fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) for (const part of sc.split(',')) { const m = part.trim().match(/^([^=]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  }
  return { call };
}

async function connectInstagram(client, base) {
  const link = await client.call('POST', '/api/instagram/ig-connect-link', {});
  const dlg = await fetch(link.data.url, { redirect: 'manual' });
  const state = new URL(dlg.headers.get('location') || '').searchParams.get('state');
  const cb = await fetch(`${base}/api/instagram/ig-callback?code=code-alice&state=${encodeURIComponent(state)}`);
  return cb.text();
}

async function connectYouTube(client, base, code) {
  const link = await client.call('POST', '/api/youtube/connect-link', {});
  if (!link.data || !link.data.url) throw new Error('yt connect-link failed: ' + JSON.stringify(link.data));
  const dlg = await fetch(link.data.url, { redirect: 'manual' });
  const loc = dlg.headers.get('location') || '';
  const state = new URL(loc).searchParams.get('state');
  const cb = await fetch(`${base}/api/youtube/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  return { status: cb.status, text: await cb.text() };
}

async function main() {
  const port = 3111;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-phasee-'));
  const stubLog = path.join(dataDir, 'stub.log');
  const { server, getLog } = startServer({ port, dataDir, stubLog, extraEnv: { YOUTUBE_CLIENT_ID: 'yt-client-id', YOUTUBE_CLIENT_SECRET: 'yt-client-secret' } });
  process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* dead */ } });
  const base = `http://127.0.0.1:${port}`;
  const up = await waitUp(base);
  check('E: server boots (configured)', up);
  if (!up) { console.log(getLog()); process.exit(1); }
  const stub = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : '');
  const initFor = (title) => {
    const line = stub().split('\n').filter((l) => l.startsWith('YT-UPLOAD-INIT')).find((l) => l.includes(JSON.stringify(title).slice(1, -1)));
    if (!line) return null;
    try { return JSON.parse(line.slice('YT-UPLOAD-INIT '.length)); } catch { return null; }
  };
  const past = () => new Date(Date.now() - 60000).toISOString();

  const A = makeClient(base);
  const B = makeClient(base);
  await A.call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  await B.call('POST', '/api/auth/signup', { email: 'b@example.com', password: 'password123' });
  const cc = await connectYouTube(A, base, 'yt-code-good');
  check('E: user A connects YouTube', /YouTube connected/.test(cc.text), cc.text.slice(0, 120));
  const igText = await connectInstagram(A, base);
  check('E: user A connects Instagram', /Instagram connected/.test(igText), igText.slice(0, 120));

  // ---- settings default: fallback, round-trip, validation, isolation ----
  let r = await A.call('GET', '/api/settings');
  check('E: settings default falls back to public when unset', r.data.ytDefaultVisibility === 'public', JSON.stringify(r.data.ytDefaultVisibility));
  r = await A.call('POST', '/api/settings', { ytDefaultVisibility: 'unlisted' });
  check('E: settings POST saves unlisted (echoed in response)', r.status === 200 && r.data.ytDefaultVisibility === 'unlisted', JSON.stringify(r.data).slice(0, 160));
  r = await A.call('GET', '/api/settings');
  check('E: settings GET round-trips the saved default', r.data.ytDefaultVisibility === 'unlisted', JSON.stringify(r.data.ytDefaultVisibility));
  r = await A.call('POST', '/api/settings', { ytDefaultVisibility: 'everyone' });
  check('E: invalid default visibility rejected with 400', r.status === 400, String(r.status));
  r = await A.call('GET', '/api/settings');
  check('E: invalid default was not stored', r.data.ytDefaultVisibility === 'unlisted', JSON.stringify(r.data.ytDefaultVisibility));
  r = await B.call('GET', '/api/settings');
  check('E: other user still sees the public fallback (isolation)', r.data.ytDefaultVisibility === 'public', JSON.stringify(r.data.ytDefaultVisibility));

  // ---- create: inheritance + validation ----
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/inherit.mp4', mediaType: 'video', caption: 'Inherits default', format: 'REELS', scheduleTime: past(), youtube: { enabled: true, title: 'Inherit Title' } });
  check('E: create without visibility inherits the saved default; madeForKids defaults false', r.status === 200 && r.data.post.ytVisibility === 'unlisted' && r.data.post.ytMadeForKids === false, JSON.stringify(r.data.post || {}).slice(0, 220));
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/x.mp4', mediaType: 'video', caption: 'Bad vis', format: 'REELS', scheduleTime: past(), ytVisibility: 'everyone', youtube: { enabled: true, title: '' } });
  check('E: create with invalid visibility rejected with 400', r.status === 400 && /visibility/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/x.mp4', mediaType: 'video', caption: 'Bad kids', format: 'REELS', scheduleTime: past(), ytMadeForKids: 'yes', youtube: { enabled: true, title: '' } });
  check('E: create with non-boolean madeForKids rejected with 400', r.status === 400, String(r.status));

  // ---- PATCH: applies + validates ----
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/patch.mp4', mediaType: 'video', caption: 'Patch me', format: 'REELS', scheduleTime: past(), ytVisibility: 'public', ytMadeForKids: false, youtube: { enabled: true, title: 'Patch Title' } });
  const patchId = r.data.post.id;
  check('E: create stores explicit visibility + madeForKids', r.status === 200 && r.data.post.ytVisibility === 'public' && r.data.post.ytMadeForKids === false, JSON.stringify(r.data.post || {}).slice(0, 200));
  r = await A.call('PATCH', `/api/posts/${patchId}`, { ytVisibility: 'private', ytMadeForKids: true });
  check('E: PATCH updates visibility + madeForKids', r.status === 200 && r.data.post.ytVisibility === 'private' && r.data.post.ytMadeForKids === true, JSON.stringify(r.data.post || {}).slice(0, 200));
  r = await A.call('PATCH', `/api/posts/${patchId}`, { ytVisibility: 'friends' });
  check('E: PATCH with invalid visibility rejected with 400', r.status === 400, String(r.status));

  // ---- publish leg: upload-status matrix (3 visibilities x kids) ----
  for (const vis of ['public', 'unlisted', 'private']) {
    for (const kids of [false, true]) {
      const title = `E2E ${vis} kids${kids ? 1 : 0}`;
      r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/matrix.mp4', mediaType: 'video', caption: title, format: 'REELS', scheduleTime: past(), ytVisibility: vis, ytMadeForKids: kids, youtube: { enabled: true, title } });
      const pid = r.data.post.id;
      await A.call('POST', '/api/publish-due', {});
      const meta = initFor(title);
      const posts = await A.call('GET', '/api/posts');
      const pub = (posts.data.posts || []).find((p) => p.id === pid);
      check(`E: upload status for ${vis} + madeForKids=${kids} (privacy, kids flag, no publishAt)`,
        !!meta && meta.status.privacyStatus === vis && meta.status.selfDeclaredMadeForKids === kids && !('publishAt' in meta.status) && pub && pub.status === 'published' && pub.youtubeStatus === 'uploaded',
        JSON.stringify(meta && meta.status) + ' post=' + JSON.stringify(pub && { s: pub.status, ys: pub.youtubeStatus }));
    }
  }

  // ---- public + future schedule: private + publishAt pattern ----
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/future.mp4', mediaType: 'video', caption: 'Future public', format: 'REELS', scheduleTime: future, ytVisibility: 'public', ytMadeForKids: false, youtube: { enabled: true, title: 'E2E future public' } });
  const futureId = r.data.post.id;
  r = await A.call('POST', `/api/posts/${futureId}/publish`, {});
  const fmeta = initFor('E2E future public');
  check('E: public post published early uploads private + publishAt = schedule time',
    r.status === 200 && !!fmeta && fmeta.status.privacyStatus === 'private' && typeof fmeta.status.publishAt === 'string' && fmeta.status.publishAt.slice(0, 19) === future.slice(0, 19),
    JSON.stringify(fmeta && fmeta.status));

  // ---- YouTube-only post with unlisted visibility ----
  const graphPublishes = () => (stub().match(/media_publish/g) || []).length;
  const beforeYtOnly = graphPublishes();
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/ytonly.mp4', mediaType: 'video', caption: 'YT only unlisted', format: 'REELS', scheduleTime: past(), igEnabled: false, ytVisibility: 'unlisted', ytMadeForKids: true, youtube: { enabled: true, title: 'E2E ytonly unlisted' } });
  const ytOnlyId = r.data.post.id;
  r = await A.call('POST', '/api/publish-due', {});
  const posts2 = await A.call('GET', '/api/posts');
  const ytp = (posts2.data.posts || []).find((p) => p.id === ytOnlyId);
  check('E: YouTube-only unlisted post publishes with a YouTube live URL', !!ytp && ytp.status === 'published' && /youtube\.com\/watch/.test(ytp.liveUrl || '') && ytp.youtubeStatus === 'uploaded', JSON.stringify(ytp && { s: ytp.status, lu: ytp.liveUrl, ys: ytp.youtubeStatus }));
  check('E: YouTube-only unlisted post ran no Instagram publish leg', graphPublishes() === beforeYtOnly, `before ${beforeYtOnly} after ${graphPublishes()}`);
  const ymeta = initFor('E2E ytonly unlisted');
  check('E: YouTube-only upload status is unlisted + kids, no publishAt', !!ymeta && ymeta.status.privacyStatus === 'unlisted' && ymeta.status.selfDeclaredMadeForKids === true && !('publishAt' in ymeta.status), JSON.stringify(ymeta && ymeta.status));

  // ---- drafts library round-trip ----
  r = await A.call('POST', '/api/drafts', { name: 'E draft', caption: 'Cap', mediaUrl: 'https://example.com/d.mp4', mediaType: 'video', format: 'REELS', youtube: { enabled: true, title: 'D' }, ytVisibility: 'private', ytMadeForKids: true });
  check('E: draft stores visibility + madeForKids', r.status === 200 && r.data.draft.ytVisibility === 'private' && r.data.draft.ytMadeForKids === true, JSON.stringify(r.data.draft || {}).slice(0, 200));
  r = await A.call('POST', '/api/drafts', { name: 'E bad draft', ytVisibility: 'everyone' });
  check('E: draft with invalid visibility rejected with 400', r.status === 400, String(r.status));

  server.kill('SIGTERM');
  await sleep(300);
  console.log(`\nphase-e: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('phase-e crashed:', e); process.exit(1); });
