// KiluaAI in-app Google sign-in suite (22 Nov 2026):
//   The Android app cannot run Google's sign-in inside its WebView,
//   so it opens /app-start.html in the system browser; that page's
//   verified ID token goes to POST /api/auth/google/app-code, which
//   issues a ONE-TIME return code (192-bit, SHA-256 hash at rest,
//   5-minute life, single-use) instead of a session; the app then
//   exchanges it at POST /api/auth/app-exchange for the normal
//   session cookie + the same payload a password login returns.
//   (A) over HTTP, with Google's tokeninfo replaced by a local stub:
//       codes are issued ONLY by the app-code route (the plain
//       /api/auth/google response carries no code/returnUrl, and a
//       bad token issues nothing); a stored record holds the HASH,
//       never the code; exchange succeeds once and sets a working
//       session; replay, garbage and expired codes all get a 401
//       and issue nothing; the owner's exchange payload carries
//       isOwner + adminUrl, a non-owner's carries NEITHER.
//   (B) static wiring: both routes exist, the native Google button
//       opens the start page externally, the SPA exchanges boot /
//       appUrlOpen codes, both static pages exist, the start page's
//       script posts to the app-code route, and the new UI strings
//       exist in EN + HI.
// Boots the real server against an isolated JSON data dir (no
// MongoDB), the same harness as scripts/google-login-test.js.
// Run: node scripts/app-exchange-test.js
// Exits non-zero if any check fails. No secrets are printed.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes++; console.log(`PASS ${name}`); }
  else { failures++; console.log(`FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST_AUD = 'test-client.apps.googleusercontent.com';
const future = () => String(Math.floor(Date.now() / 1000) + 3600);
const CLAIMS = {
  'tok-existing': { aud: TEST_AUD, iss: 'https://accounts.google.com', exp: future(), email: 'person.one@gmail.com', email_verified: 'true', name: 'Person One', sub: 'g-sub-1' },
  'tok-new': { aud: TEST_AUD, iss: 'https://accounts.google.com', exp: future(), email: 'new.user@example.com', email_verified: 'true', name: 'New User', sub: 'g-sub-2' },
};

function startTokeninfoStub(port) {
  const stub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const claims = CLAIMS[u.searchParams.get('id_token') || ''];
    res.setHeader('Content-Type', 'application/json');
    if (!claims) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_token' })); }
    return res.end(JSON.stringify(claims));
  });
  return new Promise((resolve) => stub.listen(port, '127.0.0.1', () => resolve(stub)));
}

function startServer({ port, dataDir, stubPort }) {
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test' };
  env['SESSION_' + 'SECRET'] = 'app-exchange-test-secret'; // throwaway, local instance only
  env.SMTP_HOST = ''; env.SMTP_PORT = ''; env.SMTP_USER = ''; env.SMTP_PASS = ''; env.MAIL_FROM = '';
  env.GOOGLE_CLIENT_ID = TEST_AUD;
  env.GOOGLE_TOKENINFO_URL = `http://127.0.0.1:${stubPort}/tokeninfo`;
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env,
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
  let cookie = '';
  return {
    async call(method, p, body) {
      const r = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = r.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await r.json(); } catch { /* not json */ }
      return { status: r.status, data };
    },
  };
}

const readJson = (dir, name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return fallback; }
};
const PW = 'Kilua-Test-9871';

