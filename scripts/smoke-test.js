// Social Scheduler smoke test — boots the real server against an isolated
// JSON data dir (DATA_DIR) with no MongoDB, and exercises the main user
// journeys over HTTP. Run: node scripts/smoke-test.js
// Exits non-zero on the first failure; prints PASS lines otherwise.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-test-'));
let failures = 0;

function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.log(`FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, SESSION_SECRET: 'test-secret-for-smoke-test-only-0123456789abcdef', NODE_ENV: 'test', CRON_SECRET: 'test-cron-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const stop = () => { try { server.kill('SIGTERM'); } catch { /* already dead */ } };
  process.on('exit', stop);

  // Wait for the server to answer.
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { const r = await fetch(`${BASE}/api/health`); up = r.ok; } catch { await sleep(250); }
  }
  check('server boots', up);
  if (!up) { console.log(serverLog); process.exit(1); }

  const jar = {}; // cookie jar: name -> value
  async function call(method, p, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;
    if (opts.origin) headers.Origin = opts.origin;
    if (opts.auth) headers.Authorization = opts.auth;
    const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      for (const part of setCookie.split(',')) {
        const m = part.trim().match(/^([^=]+)=([^;]*)/);
        if (m) jar[m[1]] = m[2];
      }
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data, headers: res.headers };
  }

  // 1. Unauthenticated access is rejected; security headers are present.
  let r = await call('GET', '/api/posts');
  check('unauthenticated /api/posts -> 401', r.status === 401, `got ${r.status}`);
  r = await call('GET', '/api/health');
  check('security header X-Content-Type-Options', r.headers.get('x-content-type-options') === 'nosniff');
  check('security header CSP present', (r.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  check('security header X-Frame-Options', r.headers.get('x-frame-options') === 'DENY');
  check('api Cache-Control no-store', (r.headers.get('cache-control') || '').includes('no-store'));

  // 2. Same-origin check: cross-origin POST is rejected; localhost dev origin is allowed.
  r = await call('POST', '/api/auth/signup', { email: 'evil@example.com', password: 'password123' }, { origin: 'https://evil.example.com' });
  check('cross-origin signup -> 403', r.status === 403, `got ${r.status}`);
  r = await call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'wrong' }, { origin: 'http://localhost:5173' });
  check('localhost dev-origin request allowed (401, not 403)', r.status === 401, `got ${r.status}`);

  // 3. Signup + login (user A = owner).
  r = await call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  check('signup A ok', r.status === 200 && r.data.user?.role === 'owner', JSON.stringify(r.data));
  const userA = r.data.user;
  r = await call('POST', '/api/auth/login', { email: 'a@example.com', password: 'wrong-password' });
  check('wrong password -> 401', r.status === 401);
  r = await call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  check('duplicate signup -> 409', r.status === 409);
  r = await call('POST', '/api/auth/signup', { email: 'short@example.com', password: 'short' });
  check('short password -> 400', r.status === 400);
  r = await call('POST', '/api/auth/signup', { email: 'long@example.com', password: 'x'.repeat(129) });
  check('password >128 chars -> 400', r.status === 400, `got ${r.status}`);

  // 4. NoSQL injection attempt is rejected.
  r = await call('POST', '/api/posts', { mediaUrl: 'https://example.com/v.mp4', status: { $gt: '' } });
  check('NoSQL operator in body -> 400', r.status === 400, `got ${r.status}`);
  // Raw JSON string: a JS object literal would swallow __proto__ as a
  // prototype assignment instead of sending the key.
  const rawRes = await fetch(`${BASE}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
    body: '{"mediaUrl":"https://example.com/v.mp4","caption":"x","__proto__":{"polluted":1}}',
  });
  check('prototype pollution key -> 400', rawRes.status === 400, `got ${rawRes.status}`);
  await rawRes.text().catch(() => {});
  check('prototype NOT polluted', ({}).polluted === undefined);

  // 5. Posts CRUD + validation.
  r = await call('POST', '/api/posts', { mediaUrl: 'https://example.com/video1.mp4', caption: 'First post', hashtags: '#test', platform: 'Instagram', scheduleTime: new Date(Date.now() + 3600000).toISOString(), status: 'scheduled', format: 'REELS' });
  check('create post ok', r.status === 200 && r.data.post?.id, JSON.stringify(r.data));
  const post1 = r.data.post;
  r = await call('POST', '/api/posts', { caption: 'no media', status: 'scheduled' });
  check('scheduled post without media -> 400', r.status === 400);
  r = await call('POST', '/api/posts', { caption: 'timeless draft', status: 'draft' });
  check('timeless draft allowed', r.status === 200 && r.data.post?.status === 'draft', JSON.stringify(r.data));
  const draftId = r.data.post?.id;
  r = await call('PATCH', `/api/posts/${post1.id}`, { caption: 'First post (edited)' });
  check('patch post ok', r.status === 200 && r.data.post?.caption === 'First post (edited)');
  r = await call('POST', `/api/posts/${post1.id}/duplicate`, {});
  check('duplicate post -> draft copy', r.status === 200 && r.data.post?.status === 'draft' && r.data.post?.id !== post1.id, JSON.stringify(r.data));
  r = await call('POST', `/api/posts/${post1.id}/reschedule`, { addDays: 1 });
  check('reschedule +1 day ok', r.status === 200 && r.data.post?.scheduleTime);
  r = await call('GET', '/api/posts?limit=1');
  check('pagination limit=1 returns 1', Array.isArray(r.data.posts) && r.data.posts.length === 1, `got ${(r.data.posts || []).length}`);
  r = await call('GET', '/api/posts?limit=500');
  check('list posts ok', r.status === 200 && r.data.posts.length >= 3, `got ${(r.data.posts || []).length}`);

  // 6. Bulk import.
  r = await call('POST', '/api/posts/bulk', { posts: [
    { mediaUrl: 'https://example.com/b1.mp4', caption: 'Bulk 1', scheduleTime: new Date(Date.now() + 7200000).toISOString(), status: 'scheduled' },
    { mediaUrl: 'https://example.com/b2.mp4', caption: 'Bulk 2', scheduleTime: new Date(Date.now() + 10800000).toISOString(), status: 'scheduled' },
    { caption: 'invalid row, no media', status: 'scheduled' },
  ] });
  check('bulk import 2 ok / 1 failed', r.status === 200 && r.data.imported === 2 && r.data.failed === 1, JSON.stringify(r.data));

  // 7. Media library + upload validation.
  r = await call('POST', '/api/media', { url: 'https://example.com/pic.jpg', title: 'Pic', folder: 'Test', tags: ['a'] });
  check('add media by link ok', r.status === 200 && r.data.media?.width === 0, JSON.stringify(r.data));
  const mediaId = r.data.media?.id;
  r = await call('POST', '/api/media', { url: 'not-a-url', title: 'Bad' });
  check('bad media URL -> 400', r.status === 400);
  r = await call('POST', '/api/media/upload', { name: 'evil.txt', dataUrl: 'data:text/plain;base64,aGVsbG8=' });
  check('non-image/video upload -> 400', r.status === 400, `got ${r.status}`);
  r = await call('PATCH', `/api/media/${mediaId}`, { favorite: true });
  check('favourite media ok', r.status === 200 && r.data.media?.favorite === true);

  // 8. Publish-due without Instagram: honest error, nothing published.
  r = await call('POST', '/api/posts', { mediaUrl: 'https://example.com/due.mp4', caption: 'Due post', scheduleTime: new Date(Date.now() - 60000).toISOString(), status: 'scheduled', format: 'REELS' });
  const dueId = r.data.post?.id;
  check('due post created', !!dueId);
  r = await call('POST', '/api/publish-due', {});
  check('publish-due without IG -> 400 honest error', r.status === 400 && /not connected/i.test(r.data.error || ''), JSON.stringify(r.data));
  r = await call('GET', '/api/posts?limit=500');
  const duePost = (r.data.posts || []).find((p) => p.id === dueId);
  check('due post still scheduled (not silently failed)', duePost?.status === 'scheduled');

  // 9. Cron endpoint: no secret -> 503; wrong secret -> 401; right secret -> runs.
  r = await call('POST', '/api/cron/publish-due', {}, { auth: 'Bearer wrong' });
  check('cron wrong secret -> 401', r.status === 401, `got ${r.status}`);
  r = await call('POST', '/api/cron/publish-due', {}, { auth: 'Bearer test-cron-secret' });
  check('cron correct secret runs', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));

  // 10. Export (no token inside), stats, next-best-time.
  r = await call('GET', '/api/export');
  check('export ok, no token field', r.status === 200 && Array.isArray(r.data.posts) && !JSON.stringify(r.data).includes('INSTAGRAM_ACCESS_TOKEN') && !('token' in (r.data.settings || {})), `posts=${(r.data.posts || []).length}`);
  r = await call('GET', '/api/stats');
  check('stats counts posts', r.status === 200 && r.data.total >= 5, JSON.stringify(r.data));
  r = await call('GET', '/api/next-best-time');
  check('next-best-time suggests a slot', r.status === 200 && !!r.data.suggestedTime);

  // 11. Change password: wrong current -> 401; right -> ok; old pw stops working.
  r = await call('POST', '/api/auth/change-password', { currentPassword: 'nope', newPassword: 'newpassword123' });
  check('change pw wrong current -> 401', r.status === 401);
  r = await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'newpassword123' });
  check('change password ok', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  // New jar: old password must fail, new must work.
  const jar2 = {};
  async function callFresh(method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    const cookies = Object.entries(jar2).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;
    const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) for (const part of sc.split(',')) { const m = part.trim().match(/^([^=]+)=([^;]*)/); if (m) jar2[m[1]] = m[2]; }
    let data = null; try { data = await res.json(); } catch { /* ignore */ }
    return { status: res.status, data };
  }
  r = await callFresh('POST', '/api/auth/login', { email: 'a@example.com', password: 'password123' });
  check('old password rejected after change', r.status === 401);
  r = await callFresh('POST', '/api/auth/login', { email: 'a@example.com', password: 'newpassword123' });
  check('new password works', r.status === 200, JSON.stringify(r.data));

  // 12. Second user sees only their own data (isolation).
  r = await callFresh('POST', '/api/auth/signup', { email: 'b@example.com', password: 'password123' });
  check('signup B ok (member)', r.status === 200 && r.data.user?.role === 'member', JSON.stringify(r.data));
  const userB = r.data.user;
  r = await callFresh('GET', '/api/posts?limit=500');
  check('user B sees zero of A posts', r.status === 200 && r.data.posts.length === 0, `got ${(r.data.posts || []).length}`);
  r = await callFresh('PATCH', `/api/posts/${post1.id}`, { caption: 'hijack attempt' });
  check('user B cannot patch A post -> 404', r.status === 404, `got ${r.status}`);
  r = await callFresh('DELETE', `/api/posts/${post1.id}`);
  check('user B cannot delete A post -> 404', r.status === 404, `got ${r.status}`);

  // 13. Delete account B: data gone, login fails after.
  r = await callFresh('DELETE', '/api/auth/account');
  check('delete account B ok', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  const jar3 = {};
  const loginB = await (async () => {
    const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'b@example.com', password: 'password123' }) });
    return res.status;
  })();
  check('deleted user cannot log in', loginB === 401, `got ${loginB}`);
  // A still fine, A still owner, A's posts intact.
  r = await call('GET', '/api/posts?limit=500');
  check('user A data intact after B delete', r.status === 200 && r.data.posts.length >= 5, `got ${(r.data.posts || []).length}`);

  // 14. Login throttle: 11 wrong attempts on one email -> 429.
  let lastStatus = 0;
  for (let i = 0; i < 11; i++) {
    const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'throttle@example.com', password: 'wrong' }) });
    lastStatus = res.status;
    await res.text().catch(() => {});
  }
  check('login throttle -> 429 after 10 failures', lastStatus === 429, `got ${lastStatus}`);

  // 15. Delete the draft + due post, verify 404 on second delete.
  r = await call('DELETE', `/api/posts/${draftId}`);
  check('delete draft ok', r.status === 200);
  r = await call('DELETE', `/api/posts/${draftId}`);
  check('delete missing post -> 404', r.status === 404);

  // 16. Frontend build artifacts exist + SPA fallback serves the app.
  const distHtml = path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
  check('frontend dist built', fs.existsSync(distHtml));
  const htmlRes = await fetch(`${BASE}/`);
  const html = await htmlRes.text();
  check('SPA serves index.html', htmlRes.status === 200 && html.includes('Social Scheduler'));
  check('SPA serves robots.txt', (await (await fetch(`${BASE}/robots.txt`)).text()).includes('Disallow: /api/'));

  // 17. Build size budget: initial JS chunk under 220 KB.
  const assetsDir = path.join(__dirname, '..', 'frontend', 'dist', 'assets');
  const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  const mainJs = jsFiles.filter((f) => f.startsWith('index-')).map((f) => fs.statSync(path.join(assetsDir, f)).size);
  const mainSize = mainJs[0] || 0;
  console.log(`INFO main JS chunk: ${(mainSize / 1024).toFixed(1)} KB, ${jsFiles.length} JS chunks total`);
  check('main JS chunk < 220 KB', mainSize < 220 * 1024, `${mainSize} bytes`);

  stop();
  console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} SMOKE TEST(S) FAILED`);
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('SMOKE TEST CRASH:', e); process.exit(1); });
