'use strict';
// Test-broadcast cleanup suite (22 Nov 2026, owner-approved): the
// guarded one-time boot cleanup removes ONLY the exact Batch-6-era
// test broadcast records — type 'announcement', title
// "New update bhai", message "Hih", createdAt inside
// 2026-11-22T07:32:00Z–07:33:00Z — writes ONE admin-audit entry with
// the deleted count, sets the globalsettings marker, and never
// fires again on a second boot. Near-miss records (different title,
// different message, outside the window, different type) and normal
// notifications must survive untouched.
// Boots the real server against an isolated JSON data dir (no
// MongoDB), the same harness as scripts/gmail-alias-test.js.
// Run: node scripts/broadcast-cleanup-test.js
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

function startServer({ port, dataDir }) {
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test' };
  env['SESSION_' + 'SECRET'] = 'broadcast-cleanup-test-secret'; // throwaway, local instance only
  env.SMTP_HOST = ''; env.SMTP_PORT = ''; env.SMTP_USER = ''; env.SMTP_PASS = ''; env.MAIL_FROM = '';
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

const readJson = (dir, name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return fallback; }
};
const writeJson = (dir, name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));

const MATCH = { type: 'announcement', title: 'New update bhai', message: 'Hih', createdAt: '2026-11-22T07:32:11.500Z' };

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-broadcast-cleanup-'));
  writeJson(dataDir, 'users.json', [
    { id: 'user-bc-1', email: 'bc-one@example.com', name: 'BC One', role: 'member', createdAt: '2026-11-01T00:00:00.000Z' },
    { id: 'user-bc-2', email: 'bc-two@example.com', name: 'BC Two', role: 'member', createdAt: '2026-11-02T00:00:00.000Z' },
  ]);
  writeJson(dataDir, 'notifications.json', [
    { id: 'ntf-match-1', userId: 'user-bc-1', ...MATCH },
    { id: 'ntf-match-2', userId: 'user-bc-2', ...MATCH },
    { id: 'ntf-match-3', userId: 'user-bc-1', ...MATCH, createdAt: '2026-11-22T07:32:59.999Z' },
    { id: 'ntf-miss-title', userId: 'user-bc-1', ...MATCH, title: 'New update bhai!' },
    { id: 'ntf-miss-message', userId: 'user-bc-1', ...MATCH, message: 'Hihh' },
    { id: 'ntf-miss-window', userId: 'user-bc-2', ...MATCH, createdAt: '2026-11-22T07:33:00.500Z' },
    { id: 'ntf-miss-before', userId: 'user-bc-2', ...MATCH, createdAt: '2026-11-22T07:31:59.000Z' },
    { id: 'ntf-miss-type', userId: 'user-bc-1', ...MATCH, type: 'publish_failed' },
    { id: 'ntf-normal', userId: 'user-bc-2', type: 'announcement', title: 'Welcome', message: 'Hello', createdAt: '2026-11-20T10:00:00.000Z' },
  ]);

  const base = 'http://127.0.0.1:3149';
  let handle = startServer({ port: 3149, dataDir });
  try {
    check('server boots with the fixture data dir', await waitUp(base));
    // The /api middleware awaits the cleanups before answering, so by
    // the time health responded the cleanup has run; poll briefly
    // anyway for the file writes to settle.
    let notifs = [];
    for (let i = 0; i < 20; i++) {
      notifs = readJson(dataDir, 'notifications.json', []);
      if (notifs.length === 6) break;
      await sleep(250);
    }
    const ids = notifs.map((n) => n.id).sort();
    check('exactly the 3 exact-match records were deleted', notifs.length === 6, `left=${notifs.length} ids=${ids.join(',')}`);
    check('all near-miss + normal records survive',
      ['ntf-miss-title', 'ntf-miss-message', 'ntf-miss-window', 'ntf-miss-before', 'ntf-miss-type', 'ntf-normal'].every((id) => ids.includes(id)),
      ids.join(','));
    const audit = readJson(dataDir, 'admin-audit.json', []).filter((e) => e.action === 'test-broadcast-cleanup');
    check('exactly one test-broadcast-cleanup audit entry', audit.length === 1, `entries=${audit.length}`);
    check('audit summary carries the deleted count', audit.length === 1 && /Removed 3 test-broadcast/.test(audit[0].summary || ''), audit[0] && audit[0].summary);
    const settings = readJson(dataDir, 'global-settings.json', []);
    const global = (Array.isArray(settings) ? settings : []).find((d) => d.id === 'global') || settings;
    check('globalsettings marker is set', !!(global && global.cleanups && global.cleanups.testBroadcast20261122),
      JSON.stringify(global && global.cleanups));
    check('server log reports the deleted count', /\[broadcast-cleanup\] Removed 3 /.test(handle.getLog()), handle.getLog().slice(-400));
  } finally {
    handle.server.kill('SIGKILL');
    await sleep(300);
  }

  // Second boot on the same data dir: the marker must prevent any
  // further deletion or audit entry.
  handle = startServer({ port: 3149, dataDir });
  try {
    check('second boot comes up', await waitUp(base));
    await sleep(600);
    const notifs = readJson(dataDir, 'notifications.json', []);
    check('second boot deletes nothing more', notifs.length === 6, `left=${notifs.length}`);
    const audit = readJson(dataDir, 'admin-audit.json', []).filter((e) => e.action === 'test-broadcast-cleanup');
    check('second boot writes no second audit entry', audit.length === 1, `entries=${audit.length}`);
  } finally {
    handle.server.kill('SIGKILL');
  }

  console.log(`broadcast-cleanup-test: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.log('FAIL harness error: ' + ((e && e.stack) || e)); process.exit(1); });
