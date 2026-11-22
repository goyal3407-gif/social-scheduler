// KiluaAI production-ready test suite — covers the gaps found by the
// 22 Nov 2026 Production-Ready master-prompt pass:
//   PR-1  validPostInput length caps: post text/link fields were the
//         only uncapped user-text surface (a 100,000-char caption was
//         accepted). Caps: caption 5,000, hashtags 2,000, cta 500,
//         firstComment 2,200, http(s) link fields 4,096 — enforced on
//         create, PATCH and bulk import (all share validPostInput);
//         data: media stays bounded by the 15 MB body limit, not the
//         link cap.
//   PR-2  frontend/index.html social tags: og:image / twitter:image
//         were relative (broken link previews) — now absolute, plus
//         og:url.
//   PR-3  compact logged-out view (owner request): Auth form first
//         under a small brand row; marketing demoted below the form
//         in .landing-below; no content or links deleted.
//   PR-4  owner flag on EVERY auth success response (owner-reported
//         bug: only /me carried isOwner/adminUrl, so a fresh login
//         hid Switch to Admin until a reload): owner login carries
//         both fields; a non-owner's signup/login//me carry NEITHER.
//         are absolute URLs and og:url is present (relative og:image
//         is ignored by most scrapers).
// Boots the real server against an isolated JSON data dir.
// Run: node scripts/production-ready-test.js
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

const PORT = 3131;
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

