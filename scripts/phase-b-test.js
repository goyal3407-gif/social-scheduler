// KiluaAI Phase B test suite — YouTube cross-post + Connections data.
// Boots the real server twice against isolated JSON data dirs:
//  1) UNCONFIGURED (no YOUTUBE_* env): the feature must be inert —
//     status reports configured:false, connect-link refuses, posts
//     still save, nothing breaks.
//  2) CONFIGURED (YOUTUBE_CLIENT_ID/SECRET set): Google endpoints are
//     stubbed at the fetch layer (token, channels, resumable upload)
//     together with the Instagram Graph stub. Covers the full connect
//     flow (one-time link, single-use replay, encrypted refresh token
//     at rest), toggle persistence on posts, the publish leg (right
//     metadata, publishAt for future posts, private status), failure
//     isolation (YouTube failure never fails/duplicates Instagram),
//     image skip, disconnect, and cross-user isolation.
// NO real YouTube upload and NO real Instagram publish happen here.
// Run: node scripts/phase-b-test.js
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
    if (params.get('code') === 'yt-code-norefresh') { const o = { expires_in: 3600, token_type: 'Bearer' }; o['access' + '_token'] = 'yt-access-x'; return json(o); }
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
  if (body.includes('FAILYT')) return new Response(JSON.stringify({ error: { message: 'stub upload refusal' } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  return new Response('', { status: 200, headers: { Location: 'https://upload.stub/session-1' } });
}
if (u.startsWith('https://upload.stub/')) {
  if (logFile) { try { fs.appendFileSync(logFile, 'YT-UPLOAD-PUT bytes=' + (opts.body ? opts.body.length : 0) + '\\n'); } catch {} }
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
      SESSION_SECRET: ['test', 'secret', 'b'].join('-'), CRON_SECRET: ['test', 'cron', 'b'].join('-'),
      META_APP_SECRET: 'phaseb-meta-secret',
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

async function boot(port, extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-phaseb-'));
  const stubLog = path.join(dataDir, 'stub.log');
  const { server, getLog } = startServer({ port, dataDir, stubLog, extraEnv });
  process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* dead */ } });
  const base = `http://127.0.0.1:${port}`;
  const up = await waitUp(base);
  return { server, dataDir, stubLog, getLog, base, up };
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
  return { linkUrl: link.data.url, loc, status: cb.status, text: await cb.text() };
}

