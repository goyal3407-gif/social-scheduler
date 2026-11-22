// Bug-hunt fix-round regression checks (2026-11-17).
//
// Boots the real server against an isolated JSON data dir (no MongoDB)
// with the Instagram Graph API stubbed at the fetch layer (same pattern
// as scripts/v13-autobridge-test.js), and verifies each confirmed bug
// from BUG_HUNT_2026-11-17.md that this round fixes:
//   M1 publish status guard · L1 connect-link single use ·
//   L2 chunked complete expiry · L3 uppercase data URL ·
//   L4 signup email length cap · L5 generic duplicate-signup message ·
//   L6 login timing oracle · L7 post status/liveUrl server-owned ·
//   L8 db-status fresh user count · L9 JSON 404 for unknown /api ·
//   L10 settings array body / media size typing · L11 Origin "null".
// (M2 static headers are a vercel.json change — verified live with
// curl after deploy, not here. Bug-hunt L2 magic bytes was not in this
// round's fix list.)
//
// Run: node scripts/bughunt-fix-test.js
// Exits non-zero if any check fails. No secrets are printed.
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
    if (u.includes('oauth/access_token') || u.includes('refresh_access_token')) return json({ access_token: 'stub-access-token', expires_in: 5184000 });
    if (method === 'POST' && u.includes('media_publish')) return json({ id: 'igmedia-stub-1' });
    if (method === 'POST' && /\\/media(\\?|$)/.test(u)) return json({ id: 'ctr-stub-1' });
    if (u.includes('fields=status_code')) return json({ status_code: 'FINISHED' });
    if (u.includes('fields=permalink')) return json({ permalink: 'https://www.instagram.com/p/STUBPOST/', media_type: 'VIDEO' });
    return json({ id: '999', username: 'stubuser' });
  }
  return origFetch(url, opts);
};
`;

const PORT = 3107;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-fix-'));
const STUB_LOG = path.join(DATA_DIR, 'graph.log');

function makeClient() {
  const jar = {};
  async function call(method, p, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;
    if (opts.origin !== undefined) headers.Origin = opts.origin;
    const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) for (const part of sc.split(',')) { const m = part.trim().match(/^([^=]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data, headers: res.headers };
  }
  return { call };
}

async function main() {
  const stubPath = path.join(DATA_DIR, 'graph-stub.cjs');
  fs.writeFileSync(stubPath, STUB_SOURCE);
  const server = spawn('node', ['--require', stubPath, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR,
      SESSION_SECRET: 'fix-test-secret-0123456789abcdef0123456789',
      NODE_ENV: 'test', CRON_SECRET: 'fix-test-cron-secret', GRAPH_STUB_LOG: STUB_LOG,
      // Dummy value so the Unified Login dialog path is reachable
      // (ig-connect answers a "nearly ready" page without it).
      META_APP_SECRET: 'fix-test-meta-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const stop = () => { try { server.kill('SIGTERM'); } catch { /* already dead */ } };
  process.on('exit', stop);

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(`${BASE}/api/health`); up = r.ok; } catch { await sleep(250); }
  }
  check('server boots', up, serverLog.slice(-300));
  if (!up) { console.log(serverLog); process.exit(1); }

  const publishCount = () => (fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, 'utf8').split('\n').filter((l) => l.includes('media_publish')).length : 0);

  const A = makeClient();
  let r = await A.call('POST', '/api/auth/signup', { email: 'a@fix.test', password: 'Kilua-Test-9871' });
  check('signup A', r.status === 200 && !!r.data.user?.id, JSON.stringify(r.data));
  const userA = r.data.user.id;

  // L4: over-length email -> 400
  const longEmail = `${'a'.repeat(280)}@example.com`;
  r = await A.call('POST', '/api/auth/signup', { email: longEmail, password: 'Kilua-Test-9871' });
  check('L4: 292-char email -> 400', r.status === 400, `got ${r.status}`);

  // L5: duplicate signup -> 409 with a generic message; no second account
  r = await A.call('POST', '/api/auth/signup', { email: 'A@fix.test', password: 'different99' });
  check('L5: duplicate signup -> 409', r.status === 409, `got ${r.status}`);
  check('L5: message does not confirm the email is registered', !/already exists/i.test(r.data?.error || ''), r.data?.error || '');
  const D = makeClient();
  r = await D.call('POST', '/api/auth/login', { email: 'a@fix.test', password: 'different99' });
  check('L5: duplicate signup did not overwrite the account', r.status === 401, `got ${r.status}`);

  // L6: login timing — nonexistent email must cost a scrypt too
  const E = makeClient();
  const t0 = Date.now();
  r = await E.call('POST', '/api/auth/login', { email: 'ghost@fix.test', password: 'whatever123' });
  const tGhost = Date.now() - t0;
  check('L6: nonexistent login -> 401', r.status === 401, `got ${r.status}`);
  check('L6: nonexistent login takes scrypt-scale time (>= 20 ms)', tGhost >= 20, `took ${tGhost} ms`);
  const t1 = Date.now();
  const r2 = await E.call('POST', '/api/auth/login', { email: 'a@fix.test', password: 'wrongpass99' });
  const tReal = Date.now() - t1;
  check('L6: wrong-password login -> 401 with identical error body', r2.status === 401 && r2.data?.error === r.data?.error, JSON.stringify(r2.data));

  // Seed a stored Instagram connection for A (JSON store, as v13 does).
  fs.writeFileSync(path.join(DATA_DIR, 'instagram.json'), JSON.stringify({
    [userA]: {
      token: 'stub-token', igUserId: '999', username: 'stubuser', tokenHost: 'facebook',
      tokenType: 'SYSTEM_USER', tokenNeverExpires: true, connectedAt: new Date().toISOString(),
    },
  }, null, 2));

  // M1: publish once (ok), publish again -> 409, status stays published
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/pic.jpg', mediaType: 'image', caption: 'm1', scheduleTime: new Date(Date.now() - 60000).toISOString(), format: 'FEED' });
  check('M1: post created', r.status === 200 && !!r.data.post?.id, JSON.stringify(r.data).slice(0, 200));
  const postId = r.data.post.id;
  const pubBefore = publishCount();
  r = await A.call('POST', `/api/posts/${postId}/publish`, {});
  check('M1: first publish succeeds', r.status === 200 && r.data?.ok === true, JSON.stringify(r.data).slice(0, 200));
  r = await A.call('GET', '/api/posts?limit=500');
  const pAfter1 = (r.data.posts || []).find((p) => p.id === postId);
  check('M1: post is published', pAfter1?.status === 'published', pAfter1?.status || '');
  r = await A.call('POST', `/api/posts/${postId}/publish`, {});
  check('M1: second publish -> 409', r.status === 409, `got ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  r = await A.call('GET', '/api/posts?limit=500');
  const pAfter2 = (r.data.posts || []).find((p) => p.id === postId);
  check('M1: status stays published after refused re-publish', pAfter2?.status === 'published', pAfter2?.status || '');
  check('M1: publishAttempts unchanged by refused re-publish', pAfter2?.publishAttempts === pAfter1?.publishAttempts, `${pAfter1?.publishAttempts} -> ${pAfter2?.publishAttempts}`);
  check('M1: exactly one media_publish call overall', publishCount() - pubBefore === 1, `delta ${publishCount() - pubBefore}`);

  // L7: create with status/liveUrl is coerced; PATCH cannot set them
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/x.jpg', mediaType: 'image', caption: 'l7', status: 'published', liveUrl: 'https://evil.example.com/fake' });
  check('L7: create accepts the request', r.status === 200, `got ${r.status}`);
  check('L7: created post is NOT published', r.data.post?.status === 'scheduled', r.data.post?.status || '');
  check('L7: created post liveUrl is empty', (r.data.post?.liveUrl || '') === '', r.data.post?.liveUrl || '');
  const l7id = r.data.post.id;
  r = await A.call('PATCH', `/api/posts/${l7id}`, { status: 'published', liveUrl: 'https://evil.example.com/fake2' });
  check('L7: PATCH answers ok', r.status === 200, `got ${r.status}`);
  check('L7: PATCH cannot set status published', r.data.post?.status === 'scheduled', r.data.post?.status || '');
  check('L7: PATCH cannot set liveUrl', (r.data.post?.liveUrl || '') === '', r.data.post?.liveUrl || '');
  r = await A.call('PATCH', `/api/posts/${l7id}`, { status: 'draft' });
  check('L7: PATCH draft (legit Studio edit) still works', r.status === 200 && r.data.post?.status === 'draft', JSON.stringify(r.data).slice(0, 150));

  // L1: connect link is single-use (both connect flows)
  for (const [mintPath, label] of [['/api/instagram/connect-link', 'connect'], ['/api/instagram/ig-connect-link', 'ig-connect']]) {
    r = await A.call('POST', mintPath, {});
    check(`L1: ${label} link minted`, r.status === 200 && !!r.data.url, JSON.stringify(r.data).slice(0, 150));
    const linkPath = new URL(r.data.url).pathname + new URL(r.data.url).search;
    const first = await fetch(`${BASE}${linkPath}`, { redirect: 'manual' });
    check(`L1: ${label} first use -> 302 to Meta dialog`, first.status === 302 && (first.headers.get('location') || '').includes('facebook.com'), `got ${first.status} ${first.headers.get('location') || ''}`);
    const second = await fetch(`${BASE}${linkPath}`, { redirect: 'manual' });
    const secondBody = await second.text();
    check(`L1: ${label} second use -> 401 friendly page`, second.status === 401 && /expired/i.test(secondBody), `got ${second.status}`);
  }

  // L2: chunked complete on an expired session -> 410
  r = await A.call('POST', '/api/media/upload/init', { name: 'clip.mp4', size: PNG.length, contentType: 'video/mp4' });
  check('L2: chunk init ok', r.status === 200 && !!r.data.uploadId, JSON.stringify(r.data).slice(0, 150));
  const uploadId = r.data.uploadId;
  r = await A.call('POST', '/api/media/upload/chunk', { uploadId, index: 0, dataUrl: PNG_DATA_URL });
  check('L2: chunk accepted', r.status === 200, `got ${r.status}`);
  const sessFile = path.join(DATA_DIR, 'upload-sessions.json');
  const sessions = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  for (const s of sessions) if (s.id === uploadId) s.expiresAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(sessFile, JSON.stringify(sessions, null, 2));
  r = await A.call('POST', '/api/media/upload/complete', { uploadId });
  check('L2: complete on expired session -> 410', r.status === 410, `got ${r.status}`);

  // L3: uppercase data URL accepted
  r = await A.call('POST', '/api/media/upload', { name: 'upper.png', dataUrl: `DATA:IMAGE/PNG;BASE64,${PNG.toString('base64')}` });
  check('L3: uppercase data URL -> 200', r.status === 200 && !!r.data.media?.id, `got ${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);

  // L9: unknown /api route and method mismatch -> JSON 404
  r = await A.call('GET', '/api/definitely-not-a-route');
  check('L9: unknown route -> 404 JSON', r.status === 404 && r.data?.ok === false && (r.headers.get('content-type') || '').includes('application/json'), `got ${r.status} ${r.headers.get('content-type')}`);
  r = await A.call('PUT', '/api/posts', {});
  check('L9: method mismatch -> 404 JSON', r.status === 404 && r.data?.ok === false, `got ${r.status}`);

  // L10: settings array body -> 400; media size object -> 400; numeric ok
  r = await A.call('POST', '/api/settings', ['x', 'y']);
  check('L10: settings array body -> 400', r.status === 400, `got ${r.status}`);
  r = await A.call('POST', '/api/media', { url: 'https://example.com/a.jpg', size: { big: 1 } });
  check('L10: media object size -> 400', r.status === 400, `got ${r.status}`);
  r = await A.call('POST', '/api/media', { url: 'https://example.com/a.jpg', size: 12345 });
  check('L10: media numeric size -> 200 and stored as number', r.status === 200 && r.data.media?.size === 12345, `got ${r.status} ${JSON.stringify(r.data).slice(0, 150)}`);

  // L11: unparseable Origin on a state-changing request -> 403
  r = await E.call('POST', '/api/auth/login', { email: 'a@fix.test', password: 'Kilua-Test-9871' }, { origin: 'null' });
  check('L11: Origin "null" -> 403', r.status === 403, `got ${r.status}`);
  r = await E.call('POST', '/api/auth/login', { email: 'a@fix.test', password: 'Kilua-Test-9871' }, { origin: 'https://evil.example.com' });
  check('L11: foreign Origin -> 403 (unchanged)', r.status === 403, `got ${r.status}`);
  r = await E.call('POST', '/api/auth/login', { email: 'a@fix.test', password: 'Kilua-Test-9871' });
  check('L11: no Origin -> normal login works', r.status === 200, `got ${r.status}`);

  // L8: db-status user count is fresh on the very next call
  r = await A.call('GET', '/api/db-status');
  const count1 = r.data.instagramDiag?.usersScanned;
  const C = makeClient();
  r = await C.call('POST', '/api/auth/signup', { email: 'c@fix.test', password: 'Kilua-Test-9871' });
  check('L8: second user signup ok', r.status === 200, `got ${r.status}`);
  r = await A.call('GET', '/api/db-status');
  const count2 = r.data.instagramDiag?.usersScanned;
  check('L8: usersScanned fresh on next call', count1 === 1 && count2 === 2, `${count1} -> ${count2}`);

  stop();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
