// KiluaAI backup-export suite: the owner backup endpoint
// GET /api/hq-7f3k9/backup-export — token gate doctrine (every failure
// is the plain API 404), full-database export shape against the real
// collection names, and read-only behaviour.
//
// Boots the real server against an isolated JSON data dir (no
// MongoDB) — the same harness as scripts/smoke-test.js. A second
// instance boots WITHOUT BACKUP_TOKEN to prove the env-unset case.
//
// Run: node scripts/backup-export-test.js
// Exits non-zero if any check fails. No secrets are printed (the token
// below is a dummy test value).
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

const SLUG = 'hq-7f3k9';
const DUMMY_TOKEN = 'dummy-backup-token-for-tests-only';
const REAL_COLLECTIONS = [
  'users', 'sessions', 'posts', 'media', 'mediafiles', 'templates',
  'drafts', 'hashtaggroups', 'passwordresets', 'youtube', 'bios',
  'settings', 'instagram', 'importjobs', 'notifications',
  'uploadsessions', 'adminaudits', 'teaminvites',
];

function startServer({ port, dataDir, backupToken }) {
  const env = {
    ...process.env, PORT: String(port), DATA_DIR: dataDir,
    SESSION_SECRET: 'test-secret-for-backup-export-only-0123456789',
    NODE_ENV: 'test', CRON_SECRET: 'test-cron-secret',
  };
  if (backupToken === undefined) delete env.BACKUP_TOKEN;
  else env.BACKUP_TOKEN = backupToken;
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  return { server, getLog: () => log };
}

async function waitUp(base) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

async function exportCall(base, token) {
  const headers = {};
  if (token !== undefined) headers['x-backup-token'] = token;
  const res = await fetch(`${base}/api/${SLUG}/backup-export`, { headers });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, contentType: res.headers.get('content-type') || '' };
}

async function main() {
  // ---- instance 1: BACKUP_TOKEN set ----
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-backup-'));
  const base1 = 'http://127.0.0.1:3177';
  const one = startServer({ port: 3177, dataDir: dir1, backupToken: DUMMY_TOKEN });
  try {
    check('server boots (token set)', await waitUp(base1), one.getLog());
    let r = await exportCall(base1, undefined);
    check('no token header → 404', r.status === 404, `got ${r.status}`);
    check('no token → plain API 404 body', !!r.body && r.body.ok === false && r.body.error === 'That API route does not exist.', JSON.stringify(r.body));
    r = await exportCall(base1, 'dummy-backup-token-for-tests-XXXX'); // same length, wrong value
    check('wrong token (same length) → 404', r.status === 404, `got ${r.status}`);
    r = await exportCall(base1, 'short');
    check('wrong token (other length) → 404', r.status === 404, `got ${r.status}`);

    // Seed real data: one user (signup writes users + sessions docs).
    const su = await fetch(`${base1}/api/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'backup-owner@example.com', password: 'password123' }),
    });
    check('seed signup succeeds', su.status >= 200 && su.status < 300, `got ${su.status}`);

    const usersFile = path.join(dir1, 'users.json');
    const before = fs.existsSync(usersFile) ? fs.readFileSync(usersFile, 'utf8') : '';

    r = await exportCall(base1, DUMMY_TOKEN);
    check('correct token → 200', r.status === 200, `got ${r.status}`);
    check('content-type is JSON', r.contentType.includes('application/json'), r.contentType);
    check('body.app is kiluaai', !!r.body && r.body.app === 'kiluaai');
    check('exportedAt is an ISO timestamp', !!r.body && !Number.isNaN(Date.parse(r.body.exportedAt || '')));
    const cols = (r.body && r.body.collections) || {};
    check('collections include all real collection names', REAL_COLLECTIONS.every((n) => Object.prototype.hasOwnProperty.call(cols, n)),
      `missing: ${REAL_COLLECTIONS.filter((n) => !(n in cols)).join(',')}`);
    check('users collection is an array with the seeded user',
      Array.isArray(cols.users) && cols.users.some((u) => u && u.email === 'backup-owner@example.com'));
    check('full fidelity: password hash present in export',
      Array.isArray(cols.users) && cols.users.some((u) => u && typeof u.passwordHash === 'string' && u.passwordHash.length > 0));
    check('sessions collection exported as an array', Array.isArray(cols.sessions));

    const after = fs.existsSync(usersFile) ? fs.readFileSync(usersFile, 'utf8') : '';
    check('read-only: users.json unchanged by the export', before === after);
    const r2 = await exportCall(base1, DUMMY_TOKEN);
    check('second export returns the same user count',
      r2.status === 200 && r2.body.collections.users.length === cols.users.length);
  } finally {
    try { one.server.kill('SIGTERM'); } catch { /* already dead */ }
  }

  // ---- instance 2: BACKUP_TOKEN unset ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-backup-'));
  const base2 = 'http://127.0.0.1:3178';
  const two = startServer({ port: 3178, dataDir: dir2, backupToken: undefined });
  try {
    check('server boots (token unset)', await waitUp(base2), two.getLog());
    let r = await exportCall(base2, DUMMY_TOKEN);
    check('env unset + token header → 404', r.status === 404, `got ${r.status}`);
    r = await exportCall(base2, undefined);
    check('env unset + no header → 404', r.status === 404, `got ${r.status}`);
  } finally {
    try { two.server.kill('SIGTERM'); } catch { /* already dead */ }
  }

  console.log(`\nbackup-export: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
