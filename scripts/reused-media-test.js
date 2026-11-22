// KiluaAI reused-media regression suite (the "Band Mandir" fix).
//
// A library item's server copy is deleted after its first publish
// (by design). Before the fix, reusing that item — creating a post
// with its URL, duplicating the published post, rescheduling it, or
// letting a queued post reach publish time — sailed through and then
// died with Instagram's opaque media-fetch error. Now every reuse
// path refuses early with one clear re-upload message, and publish
// time fails the post with that same message without ever calling
// the Graph API.
//
// Boots the real server against an isolated JSON data dir (no
// MongoDB) with the Instagram Graph API stubbed at the fetch layer —
// the same harness as scripts/v13-autobridge-test.js.
//
// Run: node scripts/reused-media-test.js
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


const GONE = 'server copy was removed';

async function main() {
  console.log('\n=== Reused media: dead server copy refused early, everywhere ===');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-reused-'));
  const stubLog = path.join(dataDir, 'graph.log');
  const base = 'http://127.0.0.1:3107';
  const { server, getLog } = startServer({ port: 3107, dataDir, stubLog });
  try {
    check('server boots', await waitUp(base), getLog().slice(-400));
    const A = makeClient(base);
    let r = await A.call('POST', '/api/auth/signup', { email: 'a@reused.test', password: 'Kilua-Test-9871' });
    check('signup A', r.status === 200 && !!r.data.user?.id, JSON.stringify(r.data));
    const userA = r.data.user.id;
    seedInstagram(dataDir, userA);

    const graphLines = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean) : []);
    const publishCount = () => graphLines().filter((l) => l.includes('media_publish')).length;
    const containerCount = () => graphLines().filter((l) => l.startsWith('POST') && /\/media(\?|$)/.test(l) && !l.includes('media_publish')).length;
    const dueBody = (mediaUrl, caption) => ({ mediaUrl, mediaType: 'image', caption, scheduleTime: new Date(Date.now() - 60000).toISOString(), status: 'scheduled', format: 'FEED' });
    const getPost = async (id) => {
      const res = await A.call('GET', '/api/posts?limit=500');
      return (res.data.posts || []).find((p) => p.id === id);
    };

    // --- setup: upload one item, publish it, copy auto-deletes ---
    r = await A.call('POST', '/api/media/upload', { name: 'reuse.png', dataUrl: PNG_DATA_URL, folder: 'Uploads' });
    check('upload ok', r.status === 200 && !!r.data.media?.id, JSON.stringify(r.data).slice(0, 200));
    const item1 = r.data.media;
    r = await A.call('POST', '/api/posts', dueBody(item1.url, 'first use'));
    check('first post created', r.status === 200 && !!r.data.post?.id, JSON.stringify(r.data).slice(0, 200));
    const post1 = r.data.post;
    r = await A.call('POST', '/api/publish-due', {});
    check('first post publishes', (r.data.published || []).some((p) => p.id === post1.id), JSON.stringify(r.data).slice(0, 300));
    const fileRes = await fetch(`${base}${new URL(item1.url).pathname}`);
    check('copy auto-deleted after publish', fileRes.status === 404, `got ${fileRes.status}`);
    await fileRes.text().catch(() => {});
    r = await A.call('GET', '/api/media?limit=500');
    check('item marked serverCopyRemoved', (r.data.media || []).find((m) => m.id === item1.id)?.serverCopyRemoved === true);

    // --- 1. creating a new post with the dead URL is refused ---
    r = await A.call('POST', '/api/posts', dueBody(item1.url, 'reuse attempt'));
    check('create with dead copy -> 400', r.status === 400, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    check('create refusal names the reason', String(r.data?.error || '').includes(GONE), String(r.data?.error || ''));

    // --- 2. duplicating the published post is refused ---
    r = await A.call('POST', `/api/posts/${post1.id}/duplicate`, {});
    check('duplicate of published -> 400', r.status === 400, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    check('duplicate refusal names the reason', String(r.data?.error || '').includes(GONE), String(r.data?.error || ''));

    // --- 3. rescheduling the published post is refused ---
    r = await A.call('POST', `/api/posts/${post1.id}/reschedule`, { addDays: 1 });
    check('reschedule of published -> 400', r.status === 400, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    check('reschedule refusal names the reason', String(r.data?.error || '').includes(GONE), String(r.data?.error || ''));

    // --- 4. a bulk row with the dead URL fails per-row, imports nothing ---
    r = await A.call('POST', '/api/posts/bulk', { posts: [dueBody(item1.url, 'bulk reuse')] });
    check('bulk row refused', r.status === 200 && r.data.imported === 0 && r.data.failed === 1, JSON.stringify(r.data).slice(0, 300));
    check('bulk refusal names the reason', (r.data.errors || []).join(' ').includes(GONE), JSON.stringify(r.data.errors));

    // --- 5. editing a live post onto the dead URL is refused ---
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/linked.jpg', mediaType: 'image', caption: 'link post', scheduleTime: new Date(Date.now() + 3600000).toISOString(), status: 'scheduled', format: 'FEED' });
    check('link-media post created (guard ignores external URLs)', r.status === 200 && !!r.data.post?.id, JSON.stringify(r.data).slice(0, 200));
    const linkPost = r.data.post;
    r = await A.call('PATCH', `/api/posts/${linkPost.id}`, { mediaUrl: item1.url });
    check('PATCH onto dead copy -> 400', r.status === 400, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    check('PATCH refusal names the reason', String(r.data?.error || '').includes(GONE), String(r.data?.error || ''));

    // --- 6. publish time: a queued post whose copy vanished fails
    //        with the clear reason and never calls the Graph API ---
    r = await A.call('POST', '/api/media/upload', { name: 'doomed.png', dataUrl: PNG_DATA_URL });
    const item2 = r.data.media;
    r = await A.call('POST', '/api/posts', { mediaUrl: item2.url, mediaType: 'image', caption: 'doomed post', scheduleTime: new Date(Date.now() + 3600000).toISOString(), status: 'scheduled', format: 'FEED' });
    check('doomed post created while copy alive', r.status === 200 && !!r.data.post?.id, JSON.stringify(r.data).slice(0, 200));
    const doomed = r.data.post;
    r = await A.call('DELETE', `/api/media/${item2.id}`);
    check('library delete removes the item (and its file)', r.status === 200, `got ${r.status}`);
    const pubsBefore = publishCount();
    const ctrsBefore = containerCount();
    r = await A.call('POST', `/api/posts/${doomed.id}/publish`, {});
    check('publish of dead copy is not ok', r.data?.ok === false, JSON.stringify(r.data).slice(0, 300));
    check('publish failure names the reason', String(r.data?.error || '').includes(GONE), String(r.data?.error || ''));
    check('no Graph publish attempted', publishCount() === pubsBefore && containerCount() === ctrsBefore, `pubs ${pubsBefore}->${publishCount()}, ctrs ${ctrsBefore}->${containerCount()}`);
    const dp = await getPost(doomed.id);
    check('doomed post ends failed with the reason kept', dp?.status === 'failed' && JSON.stringify(dp).includes(GONE), JSON.stringify(dp).slice(0, 300));

    // --- 7. two queued posts sharing ONE item still both publish
    //        (the copy is kept until every referencing post is done) ---
    r = await A.call('POST', '/api/media/upload', { name: 'shared.png', dataUrl: PNG_DATA_URL });
    const item3 = r.data.media;
    r = await A.call('POST', '/api/posts', dueBody(item3.url, 'shared one'));
    const shared1 = r.data.post;
    r = await A.call('POST', '/api/posts', dueBody(item3.url, 'shared two'));
    const shared2 = r.data.post;
    const sb = publishCount();
    r = await A.call('POST', '/api/publish-due', {});
    check('both shared-copy posts publish', (r.data.published || []).some((p) => p.id === shared1.id) && (r.data.published || []).some((p) => p.id === shared2.id), JSON.stringify(r.data).slice(0, 300));
    check('exactly two publishes for the shared copy', publishCount() - sb === 2, `delta ${publishCount() - sb}`);
    const sharedRes = await fetch(`${base}${new URL(item3.url).pathname}`);
    check('shared copy deleted once both are done', sharedRes.status === 404, `got ${sharedRes.status}`);
    await sharedRes.text().catch(() => {});
  } finally {
    try { server.kill('SIGTERM'); } catch { /* dead */ }
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

(async () => {
  await main();
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
