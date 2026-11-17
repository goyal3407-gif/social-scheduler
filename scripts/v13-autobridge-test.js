// KiluaAI v1.3 auto-bridge + publish-path test suite.
//
// Boots the real server against isolated JSON data dirs (no MongoDB)
// with the Instagram Graph API stubbed at the fetch layer (a --require
// preload that answers graph.facebook.com / graph.instagram.com calls
// with canned success responses and logs every call), so the FULL
// publish path — container create → FINISHED → media_publish →
// permalink → post-publish auto-delete — runs locally end to end.
//
// Phase A: JSON media store (publish, double-publish guards, timezone,
//          chunked-upload edges, 200 MB cap, keep-server-copy, web
//          media operations, user isolation).
// Phase B: OCI Object Storage (only when the goal's hidden OCI files
//          are present): bridge copy lands in the bucket, publish
//          auto-deletes the object (read URL 404), keep-copy keeps it.
//
// Run: node scripts/v13-autobridge-test.js
// Exits non-zero if any check fails. No secrets are printed.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes++; console.log(`PASS ${name}`); }
  else { failures++; console.log(`FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

const STUB_SOURCE = `
const fs = require('fs');
const logFile = process.env.GRAPH_STUB_LOG;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('graph.facebook.com') || u.includes('graph.instagram.com')) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    if (logFile) { try { fs.appendFileSync(logFile, method + ' ' + u + '\\n'); } catch {} }
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('debug_token')) return json({ data: { is_valid: true, expires_at: 0, type: 'USER' } });
    if (u.includes('oauth/access_token') || u.includes('refresh_access_token')) return json({ access_token: 'stub-token', token_type: 'bearer', expires_in: 5184000 });
    if (method === 'POST' && u.includes('media_publish')) return json({ id: 'igmedia-stub-1' });
    if (method === 'POST' && /\\/media(\\?|$)/.test(u)) return json({ id: 'ctr-stub-1' });
    if (u.includes('fields=status_code')) return json({ status_code: 'FINISHED' });
    if (u.includes('fields=permalink')) return json({ permalink: 'https://www.instagram.com/p/STUBPOST/', media_type: 'VIDEO' });
    return json({ id: '999', username: 'stubuser' });
  }
  return origFetch(url, opts);
};
`;

function startServer({ port, dataDir, extraEnv = {}, stubLog }) {
  const stubPath = path.join(dataDir, 'graph-stub.cjs');
  fs.writeFileSync(stubPath, STUB_SOURCE);
  const server = spawn('node', ['--require', stubPath, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir,
      SESSION_SECRET: 'v13-test-secret-0123456789abcdef', NODE_ENV: 'test',
      CRON_SECRET: 'v13-cron-secret', GRAPH_STUB_LOG: stubLog, ...extraEnv,
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
    if (opts.auth) headers.Authorization = opts.auth;
    const res = await fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) for (const part of sc.split(',')) { const m = part.trim().match(/^([^=]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  }
  return { call };
}

function seedInstagram(dataDir, userId) {
  const doc = {
    [userId]: {
      token: 'stub-token', igUserId: '999', username: 'stubuser', tokenHost: 'facebook',
      tokenType: 'SYSTEM_USER', tokenNeverExpires: true, connectedAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(path.join(dataDir, 'instagram.json'), JSON.stringify(doc, null, 2));
}

function istOffsetString(instantMs) {
  // Format an instant as an ISO string with a +05:30 (IST) offset.
  const shifted = new Date(instantMs + 5.5 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}+05:30`;
}

