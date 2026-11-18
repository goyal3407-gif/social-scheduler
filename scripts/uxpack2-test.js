// UX Pack 2 regression test (2026-11-18) — boots the real server
// against an isolated JSON data dir and checks:
//   - the post delete API contract the Undo toast relies on
//     (create -> list -> DELETE -> gone)
//   - QUEUE ORDERING via the real queueOrder() the Queue renders
//     with: scheduled first (soonest at the very top), every other
//     status below, newest first among themselves
//   - built-bundle markers for pack 2 (toast pill, status tracker,
//     tomorrow nudge, skeleton variants, logo empty states) and the
//     round-1 markers still present
// Run: node scripts/uxpack2-test.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3106;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-uxpack2-'));
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

// Load the exact ordering function Queue.jsx renders with (the module
// is dependency-free; strip the ESM export keyword and evaluate it).
function loadQueueOrder() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'queueOrder.js'), 'utf8');
  return new Function(`${src.replace('export function queueOrder', 'function queueOrder')}; return queueOrder;`)();
}

async function main() {
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR, SESSION_SECRET: 'test-secret-for-uxpack2-test-0123456789abcdef', NODE_ENV: 'test', CRON_SECRET: 'test-cron-secret' },
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

  const a = makeClient();
  let r = await a('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123', name: 'Asha Verma' });
  check('signup ok', r.status === 200, JSON.stringify(r.data));

  // --- delete contract (the Undo toast flush calls exactly this) ---
  const mk = async (caption, scheduleTime, status) => {
    const res = await a('POST', '/api/posts', { mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption, scheduleTime, status });
    return res.data?.post;
  };
  const late = await mk('late sched', '2026-12-01T19:00:00.000Z', 'scheduled');
  const soon = await mk('soon sched', '2026-11-20T19:00:00.000Z', 'scheduled');
  const mid = await mk('mid sched', '2026-11-25T19:00:00.000Z', 'scheduled');
  check('seeded 3 scheduled posts', Boolean(late?.id && soon?.id && mid?.id), JSON.stringify({ late, soon, mid }));
  r = await a('DELETE', `/api/posts/${mid.id}`);
  check('DELETE post -> 200', r.status === 200, `got ${r.status}`);
  r = await a('GET', '/api/posts');
  const afterDelete = r.data.posts || r.data || [];
  check('deleted post gone from list', !afterDelete.some((p) => p.id === mid.id));
  check('other posts untouched by delete', afterDelete.some((p) => p.id === late.id) && afterDelete.some((p) => p.id === soon.id));

  // --- queue ordering: API-seeded scheduled posts through queueOrder ---
  const queueOrder = loadQueueOrder();
  check('queueOrder loads from frontend/src/queueOrder.js', typeof queueOrder === 'function');
  const apiOrdered = queueOrder(afterDelete);
  check('API posts: scheduled soonest first', apiOrdered[0]?.id === soon.id && apiOrdered[1]?.id === late.id, JSON.stringify(apiOrdered.map((p) => p.caption)));

  // --- queue ordering: mixed statuses, synthetic (server never lets a
  // client create published/failed directly, so seed the exact shapes
  // the API returns for them) ---
  const T = (d) => `2026-11-${d}T19:00:00.000Z`;
  const mixed = [
    { id: 'pub-old', status: 'published', scheduleTime: T('10'), createdAt: T('09') },
    { id: 'sch-late', status: 'scheduled', scheduleTime: T('28'), createdAt: T('01') },
    { id: 'fail-new', status: 'failed', scheduleTime: T('17'), createdAt: T('16') },
    { id: 'sch-soon', status: 'scheduled', scheduleTime: T('19'), createdAt: T('02') },
    { id: 'draft-1', status: 'draft', scheduleTime: '', createdAt: T('15') },
    { id: 'pub-new', status: 'published', scheduleTime: T('18'), createdAt: T('17') },
    { id: 'sch-mid', status: 'scheduled', scheduleTime: T('22'), createdAt: T('03') },
  ];
  const ordered = queueOrder(mixed);
  check('mixed: scheduled block first, soonest at top',
    ordered.slice(0, 3).map((p) => p.id).join(',') === 'sch-soon,sch-mid,sch-late',
    JSON.stringify(ordered.map((p) => p.id)));
  check('mixed: no scheduled post below a non-scheduled one',
    ordered.findIndex((p) => p.status !== 'scheduled') === 3 &&
    ordered.slice(3).every((p) => p.status !== 'scheduled'));
  check('mixed: rest newest first (published 18th, failed 17th, draft 15th, published 10th)',
    ordered.slice(3).map((p) => p.id).join(',') === 'pub-new,fail-new,draft-1,pub-old',
    JSON.stringify(ordered.slice(3).map((p) => p.id)));
  check('mixed: input array not mutated', mixed[0].id === 'pub-old' && mixed.length === 7);
  check('queueOrder tolerates null/empty', Array.isArray(queueOrder(null)) && queueOrder([]).length === 0);

  // Queue.jsx must actually use the shared helper.
  const queueSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'components', 'Queue.jsx'), 'utf8');
  check('Queue.jsx imports + uses queueOrder', queueSrc.includes("from '../queueOrder.js'") && queueSrc.includes('queueOrder(list)'));

  // --- built frontend markers ---
  const distDir = path.join(__dirname, '..', 'frontend', 'dist', 'assets');
  const files = fs.existsSync(distDir) ? fs.readdirSync(distDir) : [];
  let bundle = '';
  for (const f of files) {
    if (/\.(js|css)$/.test(f)) bundle += fs.readFileSync(path.join(distDir, f), 'utf8');
  }
  check('dist assets exist', files.length > 0);
  check('bundle has toast pill', bundle.includes('toast-pill'));
  check('bundle has Undo delete toast', bundle.includes('Post deleted') && bundle.includes('Undo'));
  check('bundle has View on Instagram toast action', bundle.includes('View on Instagram'));
  check('bundle has status tracker', bundle.includes('post-tracker') && bundle.includes('Publishing'));
  check('bundle has tomorrow nudge', bundle.includes('Nothing scheduled for tomorrow'));
  check('bundle has queue empty state', bundle.includes('Nothing scheduled yet'));
  check('bundle has skeleton variants', bundle.includes('skel-cal') && bundle.includes('skel-media') && bundle.includes('skel-post'));
  check('bundle has logo empty states', bundle.includes('empty-art'));
  check('bundle keeps round-1 markers', bundle.includes('topnav') && bundle.includes('Post again') && bundle.includes('Getting started'));

  stop();
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