function startServer({ port, dataDir }) {
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test' };
  env['SESSION_' + 'SECRET'] = 'production-ready-test-secret'; // throwaway, local instance only
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

async function waitHealth(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

function client() {
  let cookie = '';
  return {
    async call(method, p, body) {
      const headers = { 'Content-Type': 'application/json', Origin: BASE };
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.json(); } catch { /* non-json */ }
      return { status: res.status, json };
    },
  };
}

(async () => {
  // ---- PR-3: compact logged-out view (owner request, 22 Nov 2026) ----
  // The Auth form comes FIRST (only the compact brand row above it);
  // all marketing content lives below it in .landing-below; nothing
  // was deleted (hero copy, sections, footer links all still present).
  {
    const landing = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/components/Landing.jsx'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/index.css'), 'utf8');
    const authIdx = landing.indexOf('<Auth');
    const belowIdx = landing.indexOf('className="landing-below"');
    const heroBlock = authIdx >= 0 ? landing.slice(0, authIdx) : '';
    check('PR-3 Auth form renders before the marketing block', authIdx >= 0 && belowIdx > authIdx);
    check('PR-3 hero above the form is only the brand row (no marketing copy)',
      heroBlock.includes('landing-name') && !heroBlock.includes('landing-line') && !heroBlock.includes('landing-sub'));
    check('PR-3 hero copy preserved below the form (nothing deleted)',
      landing.includes('An Instagram scheduler for Reels, Posts and Stories') &&
      landing.includes('Plan your posts once, and KiluaAI publishes them for you'));
    check('PR-3 footer links preserved', landing.includes('Privacy Policy') && landing.includes('Terms of Service') && landing.includes('Contact'));
    check('PR-3 css: compact hero (no 7vh hero padding) + demoted below-block styles',
      !/\.landing-hero\{[^}]*7vh/.test(css) && css.includes('.landing-below{'));
  }

  // ---- PR-2: static social-tag checks (no server needed) ----
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const ogImage = (html.match(/property="og:image" content="([^"]+)"/) || [])[1] || '';
  const twImage = (html.match(/name="twitter:image" content="([^"]+)"/) || [])[1] || '';
  const ogUrl = (html.match(/property="og:url" content="([^"]+)"/) || [])[1] || '';
  check('PR-2 og:image is an absolute https URL', /^https:\/\//.test(ogImage), `got "${ogImage}"`);
  check('PR-2 twitter:image is an absolute https URL', /^https:\/\//.test(twImage), `got "${twImage}"`);
  check('PR-2 og:url is present and absolute', /^https:\/\//.test(ogUrl), `got "${ogUrl}"`);

  // ---- PR-1: length caps over HTTP ----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-prodready-'));
  const { server, getLog } = startServer({ port: PORT, dataDir });
  try {
    check('server boots', await waitHealth(), getLog().slice(-400));
    const C = client();
    let r = await C.call('POST', '/api/auth/signup', { name: 'Prod Ready', email: 'prodready@example.com', password: 'Str0ng!Passw0rd' });
    check('signup (first user = owner, no plan caps in the way)', r.status === 200, `got ${r.status}`);
    const sched = new Date(Date.now() + 3600000).toISOString();
    const base = { mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption: 'ok', format: 'REELS', scheduleTime: sched, status: 'scheduled' };

    r = await C.call('POST', '/api/posts', { ...base, caption: 'c'.repeat(5000) });
    check('PR-1 caption at cap (5,000) accepted', r.status === 200, `got ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    const postId = r.json && r.json.post && r.json.post.id;
    r = await C.call('POST', '/api/posts', { ...base, caption: 'c'.repeat(5001) });
    check('PR-1 caption 5,001 rejected', r.status === 400 && /5,000 characters/.test(r.json.error || ''), `got ${r.status}`);
    r = await C.call('POST', '/api/posts', { ...base, hashtags: 'h'.repeat(2001) });
    check('PR-1 hashtags 2,001 rejected', r.status === 400 && /2,000 characters/.test(r.json.error || ''), `got ${r.status}`);
    r = await C.call('POST', '/api/posts', { ...base, cta: 'c'.repeat(501) });
    check('PR-1 cta 501 rejected', r.status === 400 && /500 characters/.test(r.json.error || ''), `got ${r.status}`);
    r = await C.call('POST', '/api/posts', { ...base, firstComment: 'f'.repeat(2201) });
    check('PR-1 firstComment 2,201 rejected', r.status === 400 && /2,200 characters/.test(r.json.error || ''), `got ${r.status}`);
    r = await C.call('POST', '/api/posts', { ...base, mediaUrl: 'https://example.com/' + 'm'.repeat(4096) });
    check('PR-1 http mediaUrl over 4,096 rejected', r.status === 400 && /too long/.test(r.json.error || ''), `got ${r.status}`);
    r = await C.call('POST', '/api/posts', { ...base, mediaUrl: PNG_DATA_URL, mediaType: 'image', format: 'FEED' });
    check('PR-1 data: media NOT hit by the link cap', r.status === 200, `got ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    r = await C.call('PATCH', `/api/posts/${postId}`, { caption: 'c'.repeat(5001) });
    check('PR-1 PATCH caption 5,001 rejected', r.status === 400 && /5,000 characters/.test(r.json.error || ''), `got ${r.status}`);
    r = await C.call('PATCH', `/api/posts/${postId}`, { caption: 'within cap' });
    check('PR-1 PATCH caption within cap accepted', r.status === 200, `got ${r.status}`);
    r = await C.call('POST', '/api/posts/bulk', { posts: [{ ...base, caption: 'c'.repeat(5001) }] });
    const impOk = r.status === 200 && r.json && r.json.imported === 0 && (r.json.errors || []).some((e) => /5,000 characters/.test(e));
    check('PR-1 bulk import row over cap fails with the cap error', impOk, `got ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);

    // ---- PR-4: owner flag on EVERY auth success response ----
    // Owner-reported bug (22 Nov 2026): only /me carried isOwner +
    // adminUrl, so after ANY fresh login the Switch to Admin button
    // was missing until a full reload (the client sets its user state
    // from the auth response and does not re-fetch /me). The PR-1
    // user is this instance's first signup = the owner; a second
    // account must carry NEITHER field in ANY response (the Batch 2
    // secrecy invariant: the slug travels only in the owner's own
    // responses).
    const O = client();
    r = await O.call('POST', '/api/auth/login', { email: 'prodready@example.com', password: 'Str0ng!Passw0rd' });
    check('PR-4 owner LOGIN response carries isOwner + adminUrl', r.status === 200 && r.json.user?.isOwner === true && typeof r.json.user?.adminUrl === 'string' && r.json.user.adminUrl.startsWith('/api/') && r.json.user.adminUrl.endsWith('/console'), `got ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    r = await O.call('GET', '/api/auth/me');
    check('PR-4 owner /me still carries isOwner + adminUrl', r.status === 200 && r.json.user?.isOwner === true && typeof r.json.user?.adminUrl === 'string', `got ${r.status}`);
    const M = client();
    r = await M.call('POST', '/api/auth/signup', { name: 'Second Member', email: 'second.member@example.com', password: 'Str0ng!Passw0rd' });
    check('PR-4 non-owner SIGNUP response carries NEITHER field', r.status === 200 && !!r.json.user && !('isOwner' in r.json.user) && !('adminUrl' in r.json.user), `got ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    const M2 = client();
    r = await M2.call('POST', '/api/auth/login', { email: 'second.member@example.com', password: 'Str0ng!Passw0rd' });
    check('PR-4 non-owner LOGIN response carries NEITHER field', r.status === 200 && !!r.json.user && !('isOwner' in r.json.user) && !('adminUrl' in r.json.user), `got ${r.status}`);
    r = await M2.call('GET', '/api/auth/me');
    check('PR-4 non-owner /me carries NEITHER field', r.status === 200 && !!r.json.user && !('isOwner' in r.json.user) && !('adminUrl' in r.json.user), `got ${r.status}`);
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    try { server.kill('SIGKILL'); } catch { /* already gone */ }
  }
  console.log(`\nproduction-ready-test: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('SUITE ERROR', e && e.message); process.exit(1); });
