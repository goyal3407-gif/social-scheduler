// KiluaAI "Sign in with Google" suite (22 Nov 2026):
//   (A) the ID-token endpoint over HTTP, with Google's tokeninfo
//       endpoint replaced by a local stub (GOOGLE_TOKENINFO_URL) —
//       a valid token for an existing user issues the same session
//       as password login; a dotted-Gmail token email lands on the
//       canonical account (no duplicate); a brand-new email creates
//       a PASSWORDLESS account on the Free plan; wrong audience,
//       unverified email, expired token, bad issuer and garbage all
//       get a clean 401 and create nothing; a passwordless account
//       attempting password login gets the standard wrong-password
//       error, never a crash; the owner comp resolves canonically.
//   (B) static wiring: the CSP opens ONLY accounts.google.com for
//       the GIS button, the frontend carries the GIS loader + the
//       native-shell hide, and the new UI strings exist in EN + HI.
// Boots the real server against an isolated JSON data dir (no
// MongoDB), the same harness as scripts/gmail-alias-test.js.
// Run: node scripts/google-login-test.js
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
const past = () => String(Math.floor(Date.now() / 1000) - 3600);
const CLAIMS = {
  'tok-existing': { aud: TEST_AUD, iss: 'https://accounts.google.com', exp: future(), email: 'person.one@gmail.com', email_verified: 'true', name: 'Person One', sub: 'g-sub-1' },
  'tok-new': { aud: TEST_AUD, iss: 'https://accounts.google.com', exp: future(), email: 'new.user@example.com', email_verified: 'true', name: 'New User', sub: 'g-sub-2' },
  'tok-wrongaud': { aud: 'someone-elses-client.apps.googleusercontent.com', iss: 'https://accounts.google.com', exp: future(), email: 'wrong.aud@example.com', email_verified: 'true', name: 'Wrong Aud', sub: 'g-sub-3' },
  'tok-unverified': { aud: TEST_AUD, iss: 'https://accounts.google.com', exp: future(), email: 'un.verified@example.com', email_verified: 'false', name: 'Un Verified', sub: 'g-sub-4' },
  'tok-expired': { aud: TEST_AUD, iss: 'https://accounts.google.com', exp: past(), email: 'ex.pired@example.com', email_verified: 'true', name: 'Ex Pired', sub: 'g-sub-5' },
  'tok-badiss': { aud: TEST_AUD, iss: 'https://evil.example.com', exp: future(), email: 'bad.iss@example.com', email_verified: 'true', name: 'Bad Iss', sub: 'g-sub-6' },
  'tok-comp': { aud: TEST_AUD, iss: 'https://accounts.google.com', exp: future(), email: 'goyal.dhiman00@gmail.com', email_verified: 'true', name: 'Comp User', sub: 'g-sub-7' },
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
  env['SESSION_' + 'SECRET'] = 'google-login-test-secret'; // throwaway, local instance only
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
  const stub = await startTokeninfoStub(3157);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-googlelogin-a-'));
  const base = 'http://127.0.0.1:3149';
  const { server, getLog } = startServer({ port: 3149, dataDir, stubPort: 3157 });
  try {
    check('A: server boots', await waitUp(base), getLog().slice(-300));
    const ANON = makeClient(base);

    // --- an existing password account to sign into with Google ---
    const P = makeClient(base);
    let r = await P.call('POST', '/api/auth/signup', { email: 'Person.One@Gmail.com', password: PW, name: 'Person' });
    check('A: seed signup -> 200', r.status === 200 && !!r.data.user?.id, `got ${r.status}`);
    const seedId = r.data.user?.id;
    check('A: seed stored canonically', r.data.user?.email === 'personone@gmail.com', `got ${r.data.user?.email}`);

    // --- valid token, dotted spelling -> same account, session issued ---
    const G1 = makeClient(base);
    r = await G1.call('POST', '/api/auth/google', { idToken: 'tok-existing' });
    check('A: google login for existing user -> 200', r.status === 200 && !!r.data.user?.id, `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    check('A: google login lands on the SAME account', r.data.user?.id === seedId, `got ${r.data.user?.id} vs ${seedId}`);
    check('A: no duplicate account created', readJson(dataDir, 'users.json', []).length === 1);
    r = await G1.call('GET', '/api/auth/me');
    check('A: google session works on /me', r.status === 200 && r.data.user?.id === seedId, `got ${r.status}`);

    // --- brand-new email -> passwordless account on the Free plan ---
    const G2 = makeClient(base);
    r = await G2.call('POST', '/api/auth/google', { idToken: 'tok-new' });
    check('A: google signup for a new email -> 200', r.status === 200 && r.data.user?.email === 'new.user@example.com', `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    check('A: new account carries the Google name', r.data.user?.name === 'New User', `got ${r.data.user?.name}`);
    check('A: new account is on the Free plan', r.data.user?.plan === 'free', `got ${r.data.user?.plan}`);
    const usersNow = readJson(dataDir, 'users.json', []);
    check('A: user count is now 2', usersNow.length === 2, `got ${usersNow.length}`);
    const stored = usersNow.find((u) => u.email === 'new.user@example.com');
    check('A: stored account is passwordless', !!stored && !('passwordHash' in stored) && !('salt' in stored), stored ? Object.keys(stored).join(',') : 'missing');
    r = await G2.call('GET', '/api/auth/me');
    check('A: new-account session works on /me', r.status === 200 && r.data.user?.email === 'new.user@example.com', `got ${r.status}`);

    // --- passwordless account + password login -> standard error, no crash ---
    r = await ANON.call('POST', '/api/auth/login', { email: 'new.user@example.com', password: 'Whatever-1234' });
    check('A: password login on a passwordless account -> 401', r.status === 401, `got ${r.status}`);
    check('A: the error is the standard wrong-password one', String(r.data?.error || '').startsWith('Wrong email or password'), `got ${r.data?.error}`);
    r = await ANON.call('GET', '/api/health');
    check('A: server still healthy after that login', r.status === 200, `got ${r.status}`);

    // --- every bad token shape -> clean 401, nothing created ---
    for (const [tok, label] of [['tok-wrongaud', 'wrong audience'], ['tok-unverified', 'email not verified'], ['tok-expired', 'expired token'], ['tok-badiss', 'wrong issuer'], ['total-garbage', 'garbage token']]) {
      r = await ANON.call('POST', '/api/auth/google', { idToken: tok });
      check(`A: ${label} -> 401`, r.status === 401 && r.data?.ok === false, `got ${r.status}`);
      check(`A: ${label} created no account`, readJson(dataDir, 'users.json', []).length === 2);
    }
    r = await ANON.call('POST', '/api/auth/google', {});
    check('A: missing idToken -> 401', r.status === 401, `got ${r.status}`);
    check('A: user count still 2 after all failures', readJson(dataDir, 'users.json', []).length === 2);

    // --- owner comp resolves through the canonical Google identity ---
    const G3 = makeClient(base);
    r = await G3.call('POST', '/api/auth/google', { idToken: 'tok-comp' });
    check('A: dotted owner-comp email signs in -> 200', r.status === 200 && r.data.user?.email === 'goyaldhiman00@gmail.com', `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    check('A: owner comp resolves to Ultra', r.data.user?.plan === 'ultra' && r.data.user?.comp === true, `got ${r.data.user?.plan}/${r.data.user?.comp}`);
  } finally {
    server.kill('SIGKILL');
    stub.close();
  }
}

function partB() {
  const root = path.join(__dirname, '..');
  const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const authSrc = fs.readFileSync(path.join(root, 'frontend/src/components/Auth.jsx'), 'utf8');
  const btnSrc = fs.readFileSync(path.join(root, 'frontend/src/components/GoogleButton.jsx'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(root, 'frontend/src/api.js'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(root, 'frontend/src/i18n.js'), 'utf8');
  check('B: server verifies via Google tokeninfo', serverSrc.includes('oauth2.googleapis.com/tokeninfo'));
  check('B: google auth route exists', serverSrc.includes("app.post('/api/auth/google'"));
  const cspLine = (serverSrc.match(/Content-Security-Policy[^\n]*/) || [''])[0];
  check('B: CSP allows the GIS script host only', cspLine.includes("script-src 'self' https://accounts.google.com"));
  check('B: CSP allows the GIS frame host', cspLine.includes('frame-src https://accounts.google.com'));
  check('B: CSP allows GIS connect', /connect-src[^;]*https:\/\/accounts\.google\.com/.test(cspLine));
  check('B: button loads the official GIS script', btnSrc.includes('https://accounts.google.com/gsi/client'));
  check('B: button carries the public Client ID', btnSrc.includes('628297569656-dc5stqkpmdogk64e396paagapciai7vj.apps.googleusercontent.com'));
  check('B: button hides in the native shell', btnSrc.includes('isNativeShell'));
  check('B: Auth renders the Google button', authSrc.includes('GoogleButton') && authSrc.includes('googleLogin'));
  check('B: api client posts to the google endpoint', apiSrc.includes('/api/auth/google'));
  check('B: new strings exist in EN + HI', (i18nSrc.match(/authOrDivider/g) || []).length >= 2 && (i18nSrc.match(/googleSignInFailed/g) || []).length >= 2);
}

async function main() {
  await partA();
  partB();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