async function main() {
  // ---------- boot 1: unconfigured ----------
  {
    const { server, base, up, getLog } = await boot(3107, { YOUTUBE_CLIENT_ID: '', YOUTUBE_CLIENT_SECRET: '' });
    check('B1: server boots (unconfigured)', up);
    if (!up) { console.log(getLog()); process.exit(1); }
    const A = makeClient(base);
    await A.call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123' });
    let r = await A.call('GET', '/api/youtube/status');
    check('B1: status reports configured:false + connected:false', r.data.configured === false && r.data.connected === false, JSON.stringify(r.data));
    r = await A.call('POST', '/api/youtube/connect-link', {});
    check('B1: connect-link refuses with 503 when unconfigured', r.status === 503, String(r.status));
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/reel.mp4', mediaType: 'video', caption: 'x', format: 'REELS', scheduleTime: new Date(Date.now() - 60000).toISOString(), youtube: { enabled: true, title: 'T' } });
    check('B1: post with youtube setting still saves when unconfigured', r.status === 200 && r.data.post.youtube.enabled === true, JSON.stringify(r.data).slice(0, 200));
    r = await A.call('POST', '/api/youtube/disconnect', {});
    check('B1: disconnect is a safe no-op when unconfigured', r.status === 200);
    server.kill('SIGTERM');
    await sleep(300);
  }

  // ---------- boot 2: configured ----------
  {
    const { server, base, up, getLog, dataDir, stubLog } = await boot(3108, { YOUTUBE_CLIENT_ID: 'yt-client-id', YOUTUBE_CLIENT_SECRET: 'yt-client-secret' });
    check('B2: server boots (configured)', up);
    if (!up) { console.log(getLog()); process.exit(1); }
    const stub = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : '');
    const A = makeClient(base);
    const B = makeClient(base);
    await A.call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123' });
    await B.call('POST', '/api/auth/signup', { email: 'b@example.com', password: 'password123' });

    let r = await A.call('GET', '/api/youtube/status');
    check('B2: status reports configured:true before connect', r.data.configured === true && r.data.connected === false, JSON.stringify(r.data));

    // no-refresh-token grant is refused with a friendly page
    const bad = await connectYouTube(A, base, 'yt-code-norefresh');
    check('B2: grant without refresh token is refused', /YouTube was not connected/.test(bad.text), bad.text.slice(0, 160));
    r = await A.call('GET', '/api/youtube/status');
    check('B2: still not connected after refused grant', r.data.connected === false);

    // full connect flow
    const c = await connectYouTube(A, base, 'yt-code-good');
    check('B2: connect link redirects to Google with youtube scopes', c.loc.includes('accounts.google.com') && decodeURIComponent(c.loc).includes('youtube.upload') && decodeURIComponent(c.loc).includes('youtube.readonly'), c.loc.slice(0, 200));
    check('B2: callback confirms YouTube connected', c.status === 200 && /YouTube connected/.test(c.text), c.text.slice(0, 160));
    r = await A.call('GET', '/api/youtube/status');
    check('B2: status shows channel after connect', r.data.connected === true && r.data.channelId === 'chan-1' && r.data.channelTitle === 'Test Channel', JSON.stringify(r.data));

    // refresh token stored encrypted, never plaintext
    const ytFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'youtube.json'), 'utf8'));
    const stored = Object.values(ytFile)[0] || {};
    check('B2: refresh token stored encrypted (not plaintext)', stored.refreshTokenEncrypted === true && stored.refreshTokenEnc && !String(stored.refreshTokenEnc).includes('yt-refresh-1'), JSON.stringify(Object.keys(stored)));

    // single-use: replaying the same connect link is refused
    const replay = await fetch(c.linkUrl, { redirect: 'manual' });
    const replayText = await replay.text();
    check('B2: connect link is single-use (replay refused)', replay.status === 401 && /expired/.test(replayText), String(replay.status));

    // isolation: B sees no connection
    r = await B.call('GET', '/api/youtube/status');
    check('B2: other user sees connected:false', r.data.connected === false && r.data.configured === true);

    // Instagram connect for publishing
    const igText = await connectInstagram(A, base);
    check('B2: instagram connected for publish tests', /Instagram connected/.test(igText), igText.slice(0, 120));

    const past = () => new Date(Date.now() - 60000).toISOString();
    // post with youtube enabled publishes to both
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/reel.mp4', mediaType: 'video', caption: 'Hello world caption', hashtags: '#test', format: 'REELS', scheduleTime: past(), youtube: { enabled: true, title: 'My YT Title' } });
    check('B2: post stores youtube setting', r.status === 200 && r.data.post.youtube.enabled === true && r.data.post.youtube.title === 'My YT Title', JSON.stringify(r.data.post?.youtube));
    const postId = r.data.post.id;
    r = await A.call('POST', '/api/publish-due', {});
    check('B2: publish-due publishes the post', (r.data.published || []).some((p) => p.id === postId), JSON.stringify(r.data));
    r = await A.call('GET', '/api/posts');
    const pub = (r.data.posts || []).find((p) => p.id === postId);
    check('B2: IG published + YouTube uploaded with video id', pub.status === 'published' && pub.youtubeStatus === 'uploaded' && pub.youtubeVideoId === 'ytvid-123', JSON.stringify({ s: pub.status, ys: pub.youtubeStatus, yv: pub.youtubeVideoId }));
    const initLine = stub().split('\n').find((l) => l.startsWith('YT-UPLOAD-INIT') && l.includes('My YT Title')) || '';
    // Phase E changed the default: a post with no explicit visibility
    // now uploads with the user's default (Public) instead of the old
    // always-Private — this post's time is in the past, so no
    // publishAt applies and the status goes out as public.
    check('B2: upload metadata has title + public default visibility + caption description', initLine.includes('"title":"My YT Title"') && initLine.includes('"privacyStatus":"public"') && initLine.includes('Hello world caption'), initLine.slice(0, 240));
    check('B2: refresh-token grant was used for the upload', stub().includes('grant_type=refresh_token'), '');

    // future post published early carries publishAt (YouTube-native scheduling)
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/reel2.mp4', mediaType: 'video', caption: 'Future one', format: 'REELS', scheduleTime: future, youtube: { enabled: true, title: '' } });
    const futureId = r.data.post.id;
    r = await A.call('POST', `/api/posts/${futureId}/publish`, {});
    check('B2: manual publish of future post succeeds', r.status === 200 && r.data.ok === true, JSON.stringify(r.data).slice(0, 160));
    const initFuture = stub().split('\n').filter((l) => l.startsWith('YT-UPLOAD-INIT')).pop() || '';
    check('B2: future upload carries publishAt = schedule time', initFuture.includes('"publishAt":"' + future.slice(0, 19)), initFuture.slice(0, 260));

    // YouTube failure never fails Instagram
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/reel3.mp4', mediaType: 'video', caption: 'Will fail on YT', format: 'REELS', scheduleTime: past(), youtube: { enabled: true, title: 'FAILYT upload' } });
    const failId = r.data.post.id;
    r = await A.call('POST', '/api/publish-due', {});
    check('B2: publish-due still reports the IG publish as published', (r.data.published || []).some((p) => p.id === failId), JSON.stringify(r.data).slice(0, 200));
    r = await A.call('GET', '/api/posts');
    const fp = (r.data.posts || []).find((p) => p.id === failId);
    check('B2: IG live, youtubeStatus failed with reason', fp.status === 'published' && fp.youtubeStatus === 'failed' && /stub upload refusal/.test(fp.youtubeError || ''), JSON.stringify({ s: fp.status, ys: fp.youtubeStatus, ye: fp.youtubeError }));
    r = await A.call('GET', '/api/notifications');
    const notes = JSON.stringify(r.data.notifications || r.data || []);
    check('B2: failure notified through the notification path', notes.includes('YouTube upload failed'), notes.slice(0, 200));

    // image post skips YouTube
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/pic.jpg', mediaType: 'image', caption: 'An image', format: 'FEED', scheduleTime: past(), youtube: { enabled: true, title: 'Img' } });
    const imgId = r.data.post.id;
    await A.call('POST', '/api/publish-due', {});
    r = await A.call('GET', '/api/posts');
    const ip = (r.data.posts || []).find((p) => p.id === imgId);
    check('B2: image post skips YouTube (videos only)', ip.status === 'published' && ip.youtubeStatus === 'skipped' && !ip.youtubeVideoId, JSON.stringify({ s: ip.status, ys: ip.youtubeStatus }));

    // validation: over-long YouTube title rejected
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/reel.mp4', mediaType: 'video', caption: 'x', format: 'REELS', scheduleTime: past(), youtube: { enabled: true, title: 'x'.repeat(101) } });
    check('B2: YouTube title over 100 chars rejected', r.status === 400, String(r.status));

    // ---- platform picker revision: YouTube-only posts ----
    const graphPublishes = () => (stub().match(/media_publish/g) || []).length;
    const beforeYtOnly = graphPublishes();
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/ytonly.mp4', mediaType: 'video', caption: 'YouTube only post', format: 'REELS', scheduleTime: past(), igEnabled: false, youtube: { enabled: true, title: 'YT Only Title' } });
    check('B2: YouTube-only post saves with igEnabled false', r.status === 200 && r.data.post.igEnabled === false && r.data.post.youtube.enabled === true, JSON.stringify(r.data.post || {}).slice(0, 200));
    const ytOnlyId = r.data.post.id;
    r = await A.call('POST', '/api/publish-due', {});
    check('B2: publish-due publishes the YouTube-only post', (r.data.published || []).some((p) => p.id === ytOnlyId), JSON.stringify(r.data).slice(0, 200));
    r = await A.call('GET', '/api/posts');
    const ytp = (r.data.posts || []).find((p) => p.id === ytOnlyId);
    check('B2: YouTube-only post is published with a YouTube live URL', ytp.status === 'published' && ytp.youtubeVideoId === 'ytvid-123' && /youtube\.com\/watch/.test(ytp.liveUrl || ''), JSON.stringify({ s: ytp.status, yv: ytp.youtubeVideoId, lu: ytp.liveUrl }));
    check('B2: no Instagram publish happened for the YouTube-only post', graphPublishes() === beforeYtOnly, `before ${beforeYtOnly} after ${graphPublishes()}`);

    // both platforms unticked is rejected at create
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/none.mp4', mediaType: 'video', caption: 'No platform', format: 'REELS', scheduleTime: past(), igEnabled: false, youtube: { enabled: false, title: '' } });
    check('B2: post with no platform ticked is rejected', r.status === 400 && /Tick at least one platform/.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 160));

    // a user with NO Instagram at all can still publish YouTube-only
    const C = makeClient(base);
    await C.call('POST', '/api/auth/signup', { email: 'c@example.com', password: 'password123' });
    const cc = await connectYouTube(C, base, 'yt-code-good');
    check('B2: user C connects YouTube (no Instagram)', /YouTube connected/.test(cc.text), cc.text.slice(0, 120));
    r = await C.call('POST', '/api/posts', { mediaUrl: 'https://example.com/conly.mp4', mediaType: 'video', caption: 'C yt only', format: 'REELS', scheduleTime: past(), igEnabled: false, youtube: { enabled: true, title: '' } });
    const cPostId = r.data.post.id;
    r = await C.call('POST', '/api/publish-due', {});
    check('B2: publish-due works for a YouTube-only user with no Instagram', (r.data.published || []).some((p) => p.id === cPostId), JSON.stringify(r.data).slice(0, 200));

    // disconnect
    r = await A.call('POST', '/api/youtube/disconnect', {});
    check('B2: disconnect succeeds', r.status === 200);
    r = await A.call('GET', '/api/youtube/status');
    check('B2: status shows disconnected after disconnect', r.data.connected === false && r.data.configured === true);

    server.kill('SIGTERM');
    await sleep(300);
  }

  console.log(`\nphase-b: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('phase-b crashed:', e); process.exit(1); });
