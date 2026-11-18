// KiluaAI Phase A test suite (mega build 2026-11-18):
//   A1 update guard — /api/version reports the build id that the
//      frontend build wrote to dist/build-id.json; the bundle carries
//      the chunk-failure reload guard (vite:preloadError + lazy retry).
//      (The banner itself is exercised in render-smoke scenario C.)
//   A2 forgot password — generic responses that never leak whether an
//      email is registered; the reset token is stored HASHED only;
//      with no SMTP sender configured (this run) the link reaches the
//      server log in non-production and the flow completes from it;
//      the token is single-use, expiry is enforced, a successful
//      reset revokes every session, and the old password dies.
//      A second server booted WITH an SMTP sender (a local stub SMTP
//      server) proves the configured path: the reset email is really
//      sent, to the right address, carrying a working link.
//
// Run: node scripts/phase-a-test.js   (frontend must be built first)
// Exits non-zero if any check fails. No secrets are printed — tokens
// extracted from the test server's own log are used, never logged.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes++; console.log(`PASS ${name}`); }
  else { failures++; console.log(`FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bootServer(port, dataDir, extraEnv) {
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SESSION_SECRET: 'test-secret-phase-a-0123456789abcdef', NODE_ENV: 'test', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { server, log: '' };
  server.stdout.on('data', (d) => { state.log += d; });
  server.stderr.on('data', (d) => { state.log += d; });
  process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* dead */ } });
  return state;
}

async function waitUp(port) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

function jarCall(port, jar) {
  return async (method, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      for (const part of setCookie.split(',')) {
        const m = part.trim().match(/^([^=]+)=([^;]*)/);
        if (m) jar[m[1]] = m[2];
      }
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  };
}

// A minimal SMTP server that speaks just enough for the app's client:
// greeting, EHLO (no STARTTLS), AUTH LOGIN, MAIL/RCPT/DATA, QUIT.
// Captures the DATA payload of the last message.
function startSmtpStub(port) {
  const captured = { data: '', mailFrom: '', rcptTo: '' };
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let authStage = 0;
    sock.write('220 stub ESMTP ready\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          captured.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          sock.write('250 OK message accepted\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (authStage === 1) { authStage = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (authStage === 2) { authStage = 0; sock.write('235 Authentication successful\r\n'); }
        else if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-stub greets\r\n250 AUTH LOGIN\r\n');
        else if (up === 'AUTH LOGIN') { authStage = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (up.startsWith('MAIL FROM:')) { captured.mailFrom = line; sock.write('250 OK\r\n'); }
        else if (up.startsWith('RCPT TO:')) { captured.rcptTo = line; sock.write('250 OK\r\n'); }
        else if (up === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (up === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => { /* client went away */ });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, captured })));
}

async function main() {
  // ---------- A1: build id plumbing ----------
  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  const buildIdFile = path.join(distDir, 'build-id.json');
  check('A1: dist/build-id.json written by the build', fs.existsSync(buildIdFile));
  let distBuildId = '';
  try { distBuildId = JSON.parse(fs.readFileSync(buildIdFile, 'utf8')).buildId || ''; } catch { /* reported below */ }
  check('A1: build-id.json carries a build id', !!distBuildId);
  const assets = fs.existsSync(path.join(distDir, 'assets')) ? fs.readdirSync(path.join(distDir, 'assets')) : [];
  let bundle = '';
  for (const f of assets) if (f.endsWith('.js')) bundle += fs.readFileSync(path.join(distDir, 'assets', f), 'utf8');
  check('A1: bundle bakes in its build id', !!distBuildId && bundle.includes(distBuildId));
  check('A1: bundle guards chunk preload failures', bundle.includes('vite:preloadError') && bundle.includes('ss-preload-reload'));
  check('A1: bundle guards lazy chunk failures with one reload', bundle.includes('ss-chunk-reload'));
  check('A1: bundle renders the update banner copy', bundle.includes('new version of KiluaAI is available'));

  // ---------- server 1: no SMTP sender ----------
  const PORT = 3111;
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-phasea-'));
  const s1 = bootServer(PORT, DATA_DIR, {});
  check('A2: server boots (no SMTP configured)', await waitUp(PORT));
  const jar = {};
  const call = jarCall(PORT, jar);

  const v = await call('GET', '/api/version');
  check('A1: /api/version answers ok', v.status === 200 && v.data && v.data.ok === true);
  check('A1: /api/version buildId matches dist/build-id.json', v.data && v.data.buildId === distBuildId, `server=${v.data && v.data.buildId} dist=${distBuildId}`);

  let r = await call('POST', '/api/auth/signup', { email: 'reset@test.local', password: 'old-password-1', name: 'Reset' });
  check('A2: signup works', r.status === 200 && r.data && r.data.ok === true);
  r = await call('GET', '/api/auth/me');
  check('A2: session live before reset', r.status === 200);

  const unknown = await call('POST', '/api/auth/forgot', { email: 'nobody@test.local' });
  const known = await call('POST', '/api/auth/forgot', { email: 'reset@test.local' });
  check('A2: forgot answers 200 for unknown email', unknown.status === 200 && unknown.data.ok === true);
  check('A2: forgot answers 200 for known email', known.status === 200 && known.data.ok === true);
  check('A2: forgot responses are identical (no account leak)', JSON.stringify(unknown.data) === JSON.stringify(known.data));

  // The link reaches the server log only (non-production, no sender).
  let token = '';
  for (let i = 0; i < 30 && !token; i++) {
    const m = s1.log.match(/\[password-reset\][^\n]*\/reset\?token=([A-Za-z0-9_-]+)/);
    if (m) token = m[1];
    else await sleep(200);
  }
  check('A2: reset link logged server-side when no sender configured', !!token);
  const resetsRaw = fs.readFileSync(path.join(DATA_DIR, 'password-resets.json'), 'utf8');
  check('A2: raw token is NOT what is stored (hash only)', !!token && !resetsRaw.includes(token));

  r = await call('POST', '/api/auth/reset', { token: 'not-a-real-token', newPassword: 'new-password-2' });
  check('A2: wrong token rejected', r.status === 400);
  r = await call('POST', '/api/auth/reset', { token, newPassword: 'short' });
  check('A2: short new password rejected', r.status === 400);
  r = await call('POST', '/api/auth/reset', { token, newPassword: 'new-password-2' });
  check('A2: reset with the real token succeeds', r.status === 200 && r.data.ok === true);

  r = await call('GET', '/api/auth/me');
  check('A2: pre-reset session revoked by the reset', r.status === 401);
  const jar2 = {};
  const call2 = jarCall(PORT, jar2);
  r = await call2('POST', '/api/auth/login', { email: 'reset@test.local', password: 'old-password-1' });
  check('A2: old password no longer works', r.status === 401);
  r = await call2('POST', '/api/auth/login', { email: 'reset@test.local', password: 'new-password-2' });
  check('A2: new password works', r.status === 200 && r.data.ok === true);

  r = await call('POST', '/api/auth/reset', { token, newPassword: 'another-pass-3' });
  check('A2: token is single-use (replay rejected)', r.status === 400);

  // Expiry: issue a fresh token, then age it out in the store.
  await call('POST', '/api/auth/forgot', { email: 'reset@test.local' });
  await sleep(300);
  const resets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'password-resets.json'), 'utf8'));
  check('A2: second forgot stored a fresh token record', resets.length === 1);
  const m2 = s1.log.match(/\/reset\?token=([A-Za-z0-9_-]+)/g) || [];
  const token2 = m2.length ? m2[m2.length - 1].split('token=')[1] : '';
  resets[0].expiresAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(path.join(DATA_DIR, 'password-resets.json'), JSON.stringify(resets, null, 2));
  r = await call('POST', '/api/auth/reset', { token: token2, newPassword: 'expired-pass-4' });
  check('A2: expired token rejected', r.status === 400 && !!token2);

  // Throttle: 3 links per hour — the 4th request still answers the
  // generic 200 but stores nothing new.
  const before = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'password-resets.json'), 'utf8')).length;
  for (let i = 0; i < 3; i++) await call('POST', '/api/auth/forgot', { email: 'reset@test.local' });
  const mid = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'password-resets.json'), 'utf8')).length;
  await call('POST', '/api/auth/forgot', { email: 'reset@test.local' });
  const after = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'password-resets.json'), 'utf8')).length;
  check('A2: throttle caps stored tokens at 3/hour', mid === before + 2 && after === mid, `before=${before} mid=${mid} after=${after}`);
  try { s1.server.kill('SIGTERM'); } catch { /* done */ }

  // ---------- server 2: SMTP sender configured (stub server) ----------
  const SMTP_PORT = 25255;
  const stub = await startSmtpStub(SMTP_PORT);
  const PORT2 = 3112;
  const DATA_DIR2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-phasea2-'));
  const s2 = bootServer(PORT2, DATA_DIR2, {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT),
    SMTP_USER: 'kiluaai@test.local', SMTP_PASS: 'app-password-stub', MAIL_FROM: 'kiluaai@test.local',
  });
  check('A2: server boots (SMTP configured)', await waitUp(PORT2));
  const jarB = {};
  const callB = jarCall(PORT2, jarB);
  await callB('POST', '/api/auth/signup', { email: 'mailme@test.local', password: 'first-pass-1' });
  const logBefore = s2.log.length;
  r = await callB('POST', '/api/auth/forgot', { email: 'mailme@test.local' });
  check('A2: forgot with sender configured answers generic 200', r.status === 200 && r.data.ok === true);
  let mailToken = '';
  for (let i = 0; i < 30 && !mailToken; i++) {
    const m = stub.captured.data.match(/\/reset\?token=([A-Za-z0-9_-]+)/);
    if (m) mailToken = m[1];
    else await sleep(200);
  }
  check('A2: reset email actually sent via SMTP', !!mailToken);
  check('A2: email addressed to the account email', stub.captured.rcptTo.includes('mailme@test.local'));
  check('A2: email subject is the reset subject', stub.captured.data.includes('Subject: Reset your KiluaAI password'));
  check('A2: no dev log line when a sender is configured', !s2.log.slice(logBefore).includes('/reset?token='));
  r = await callB('POST', '/api/auth/reset', { token: mailToken, newPassword: 'mailed-pass-9' });
  check('A2: token from the sent email resets the password', r.status === 200 && r.data.ok === true);
  try { s2.server.kill('SIGTERM'); } catch { /* done */ }
  stub.server.close();

  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('phase-a harness error:', e); process.exit(1); });