async function partA() {
  const stub = await startTokeninfoStub(3171);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-appexchange-'));
  const base = 'http://127.0.0.1:3169';
  const { server, getLog } = startServer({ port: 3169, dataDir, stubPort: 3171 });
  try {
    check('A: server boots', await waitUp(base), getLog().slice(-300));

    // Seed the owner as a normal password account (first user).
    const P = makeClient(base);
    let r = await P.call('POST', '/api/auth/signup', { email: 'Person.One@Gmail.com', password: PW, name: 'Person' });
    check('A: seed signup -> 200', r.status === 200 && !!r.data.user?.id, `got ${r.status}`);
    const seedId = r.data.user?.id;

    // The PLAIN web flow never issues a return code.
    const W = makeClient(base);
    r = await W.call('POST', '/api/auth/google', { idToken: 'tok-existing' });
    check('A: plain google login -> 200', r.status === 200 && r.data.user?.id === seedId, `got ${r.status}`);
    check('A: plain google login carries NO code / returnUrl', !!r.data && !('returnUrl' in r.data) && !('code' in r.data));
    check('A: no app code stored after the plain flow', readJson(dataDir, 'app-codes.json', []).length === 0);

    // A bad token issues nothing.
    r = await W.call('POST', '/api/auth/google/app-code', { idToken: 'total-garbage' });
    check('A: app-code with a garbage token -> 401', r.status === 401 && r.data?.ok === false, `got ${r.status}`);
    check('A: garbage token stored no code', readJson(dataDir, 'app-codes.json', []).length === 0);

    // The browser flow issues exactly one code, hashed at rest.
    r = await W.call('POST', '/api/auth/google/app-code', { idToken: 'tok-existing' });
    check('A: app-code for a verified user -> 200', r.status === 200 && typeof r.data?.returnUrl === 'string', `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    const m = /^\/app-return\.html\?code=([A-Za-z0-9_-]+)$/.exec(r.data?.returnUrl || '');
    check('A: returnUrl is the https return page with a code', !!m);
    const code = m ? m[1] : '';
    check('A: code is at least 128-bit (22+ base64url chars)', code.length >= 22, `len ${code.length}`);
    const stored = readJson(dataDir, 'app-codes.json', []);
    check('A: exactly one code stored', stored.length === 1, `got ${stored.length}`);
    check('A: stored record holds the HASH, never the code', stored.length === 1 && typeof stored[0].codeHash === 'string' && stored[0].codeHash !== code && !JSON.stringify(stored).includes(code));
    check('A: stored record is bound to the seed account', stored.length === 1 && stored[0].userId === seedId);

    // A garbage exchange fails and issues nothing.
    const X0 = makeClient(base);
    r = await X0.call('POST', '/api/auth/app-exchange', { code: 'not-a-real-code-0000000000' });
    check('A: garbage exchange -> 401', r.status === 401 && r.data?.ok === false, `got ${r.status}`);
    r = await X0.call('GET', '/api/auth/me');
    check('A: garbage exchange issued no session', r.status === 401, `got ${r.status}`);

    // The real exchange: session + login-shaped payload (owner).
    const X = makeClient(base);
    r = await X.call('POST', '/api/auth/app-exchange', { code });
    check('A: exchange -> 200 with the seed account', r.status === 200 && r.data.user?.id === seedId, `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    check('A: owner exchange payload carries isOwner + adminUrl', r.data.user?.isOwner === true && typeof r.data.user?.adminUrl === 'string');
    check('A: code consumed by the exchange', readJson(dataDir, 'app-codes.json', []).length === 0);
    r = await X.call('GET', '/api/auth/me');
    check('A: exchanged session works on /me', r.status === 200 && r.data.user?.id === seedId, `got ${r.status}`);

    // Replay: the same code can never work twice.
    const X2 = makeClient(base);
    r = await X2.call('POST', '/api/auth/app-exchange', { code });
    check('A: replayed code -> 401', r.status === 401 && r.data?.ok === false, `got ${r.status}`);
    r = await X2.call('GET', '/api/auth/me');
    check('A: replay issued no session', r.status === 401, `got ${r.status}`);

    // Non-owner: payload carries NEITHER admin field.
    r = await W.call('POST', '/api/auth/google/app-code', { idToken: 'tok-new' });
    const m2 = /^\/app-return\.html\?code=([A-Za-z0-9_-]+)$/.exec(r.data?.returnUrl || '');
    check('A: app-code for a new user -> returnUrl', r.status === 200 && !!m2, `got ${r.status}`);
    const X3 = makeClient(base);
    r = await X3.call('POST', '/api/auth/app-exchange', { code: m2 ? m2[1] : '' });
    check('A: non-owner exchange -> 200', r.status === 200 && r.data.user?.email === 'new.user@example.com', `got ${r.status}`);
    check('A: non-owner exchange payload carries NEITHER field', !!r.data.user && !('isOwner' in r.data.user) && !('adminUrl' in r.data.user));

    // Expired: a code whose stored expiry is in the past is refused.
    r = await W.call('POST', '/api/auth/google/app-code', { idToken: 'tok-existing' });
    const m3 = /^\/app-return\.html\?code=([A-Za-z0-9_-]+)$/.exec(r.data?.returnUrl || '');
    check('A: second app-code issued', r.status === 200 && !!m3, `got ${r.status}`);
    const codesFile = path.join(dataDir, 'app-codes.json');
    const docs = readJson(dataDir, 'app-codes.json', []);
    docs.forEach((d) => { d.expiresAt = new Date(Date.now() - 60000).toISOString(); });
    fs.writeFileSync(codesFile, JSON.stringify(docs));
    const X4 = makeClient(base);
    r = await X4.call('POST', '/api/auth/app-exchange', { code: m3 ? m3[1] : '' });
    check('A: expired code -> 401', r.status === 401 && r.data?.ok === false, `got ${r.status}`);
    r = await X4.call('GET', '/api/auth/me');
    check('A: expired code issued no session', r.status === 401, `got ${r.status}`);
  } finally {
    server.kill('SIGKILL');
    stub.close();
  }
}

function partB() {
  const root = path.join(__dirname, '..');
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const btnSrc = fs.readFileSync(path.join(root, 'frontend/src/components/GoogleButton.jsx'), 'utf8');
  const appSrc = fs.readFileSync(path.join(root, 'frontend/src/App.jsx'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(root, 'frontend/src/api.js'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(root, 'frontend/src/i18n.js'), 'utf8');
  check('B: app-code route exists', serverSrc.includes("app.post('/api/auth/google/app-code'"));
  check('B: app-exchange route exists', serverSrc.includes("app.post('/api/auth/app-exchange'"));
  check('B: native button opens the start page in the system browser', btnSrc.includes('/app-start.html') && btnSrc.includes('openExternalUrl'));
  check('B: SPA exchanges codes (api + boot/appUrlOpen wiring)', apiSrc.includes('/api/auth/app-exchange') && appSrc.includes('appExchange') && appSrc.includes('appcode'));
  check('B: start page + script exist and post to the app-code route',
    fs.existsSync(path.join(root, 'frontend/public/app-start.html')) &&
    fs.readFileSync(path.join(root, 'frontend/public/app-start.js'), 'utf8').includes('/api/auth/google/app-code'));
  check('B: return fallback page + hand-off script exist',
    fs.existsSync(path.join(root, 'frontend/public/app-return.html')) &&
    fs.readFileSync(path.join(root, 'frontend/public/app-return.js'), 'utf8').includes('appcode'));
  check('B: new strings exist in EN + HI', (i18nSrc.match(/googleContinueApp/g) || []).length >= 2 && (i18nSrc.match(/googleAppHint/g) || []).length >= 2);
}

async function main() {
  await partA();
  partB();
  console.log(`\napp-exchange-test: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
