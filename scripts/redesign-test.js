// Redesign + UX-upgrades regression test (2026-11-18) — boots the real
// server against an isolated JSON data dir and exercises the new
// surface over HTTP:
//   - sign-up with an optional display name (returned by /api/auth/me)
//   - hashtag groups CRUD: validation, per-user isolation, delete 404s
//   - caption templates: length caps + owner-only delete
//   - settings checklistDismissed round-trip (getting-started card)
//   - built frontend carries the redesign markers (top nav, IG
//     preview, hashtag bank, Post again) and no bottom dock
// Run: node scripts/redesign-test.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3105;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-redesign-'));
let failures = 0;
let passes = 0;

function check(name, cond, extra = '') {
  if (cond) { passes++; console.log(`PASS ${name}`); }
  else { failures++; console.log(`FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient() {
  const jar = {};
  return async function call(method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;
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
    return { status: res.status, data };
  };
}

async function main() {
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, SESSION_SECRET: 'test-secret-for-redesign-test-0123456789abcdef', NODE_ENV: 'test', CRON_SECRET: 'test-cron-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const stop = () => { try { server.kill('SIGTERM'); } catch { /* already dead */ } };
  process.on('exit', stop);

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { const r = await fetch(`${BASE}/api/health`); up = r.ok; } catch { await sleep(250); }
  }
  check('server boots', up);
  if (!up) { console.log(serverLog); process.exit(1); }

  const anon = makeClient();
  const a = makeClient();
  const b = makeClient();

  // --- auth: name on signup ---
  let r = await anon('GET', '/api/hashtag-groups');
  check('hashtag-groups unauthenticated -> 401', r.status === 401, `got ${r.status}`);
  r = await a('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123', name: 'Asha Verma' });
  check('signup A with name ok', r.status === 200 && r.data.user?.name === 'Asha Verma', JSON.stringify(r.data));
  r = await a('GET', '/api/auth/me');
  check('/me returns the name', r.data.user?.name === 'Asha Verma', JSON.stringify(r.data));
  r = await b('POST', '/api/auth/signup', { email: 'b@example.com', password: 'password123' });
  check('signup B without name ok (name absent)', r.status === 200 && !('name' in (r.data.user || {})), JSON.stringify(r.data));

  // --- hashtag groups ---
  r = await a('POST', '/api/hashtag-groups', { name: '', tags: '#x' });
  check('group with empty name -> 400', r.status === 400, `got ${r.status}`);
  r = await a('POST', '/api/hashtag-groups', { name: 'n'.repeat(61), tags: '#x' });
  check('group name > 60 -> 400', r.status === 400, `got ${r.status}`);
  r = await a('POST', '/api/hashtag-groups', { name: 'ok', tags: 'x'.repeat(2001) });
  check('group tags > 2000 -> 400', r.status === 400, `got ${r.status}`);
  r = await a('POST', '/api/hashtag-groups', { name: 'Reels basics', tags: '#reels #creator' });
  check('group create ok', r.status === 200 && r.data.hashtagGroup?.name === 'Reels basics', JSON.stringify(r.data));
  const groupId = r.data.hashtagGroup?.id;
  r = await a('GET', '/api/hashtag-groups');
  check('group listed for owner', r.status === 200 && (r.data.hashtagGroups || []).some((g) => g.id === groupId));
  r = await b('GET', '/api/hashtag-groups');
  check('group NOT listed for other user', r.status === 200 && !(r.data.hashtagGroups || []).some((g) => g.id === groupId));
  r = await b('DELETE', `/api/hashtag-groups/${groupId}`);
  check('other user delete group -> 404', r.status === 404, `got ${r.status}`);
  r = await a('DELETE', `/api/hashtag-groups/${groupId}`);
  check('owner delete group ok', r.status === 200, `got ${r.status}`);
  r = await a('DELETE', `/api/hashtag-groups/${groupId}`);
  check('delete group twice -> 404', r.status === 404, `got ${r.status}`);

  // --- templates: caps + delete ---
  r = await a('POST', '/api/templates', { name: 'n'.repeat(81), text: 'hi' });
  check('template name > 80 -> 400', r.status === 400, `got ${r.status}`);
  r = await a('POST', '/api/templates', { name: 'ok', text: 'x'.repeat(2201) });
  check('template text > 2200 -> 400', r.status === 400, `got ${r.status}`);
  r = await a('POST', '/api/templates', { name: 'Launch', text: 'Big news today!' });
  check('template create ok', r.status === 200 && r.data.template?.name === 'Launch', JSON.stringify(r.data));
  const tplId = r.data.template?.id;
  r = await b('DELETE', `/api/templates/${tplId}`);
  check('other user delete template -> 404', r.status === 404, `got ${r.status}`);
  r = await a('DELETE', `/api/templates/${tplId}`);
  check('owner delete template ok', r.status === 200, `got ${r.status}`);
  r = await a('DELETE', `/api/templates/${tplId}`);
  check('delete template twice -> 404', r.status === 404, `got ${r.status}`);

  // --- settings: checklist dismissal round-trip ---
  r = await b('GET', '/api/settings');
  check('checklistDismissed defaults false', r.data.checklistDismissed === false, JSON.stringify(r.data.checklistDismissed));
  r = await a('POST', '/api/settings', { checklistDismissed: true });
  check('settings save returns checklistDismissed true', r.data.checklistDismissed === true, JSON.stringify(r.data.checklistDismissed));
  r = await a('GET', '/api/settings');
  check('checklistDismissed persists on GET', r.data.checklistDismissed === true, JSON.stringify(r.data.checklistDismissed));
  r = await b('GET', '/api/settings');
  check('checklistDismissed is per-user (B still false)', r.data.checklistDismissed === false, JSON.stringify(r.data.checklistDismissed));

  // --- built frontend markers ---
  const distDir = path.join(__dirname, '..', 'frontend', 'dist', 'assets');
  const files = fs.existsSync(distDir) ? fs.readdirSync(distDir) : [];
  let bundle = '';
  for (const f of files) {
    if (/\.(js|css)$/.test(f)) bundle += fs.readFileSync(path.join(distDir, f), 'utf8');
  }
  check('dist assets exist', files.length > 0);
  check('bundle has top navigation', bundle.includes('topnav'));
  check('bundle has auth redesign', bundle.includes('auth-wrap'));
  check('bundle has Instagram preview', bundle.includes('Instagram preview') && bundle.includes('ig-preview'));
  check('bundle has hashtag bank', bundle.includes('Hashtag bank'));
  check('bundle has Post again', bundle.includes('Post again'));
  check('bundle has getting-started checklist', bundle.includes('Getting started'));
  check('bundle has NO bottom dock', !bundle.includes('dock-btn') && !bundle.includes('dock-create'));

  stop();
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