async function phaseA() {
  console.log('\n=== Phase A: JSON store, stubbed Graph ===');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-v13a-'));
  const stubLog = path.join(dataDir, 'graph.log');
  const base = 'http://127.0.0.1:3102';
  const { server, getLog } = startServer({ port: 3102, dataDir, stubLog });
  try {
    check('A: server boots', await waitUp(base), getLog().slice(-400));
    const A = makeClient(base);
    const B = makeClient(base);
    let r = await A.call('POST', '/api/auth/signup', { email: 'a@v13.test', password: 'password123' });
    check('A: signup A', r.status === 200 && !!r.data.user?.id, JSON.stringify(r.data));
    const userA = r.data.user.id;
    r = await B.call('POST', '/api/auth/signup', { email: 'b@v13.test', password: 'password123' });
    check('A: signup B', r.status === 200 && !!r.data.user?.id);
    seedInstagram(dataDir, userA);

    const publishCount = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').split('\n').filter((l) => l.includes('media_publish')).length : 0);

    // --- web media operations (the website's Media feature set) ---
    r = await A.call('POST', '/api/media/upload', { name: 'bridge.png', dataUrl: PNG_DATA_URL, folder: 'Uploads' });
    check('A: single-shot upload ok', r.status === 200 && !!r.data.media?.id, JSON.stringify(r.data).slice(0, 200));
    const item1 = r.data.media;
    r = await A.call('GET', '/api/media?limit=500');
    check('A: library lists the upload', (r.data.media || []).some((m) => m.id === item1.id));
    r = await A.call('POST', '/api/media', { url: 'https://example.com/linked.jpg', title: 'Linked', folder: 'Test' });
    check('A: add-by-link ok', r.status === 200 && !!r.data.media?.id);
    r = await B.call('GET', '/api/media?limit=500');
    check('A: user B cannot see A media', (r.data.media || []).length === 0, `got ${(r.data.media || []).length}`);

    // --- guaranteed flow: due post publishes through the normal path ---
    r = await A.call('POST', '/api/posts', { mediaUrl: item1.url, mediaType: 'image', caption: 'bridge post', scheduleTime: new Date(Date.now() - 60000).toISOString(), status: 'scheduled', format: 'FEED' });
    check('A: due post created', r.status === 200 && !!r.data.post?.id, JSON.stringify(r.data).slice(0, 200));
    const post1 = r.data.post;
    const before = publishCount();
    r = await A.call('POST', '/api/publish-due', {});
    check('A: publish-due publishes the due post', r.status === 200 && (r.data.published || []).some((p) => p.id === post1.id), JSON.stringify(r.data).slice(0, 300));
    check('A: exactly one media_publish call', publishCount() - before === 1, `delta ${publishCount() - before}`);
    r = await A.call('GET', '/api/posts?limit=500');
    const p1 = (r.data.posts || []).find((p) => p.id === post1.id);
    check('A: post is published with live URL', p1?.status === 'published' && /instagram\.com\/p\/STUBPOST/.test(p1?.liveUrl || ''), JSON.stringify(p1).slice(0, 200));

    // --- post-publish auto-delete (db store) ---
    const fileRes = await fetch(`${base}${new URL(item1.url).pathname}`);
    check('A: bridge copy auto-deleted after publish', fileRes.status === 404, `got ${fileRes.status}`);
    await fileRes.text().catch(() => {});
    r = await A.call('GET', '/api/media?limit=500');
    const it1 = (r.data.media || []).find((m) => m.id === item1.id);
    check('A: library item marked serverCopyRemoved', it1?.serverCopyRemoved === true);

    // --- keep-server-copy ON keeps the copy ---
    r = await A.call('POST', '/api/settings', { keepServerCopyAfterPublish: true });
    check('A: keepServerCopy setting saved', r.status === 200 && r.data.keepServerCopyAfterPublish === true, JSON.stringify(r.data).slice(0, 200));
    r = await A.call('POST', '/api/media/upload', { name: 'keep.png', dataUrl: PNG_DATA_URL });
    const item2 = r.data.media;
    r = await A.call('POST', '/api/posts', { mediaUrl: item2.url, mediaType: 'image', caption: 'keep copy', scheduleTime: new Date(Date.now() - 60000).toISOString(), status: 'scheduled', format: 'FEED' });
    const post2 = r.data.post;
    r = await A.call('POST', '/api/publish-due', {});
    check('A: second post publishes', (r.data.published || []).some((p) => p.id === post2.id), JSON.stringify(r.data).slice(0, 200));
    const keptRes = await fetch(`${base}${new URL(item2.url).pathname}`);
    check('A: keepServerCopy ON keeps the bridge copy', keptRes.status === 200, `got ${keptRes.status}`);
    await keptRes.arrayBuffer().catch(() => {});
    await A.call('POST', '/api/settings', { keepServerCopyAfterPublish: false });

    // --- sequential duplicate publish-due does not double-post ---
    r = await A.call('POST', '/api/posts', { mediaUrl: item2.url, mediaType: 'image', caption: 'dup seq', scheduleTime: new Date(Date.now() - 60000).toISOString(), status: 'scheduled', format: 'FEED' });
    const post3 = r.data.post;
    const b3 = publishCount();
    await A.call('POST', '/api/publish-due', {});
    r = await A.call('POST', '/api/publish-due', {});
    check('A: second publish-due finds nothing due', r.status === 200 && r.data.due === 0, JSON.stringify(r.data).slice(0, 200));
    check('A: sequential duplicate -> still one publish', publishCount() - b3 === 1, `delta ${publishCount() - b3}`);

    // --- concurrent publish-due does not double-post (in-flight guard) ---
    r = await A.call('POST', '/api/posts', { mediaUrl: item2.url, mediaType: 'image', caption: 'dup conc', scheduleTime: new Date(Date.now() - 60000).toISOString(), status: 'scheduled', format: 'FEED' });
    const post4 = r.data.post;
    const b4 = publishCount();
    await Promise.all([A.call('POST', '/api/publish-due', {}), A.call('POST', '/api/publish-due', {})]);
    check('A: concurrent publish-due -> one publish only', publishCount() - b4 === 1, `delta ${publishCount() - b4}`);
    r = await A.call('GET', '/api/posts?limit=500');
    const p4 = (r.data.posts || []).find((p) => p.id === post4.id);
    check('A: concurrent post ends published once', p4?.status === 'published' && (p4?.publishAttempts || 0) >= 1, JSON.stringify(p4).slice(0, 200));

    // --- cron publish-due also publishes a due post exactly once ---
    r = await A.call('POST', '/api/posts', { mediaUrl: item2.url, mediaType: 'image', caption: 'cron post', scheduleTime: new Date(Date.now() - 60000).toISOString(), status: 'scheduled', format: 'FEED' });
    const post5 = r.data.post;
    const b5 = publishCount();
    r = await A.call('POST', '/api/cron/publish-due', {}, { auth: 'Bearer v13-cron-secret' });
    const mine = (r.data.summary || []).find((s) => s.userId === userA);
    check('A: cron publishes the due post', r.status === 200 && mine && mine.published === 1, JSON.stringify(r.data).slice(0, 300));
    check('A: cron -> one publish call', publishCount() - b5 === 1, `delta ${publishCount() - b5}`);

    // --- timezone: an IST-offset schedule time is the same instant ---
    const pastInstant = Date.now() - 5 * 60000;
    r = await A.call('POST', '/api/posts', { mediaUrl: item2.url, mediaType: 'image', caption: 'tz past', scheduleTime: istOffsetString(pastInstant), status: 'scheduled', format: 'FEED' });
    check('A: IST-offset time stored as the same instant', r.status === 200 && Math.abs(new Date(r.data.post.scheduleTime).getTime() - pastInstant) < 1500, `stored ${r.data.post?.scheduleTime}`);
    const postTz = r.data.post;
    r = await A.call('POST', '/api/publish-due', {});
    check('A: IST past post is due and publishes', (r.data.published || []).some((p) => p.id === postTz.id), JSON.stringify(r.data).slice(0, 200));
    const futureInstant = Date.now() + 3600000;
    r = await A.call('POST', '/api/posts', { mediaUrl: item2.url, mediaType: 'image', caption: 'tz future', scheduleTime: istOffsetString(futureInstant), status: 'scheduled', format: 'FEED' });
    const postTzF = r.data.post;
    r = await A.call('POST', '/api/publish-due', {});
    check('A: IST future post is NOT due', !(r.data.published || []).some((p) => p.id === postTzF.id) && r.data.due === 0, JSON.stringify(r.data).slice(0, 200));

    // --- chunked upload: missing chunk fails cleanly, no orphan item ---
    r = await A.call('POST', '/api/media/upload/init', { name: 'big.mp4', size: 3 * 1024 * 1024 + 100, contentType: 'video/mp4' });
    check('A: chunked init ok', r.status === 200 && !!r.data.uploadId, JSON.stringify(r.data).slice(0, 200));
    const upId = r.data.uploadId;
    const chunk0 = Buffer.alloc(3 * 1024 * 1024, 7);
    r = await A.call('POST', '/api/media/upload/chunk', { uploadId: upId, index: 0, dataUrl: `data:video/mp4;base64,${chunk0.toString('base64')}` });
    check('A: chunk 0 accepted', r.status === 200 && r.data.received === 1, JSON.stringify(r.data).slice(0, 200));
    r = await A.call('POST', '/api/media/upload/complete', { uploadId: upId });
    check('A: complete with missing chunk -> 400', r.status === 400, `got ${r.status}`);
    r = await A.call('GET', '/api/media?limit=500');
    check('A: no orphan library item from the broken upload', !(r.data.media || []).some((m) => m.title === 'big.mp4'));
    r = await A.call('DELETE', `/api/media/upload/${upId}`);
    check('A: aborted session cleans up', r.status === 200, `got ${r.status}`);

    // --- 200 MB cap at init ---
    r = await A.call('POST', '/api/media/upload/init', { name: 'huge.mp4', size: 200 * 1024 * 1024 + 1, contentType: 'video/mp4' });
    check('A: init over 200 MB -> 413', r.status === 413, `got ${r.status}`);

    // --- chunked upload happy path (small file, byte-identical) ---
    const payload = Buffer.alloc(100 * 1024, 0);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    r = await A.call('POST', '/api/media/upload/init', { name: 'chunked.mp4', size: payload.length, contentType: 'video/mp4' });
    const up2 = r.data.uploadId;
    r = await A.call('POST', '/api/media/upload/chunk', { uploadId: up2, index: 0, dataUrl: `data:video/mp4;base64,${payload.toString('base64')}` });
    r = await A.call('POST', '/api/media/upload/complete', { uploadId: up2 });
    check('A: chunked complete ok', r.status === 200 && !!r.data.media?.id, JSON.stringify(r.data).slice(0, 200));
    const chunkedItem = r.data.media;
    const got = await fetch(`${base}${new URL(chunkedItem.url).pathname}`);
    const gotBuf = Buffer.from(await got.arrayBuffer());
    check('A: chunked bytes identical', got.status === 200 && sha(gotBuf) === sha(payload));

    // --- bulk import still works (Bulk tab backend) ---
    r = await A.call('POST', '/api/posts/bulk', { posts: [
      { mediaUrl: 'https://example.com/x1.mp4', caption: 'Bulk A', scheduleTime: new Date(Date.now() + 7200000).toISOString(), status: 'scheduled' },
      { mediaUrl: 'https://example.com/x2.mp4', caption: 'Bulk B', scheduleTime: new Date(Date.now() + 10800000).toISOString(), status: 'scheduled' },
    ] });
    check('A: bulk import 2 ok', r.status === 200 && r.data.imported === 2, JSON.stringify(r.data).slice(0, 200));
  } finally {
    try { server.kill('SIGTERM'); } catch { /* already dead */ }
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function phaseB() {
  console.log('\n=== Phase B: OCI Object Storage bridge ===');
  const hf = path.join(os.homedir(), 'workspace/goals/personal-instagram-scheduler-byvano-style-upgrade/hidden_files');
  const readBaseFile = path.join(hf, 'oci_par_base.txt');
  const writeBaseFile = path.join(hf, 'oci_par_write_base.txt');
  const pemFile = path.join(hf, 'oci_api_key.pem');
  if (![readBaseFile, writeBaseFile, pemFile].every((f) => fs.existsSync(f))) {
    console.log('SKIP Phase B — OCI hidden files not present in this environment');
    return;
  }
  const ociApi = fs.readFileSync(path.join(hf, 'oci_api.py'), 'utf8');
  const grab = (name) => { const m = ociApi.match(new RegExp(`${name} = "([^"]+)"`)); return m ? m[1] : ''; };
  const env = {
    MEDIA_OCI_READ_BASE: fs.readFileSync(readBaseFile, 'utf8').trim(),
    MEDIA_OCI_WRITE_BASE: fs.readFileSync(writeBaseFile, 'utf8').trim(),
    MEDIA_OCI_API_KEY_PEM: fs.readFileSync(pemFile, 'utf8'),
    MEDIA_OCI_TENANCY_OCID: grab('TENANCY'),
    MEDIA_OCI_USER_OCID: grab('USER'),
    MEDIA_OCI_FINGERPRINT: grab('FINGERPRINT'),
    MEDIA_OCI_NAMESPACE: grab('NAMESPACE'),
    MEDIA_OCI_BUCKET: grab('BUCKET'),
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-v13b-'));
  const stubLog = path.join(dataDir, 'graph.log');
  const base = 'http://127.0.0.1:3103';
  const { server, getLog } = startServer({ port: 3103, dataDir, stubLog, extraEnv: env });
  try {
    check('B: server boots', await waitUp(base), getLog().slice(-400));
    const C = makeClient(base);
    let r = await C.call('POST', '/api/auth/signup', { email: 'c@v13.test', password: 'password123' });
    check('B: signup C', r.status === 200 && !!r.data.user?.id, JSON.stringify(r.data).slice(0, 200));
    seedInstagram(dataDir, r.data.user.id);

    r = await C.call('POST', '/api/media/upload', { name: 'oci-bridge.png', dataUrl: PNG_DATA_URL });
    check('B: upload lands in OCI', r.status === 200 && r.data.media?.storage === 'oci', JSON.stringify(r.data).slice(0, 200));
    const item = r.data.media;
    let objRes = await fetch(item.url);
    const objBuf = Buffer.from(await objRes.arrayBuffer());
    check('B: bridge copy fetchable via read URL, bytes identical', objRes.status === 200 && sha(objBuf) === sha(PNG), `got ${objRes.status}`);

    r = await C.call('POST', '/api/posts', { mediaUrl: item.url, mediaType: 'image', caption: 'oci post', scheduleTime: new Date(Date.now() - 60000).toISOString(), status: 'scheduled', format: 'FEED' });
    const post = r.data.post;
    r = await C.call('POST', '/api/publish-due', {});
    check('B: post publishes from the OCI copy', (r.data.published || []).some((p) => p.id === post.id), JSON.stringify(r.data).slice(0, 300));

    // Signed delete after publish: the object must be gone (allow brief
    // propagation retries before declaring failure).
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      const res = await fetch(item.url);
      await res.arrayBuffer().catch(() => {});
      gone = res.status === 404;
      if (!gone) await sleep(1500);
    }
    check('B: OCI object auto-deleted after publish (read URL 404)', gone);
    r = await C.call('GET', '/api/media?limit=500');
    const itB = (r.data.media || []).find((m) => m.id === item.id);
    check('B: library item marked serverCopyRemoved', itB?.serverCopyRemoved === true);

    // keep-server-copy ON: object survives the publish; manual delete removes it.
    await C.call('POST', '/api/settings', { keepServerCopyAfterPublish: true });
    r = await C.call('POST', '/api/media/upload', { name: 'oci-keep.png', dataUrl: PNG_DATA_URL });
    const item2 = r.data.media;
    r = await C.call('POST', '/api/posts', { mediaUrl: item2.url, mediaType: 'image', caption: 'oci keep', scheduleTime: new Date(Date.now() - 60000).toISOString(), status: 'scheduled', format: 'FEED' });
    const post2 = r.data.post;
    r = await C.call('POST', '/api/publish-due', {});
    check('B: keep-copy post publishes', (r.data.published || []).some((p) => p.id === post2.id), JSON.stringify(r.data).slice(0, 200));
    objRes = await fetch(item2.url);
    await objRes.arrayBuffer().catch(() => {});
    check('B: keepServerCopy ON keeps the OCI object', objRes.status === 200, `got ${objRes.status}`);
    r = await C.call('DELETE', `/api/media/${item2.id}`);
    check('B: manual library delete ok', r.status === 200, `got ${r.status}`);
    let gone2 = false;
    for (let i = 0; i < 6 && !gone2; i++) {
      const res = await fetch(item2.url);
      await res.arrayBuffer().catch(() => {});
      gone2 = res.status === 404;
      if (!gone2) await sleep(1500);
    }
    check('B: manual delete removes the OCI object', gone2);
  } finally {
    try { server.kill('SIGTERM'); } catch { /* already dead */ }
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Phase C: the production OCI-delete bug — signing variables sourced
// from environment variables (Vercel-style) must still delete. Each
// variant boots a fresh server whose MEDIA_OCI_API_KEY_PEM is stored
// in a different shape; the app-level delete (DELETE /api/media/:id)
// must remove the real bucket object with NO warning in the response.
// A garbage-PEM negative control must do the opposite: warn loudly,
// log '[oci]', and leave the object in place (cleaned up afterwards
// through the signed API helper).
async function phaseC() {
  console.log('\n=== Phase C: OCI delete with env-sourced PEM variants ===');
  const { execFile } = require('child_process');
  const hf = path.join(os.homedir(), 'workspace/goals/personal-instagram-scheduler-byvano-style-upgrade/hidden_files');
  const readBaseFile = path.join(hf, 'oci_par_base.txt');
  const writeBaseFile = path.join(hf, 'oci_par_write_base.txt');
  const pemFile = path.join(hf, 'oci_api_key.pem');
  if (![readBaseFile, writeBaseFile, pemFile].every((f) => fs.existsSync(f))) {
    console.log('SKIP Phase C — OCI hidden files not present in this environment');
    return;
  }
  const ociApi = fs.readFileSync(path.join(hf, 'oci_api.py'), 'utf8');
  const grab = (name) => { const m = ociApi.match(new RegExp(`${name} = "([^"]+)"`)); return m ? m[1] : ''; };
  const pemReal = fs.readFileSync(pemFile, 'utf8');
  const baseEnv = {
    MEDIA_OCI_READ_BASE: fs.readFileSync(readBaseFile, 'utf8').trim(),
    MEDIA_OCI_WRITE_BASE: fs.readFileSync(writeBaseFile, 'utf8').trim(),
    MEDIA_OCI_TENANCY_OCID: grab('TENANCY'),
    MEDIA_OCI_USER_OCID: grab('USER'),
    MEDIA_OCI_FINGERPRINT: grab('FINGERPRINT'),
    MEDIA_OCI_NAMESPACE: grab('NAMESPACE'),
    MEDIA_OCI_BUCKET: grab('BUCKET'),
  };
  const variants = [
    ['real newlines (control)', pemReal],
    ['literal backslash-n escapes', pemReal.replace(/\n/g, '\\n')],
    ['CRLF line endings', pemReal.replace(/\n/g, '\r\n')],
    ['no trailing newline', pemReal.replace(/\n+$/, '')],
    ['collapsed single-line body', `-----BEGIN PRIVATE KEY-----${pemReal.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')}-----END PRIVATE KEY-----`],
  ];
  let port = 3110;
  for (const [name, pem] of variants) {
    port++;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-v13c-'));
    const base = `http://127.0.0.1:${port}`;
    const { server } = startServer({ port, dataDir, stubLog: path.join(dataDir, 'graph.log'), extraEnv: { ...baseEnv, MEDIA_OCI_API_KEY_PEM: pem } });
    try {
      const up = await waitUp(base);
      const C = makeClient(base);
      let r = await C.call('POST', '/api/auth/signup', { email: `c${port}@v13.test`, password: 'password123' });
      r = await C.call('POST', '/api/media/upload', { name: 'variant.png', dataUrl: PNG_DATA_URL });
      const item = r.data.media;
      check(`C: upload ok (${name})`, up && r.status === 200 && item?.storage === 'oci', JSON.stringify(r.data).slice(0, 150));
      r = await C.call('DELETE', `/api/media/${item.id}`);
      check(`C: delete response has NO warning (${name})`, r.status === 200 && !r.data.warning, JSON.stringify(r.data).slice(0, 200));
      let gone = false;
      for (let i = 0; i < 6 && !gone; i++) {
        const res = await fetch(item.url);
        await res.arrayBuffer().catch(() => {});
        gone = res.status === 404;
        if (!gone) await sleep(1200);
      }
      check(`C: object actually deleted (${name})`, gone);
    } finally {
      try { server.kill('SIGTERM'); } catch { /* dead */ }
      await sleep(300);
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  // Negative control: a garbage PEM must fail LOUDLY, never silently.
  port++;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-v13c-'));
  const base = `http://127.0.0.1:${port}`;
  const { server, getLog } = startServer({ port, dataDir, stubLog: path.join(dataDir, 'graph.log'), extraEnv: { ...baseEnv, MEDIA_OCI_API_KEY_PEM: 'not-a-real-key' } });
  try {
    await waitUp(base);
    const C = makeClient(base);
    await C.call('POST', '/api/auth/signup', { email: `c${port}@v13.test`, password: 'password123' });
    let r = await C.call('POST', '/api/media/upload', { name: 'orphan.png', dataUrl: PNG_DATA_URL });
    const item = r.data.media;
    check('C: upload ok (garbage PEM control)', r.status === 200 && item?.storage === 'oci');
    r = await C.call('DELETE', `/api/media/${item.id}`);
    check('C: garbage PEM -> delete response WARNS', r.status === 200 && typeof r.data.warning === 'string' && r.data.warning.length > 0, JSON.stringify(r.data).slice(0, 200));
    const res = await fetch(item.url);
    await res.arrayBuffer().catch(() => {});
    check('C: garbage PEM -> object survives (no silent fake success)', res.status === 200, `got ${res.status}`);
    check('C: garbage PEM -> server logged the [oci] failure', getLog().includes('[oci]'), getLog().slice(-300));
    // Cleanup the deliberate orphan through the signed API helper.
    const status = await new Promise((resolve) => {
      const code = `import sys; sys.path.insert(0, ${JSON.stringify(hf)}); import oci_api; s, _, _ = oci_api.request('DELETE', 'https://objectstorage.ap-mumbai-1.oraclecloud.com/n/${grab('NAMESPACE')}/b/${grab('BUCKET')}/o/${item.objectName}'); print(s)`;
      execFile('python3', ['-c', code], (err, stdout) => resolve(err ? 'error' : String(stdout).trim()));
    });
    check('C: orphan cleaned up via signed API', status === '204' || status === '404', `got ${status}`);
  } finally {
    try { server.kill('SIGTERM'); } catch { /* dead */ }
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

(async () => {
  await phaseA();
  await phaseB();
  await phaseC();
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
