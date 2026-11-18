// KiluaAI Phase F test suite — public landing page + Terms page.
// Phase F exists because Google's OAuth branding verification failed
// with "Your home page is behind a login page": a logged-out visitor
// (and Google's reviewer) must be able to read what KiluaAI does.
// This suite covers the static/serving half of that: the Terms page
// exists in frontend/public, is copied into the build and is served
// at /terms.html; the served index.html carries the Google Search
// Console verification meta tag; the built bundle contains the
// landing page's strings. The rendered half (landing around the
// login form, logged out) is asserted by render-smoke scenario A.
// Run: node scripts/phase-f-test.js   (frontend must be built first)
// Exits non-zero if any check fails.
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

const REPO = path.join(__dirname, '..');
const VERIFY_TAG = '<meta name="google-site-verification" content="g4yz1uK7FODD-6Z4W7LkNVQ2BEq7pwic7pPJ98ooASU" />';

function bootServer(port, dataDir) {
  const server = spawn('node', ['server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SESSION_SECRET: 'test-secret-phase-f-0123456789abcdef', NODE_ENV: 'test' },
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

(async () => {
  // --- Source + build artefacts (no server needed) -------------------
  const termsSrcPath = path.join(REPO, 'frontend', 'public', 'terms.html');
  const termsSrc = fs.existsSync(termsSrcPath) ? fs.readFileSync(termsSrcPath, 'utf8') : '';
  check('terms.html exists in frontend/public', termsSrc.length > 0);
  check('terms page is a Terms of Service with the YouTube ToS link',
    termsSrc.includes('Terms of Service') && termsSrc.includes('https://www.youtube.com/t/terms'));
  check('terms page routes questions to the Contact page', termsSrc.includes('/contact.html'));

  const distDir = path.join(REPO, 'frontend', 'dist');
  const distTermsPath = path.join(distDir, 'terms.html');
  check('build copies terms.html into dist (served at /terms.html)',
    fs.existsSync(distTermsPath) && fs.readFileSync(distTermsPath, 'utf8').includes('Terms of Service'));

  const distIndex = fs.existsSync(path.join(distDir, 'index.html'))
    ? fs.readFileSync(path.join(distDir, 'index.html'), 'utf8') : '';
  check('built index.html carries the google-site-verification tag', distIndex.includes(VERIFY_TAG));

  const assetsDir = path.join(distDir, 'assets');
  const bundle = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n')
    : '';
  check('built bundle contains the landing hero line',
    bundle.includes('Instagram scheduler for Reels, Posts and Stories') && bundle.includes('YouTube cross-posting'));
  check('built bundle contains the landing features + footer links',
    bundle.includes('Bulk scheduling') && bundle.includes('/terms.html') && bundle.includes('/privacy.html'));

  // --- Served behaviour (real server, isolated data dir) -------------
  const PORT = 25991;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiluaai-phasef-'));
  const { server } = bootServer(PORT, dataDir);
  try {
    check('server boots', await waitUp(PORT));

    const termsRes = await fetch(`http://127.0.0.1:${PORT}/terms.html`);
    const termsBody = await termsRes.text();
    check('GET /terms.html -> 200 with the Terms content',
      termsRes.status === 200 && termsBody.includes('Terms of Service') && termsBody.includes('youtube.com/t/terms'),
      `status ${termsRes.status}`);

    const privRes = await fetch(`http://127.0.0.1:${PORT}/privacy.html`);
    const privBody = await privRes.text();
    check('GET /privacy.html -> 200 (unchanged)', privRes.status === 200 && privBody.includes('Privacy Policy'), `status ${privRes.status}`);

    const homeRes = await fetch(`http://127.0.0.1:${PORT}/`);
    const homeBody = await homeRes.text();
    check('GET / -> 200 and serves the verification tag',
      homeRes.status === 200 && homeBody.includes('google-site-verification') && homeBody.includes('g4yz1uK7FODD-6Z4W7LkNVQ2BEq7pwic7pPJ98ooASU'),
      `status ${homeRes.status}`);

    const statusRes = await fetch(`http://127.0.0.1:${PORT}/api/db-status`);
    const statusBody = await statusRes.json().catch(() => ({}));
    check('GET /api/db-status -> ok:true', statusRes.status === 200 && statusBody.ok === true, `status ${statusRes.status}`);
  } finally {
    try { server.kill('SIGTERM'); } catch { /* dead */ }
  }

  console.log(`phase-f: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('phase-f: FAIL - harness error: ' + ((e && e.stack) || e)); process.exit(1); });
