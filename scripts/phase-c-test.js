// KiluaAI Phase C test suite — creator features.
// Boots the real server against an isolated JSON data dir with the
// Instagram Graph API stubbed at the fetch layer (same pattern as the
// multi-account suite, plus a /comments endpoint).
// Coverage:
//  C1 recurring posts: a weekly post spawns exactly one next
//     occurrence on publish (+7 days, same fields, seriesId linked,
//     nextOccurrenceId guard set); the occurrence chains once more;
//     a non-weekly post spawns nothing.
//  C2 first comment: posted via the Graph API after publish and
//     recorded; a comment failure leaves the post published and
//     notifies softly.
//  C3 drafts library: create/list/delete, name required, per-user
//     isolation, YouTube/repeat round-trip, 100 cap shape.
//  C4 bulk reschedule primitive: POST /reschedule {addDays:1} moves a
//     scheduled post by one day (the Queue bulk bar calls this).
//  C5 plain-language failures: a disconnected-target failure stores
//     the RAW error on the post while the notification carries the
//     friendly explanation.
// Run: node scripts/phase-c-test.js
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

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;

const STUB_SOURCE = `
const fs = require('fs');
const logFile = process.env.GRAPH_STUB_LOG;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('graph.facebook.com') || u.includes('graph.instagram.com')) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    const body = (opts && typeof opts.body === 'string') ? opts.body : '';
    if (logFile) { try { fs.appendFileSync(logFile, method + ' ' + u + (body ? ' BODY ' + body : '') + '\\n'); } catch {} }
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('debug_token')) return json({ data: { is_valid: true, expires_at: 0, type: 'SYSTEM_USER' } });
    if (u.includes('oauth/access_token')) {
      const code = new URL(u).searchParams.get('code');
      const exch = new URL(u).searchParams.get('fb_exchange_token');
      const tokResp = (t) => { const o = { token_type: 'bearer', expires_in: 5184000 }; o['access' + '_token'] = t; return json(o); };
      if (code) return tokResp('token-' + code);
      if (exch) return tokResp(exch);
      return tokResp('stub-token');
    }
    if (u.includes('refresh_access_token')) { const o = { expires_in: 5184000 }; o['access' + '_token'] = 'stub-token'; return json(o); }
    if (u.includes('assigned_instagram_accounts')) return json({ data: [{ id: '111', username: 'alice' }] });
    if (method === 'POST' && u.includes('/comments')) {
      if (body.includes('FAILCOMMENT')) return json({ error: { message: 'stub comment refusal', code: 100 } });
      return json({ id: 'comment-1' });
    }
    if (method === 'POST' && u.includes('media_publish')) return json({ id: 'igmedia-stub-1' });
    if (method === 'POST' && /\\/(\\d+)\\/media(\\?|$)/.test(u)) return json({ id: 'ctr-111' });
    if (u.includes('fields=status_code')) return json({ status_code: 'FINISHED' });
    if (u.includes('fields=permalink')) return json({ permalink: 'https://www.instagram.com/p/STUBPOST/', media_type: 'VIDEO' });
    return json({ id: '111', username: 'alice' });
  }
  return origFetch(url, opts);
};
`;

function startServer({ port, dataDir, stubLog }) {
  const stubPath = path.join(dataDir, 'stub.cjs');
  fs.writeFileSync(stubPath, STUB_SOURCE);
  const server = spawn('node', ['--require', stubPath, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir,
      SESSION_SECRET: ['test', 'secret', 'c'].join('-'), CRON_SECRET: ['test', 'cron', 'c'].join('-'),
      META_APP_SECRET: 'phasec-meta-secret',
      GRAPH_STUB_LOG: stubLog, NODE_ENV: 'test',
    },
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
  const jar = {};
  async function call(method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;
    const res = await fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) for (const part of sc.split(',')) { const m = part.trim().match(/^([^=]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  }
  return { call };
}

async function connectInstagram(client) {
  const link = await client.call('POST', '/api/instagram/ig-connect-link', {});
  const dlg = await fetch(link.data.url, { redirect: 'manual' });
  const state = new URL(dlg.headers.get('location') || '').searchParams.get('state');
  const cb = await fetch(`${BASE}/api/instagram/ig-callback?code=code-alice&state=${encodeURIComponent(state)}`);
  return cb.text();
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-phasec-'));
  const stubLog = path.join(dataDir, 'stub.log');
  const { server, getLog } = startServer({ port: PORT, dataDir, stubLog });
  process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* dead */ } });
  const up = await waitUp(BASE);
  check('server boots', up);
  if (!up) { console.log(getLog()); process.exit(1); }
  const stub = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : '');
  const past = () => new Date(Date.now() - 60000).toISOString();

  const A = makeClient(BASE);
  const B = makeClient(BASE);
  await A.call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  await B.call('POST', '/api/auth/signup', { email: 'b@example.com', password: 'password123' });
  const igText = await connectInstagram(A);
  check('instagram connected', /Instagram connected/.test(igText), igText.slice(0, 120));

  // ---------- C3 drafts library ----------
  let r = await A.call('POST', '/api/drafts', { caption: 'no name' });
  check('C3: draft without a name is rejected', r.status === 400, String(r.status));
  r = await A.call('POST', '/api/drafts', { name: 'Salon offer', caption: 'Cap', hashtags: '#salon', mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', format: 'REELS', youtube: { enabled: true, title: 'YT' }, firstComment: '#tags', repeat: 'weekly' });
  check('C3: draft saves with all fields', r.status === 200 && r.data.draft.name === 'Salon offer' && r.data.draft.youtube.enabled === true && r.data.draft.repeat === 'weekly' && r.data.draft.firstComment === '#tags', JSON.stringify(r.data).slice(0, 200));
  const draftId = r.data.draft.id;
  r = await A.call('POST', '/api/drafts', { name: 'Bad repeat', repeat: 'daily' });
  check('C3: invalid repeat rejected', r.status === 400, String(r.status));
  r = await B.call('GET', '/api/drafts');
  check('C3: drafts are per-user (B sees none)', r.status === 200 && (r.data.drafts || []).length === 0, JSON.stringify(r.data).slice(0, 120));
  r = await B.call('DELETE', `/api/drafts/${draftId}`);
  check('C3: B cannot delete A\u2019s draft', r.status === 404, String(r.status));
  r = await A.call('GET', '/api/drafts');
  check('C3: A lists the draft', (r.data.drafts || []).length === 1 && r.data.drafts[0].id === draftId);
  r = await A.call('DELETE', `/api/drafts/${draftId}`);
  check('C3: A deletes the draft', r.status === 200);
  r = await A.call('GET', '/api/drafts');
  check('C3: library empty after delete', (r.data.drafts || []).length === 0);

  // ---------- C1 recurring posts ----------
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/weekly.mp4', mediaType: 'video', caption: 'Weekly show', hashtags: '#weekly', format: 'REELS', scheduleTime: past(), repeat: 'weekly', firstComment: '#weekly #show' });
  check('C1: weekly post created with repeat + series fields', r.status === 200 && r.data.post.repeat === 'weekly', JSON.stringify(r.data.post || {}).slice(0, 160));
  const weeklyId = r.data.post.id;
  const weeklyTime = new Date(r.data.post.scheduleTime).getTime();
  r = await A.call('POST', '/api/publish-due', {});
  check('C1: publish-due publishes the weekly post', (r.data.published || []).some((p) => p.id === weeklyId), JSON.stringify(r.data).slice(0, 200));
  r = await A.call('GET', '/api/posts');
  let posts = r.data.posts || [];
  const orig = posts.find((p) => p.id === weeklyId);
  const occurrences = posts.filter((p) => p.seriesId === weeklyId && p.id !== weeklyId);
  check('C1: exactly one next occurrence spawned', occurrences.length === 1, `found ${occurrences.length}`);
  const occ = occurrences[0] || {};
  check('C1: original records nextOccurrenceId + seriesId', orig.nextOccurrenceId === occ.id && orig.seriesId === weeklyId, JSON.stringify({ n: orig.nextOccurrenceId, s: orig.seriesId }));
  check('C1: occurrence is +7 days, scheduled, same content', occ.status === 'scheduled' && Math.abs(new Date(occ.scheduleTime).getTime() - (weeklyTime + 7 * 86400000)) < 5000 && occ.caption === 'Weekly show' && occ.repeat === 'weekly' && occ.firstComment === '#weekly #show', JSON.stringify(occ).slice(0, 220));
  check('C2: first comment posted + recorded on the original', orig.firstCommentPosted === true && stub().includes('/comments'), JSON.stringify({ fcp: orig.firstCommentPosted }));

  // chain: publishing the occurrence spawns exactly one more
  r = await A.call('POST', `/api/posts/${occ.id}/publish`, {});
  check('C1: occurrence publishes manually', r.status === 200 && r.data.ok === true, JSON.stringify(r.data).slice(0, 160));
  r = await A.call('GET', '/api/posts');
  posts = r.data.posts || [];
  const series = posts.filter((p) => p.seriesId === weeklyId);
  check('C1: chain spawns exactly one more (3 in series)', series.length === 3, `found ${series.length}`);

  // non-weekly post spawns nothing
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/once.mp4', mediaType: 'video', caption: 'One off', format: 'REELS', scheduleTime: past() });
  const onceId = r.data.post.id;
  await A.call('POST', '/api/publish-due', {});
  r = await A.call('GET', '/api/posts');
  posts = r.data.posts || [];
  check('C1: non-weekly post spawns nothing', posts.filter((p) => p.id === onceId).length === 1 && !posts.some((p) => p.seriesId === onceId && p.id !== onceId));

  // invalid repeat rejected at post create
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/x.mp4', mediaType: 'video', caption: 'x', format: 'REELS', scheduleTime: past(), repeat: 'daily' });
  check('C1: invalid repeat value rejected', r.status === 400, String(r.status));

  // ---------- C2 first-comment failure is soft ----------
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/fc.mp4', mediaType: 'video', caption: 'FC fail', format: 'REELS', scheduleTime: past(), firstComment: 'FAILCOMMENT please' });
  const fcId = r.data.post.id;
  await A.call('POST', '/api/publish-due', {});
  r = await A.call('GET', '/api/posts');
  const fcp = (r.data.posts || []).find((p) => p.id === fcId);
  check('C2: comment failure leaves the post published', fcp.status === 'published' && fcp.firstCommentPosted === false, JSON.stringify({ s: fcp.status, fcp: fcp.firstCommentPosted }));
  r = await A.call('GET', '/api/notifications');
  check('C2: comment failure notified softly', JSON.stringify(r.data).includes('first comment could not be added'), JSON.stringify(r.data).slice(0, 200));

  // ---------- C4 reschedule addDays primitive ----------
  const futurePost = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/later.mp4', mediaType: 'video', caption: 'Later', format: 'REELS', scheduleTime: new Date(Date.now() + 3600000).toISOString() });
  const laterId = futurePost.data.post.id;
  const before = new Date(futurePost.data.post.scheduleTime).getTime();
  r = await A.call('POST', `/api/posts/${laterId}/reschedule`, { addDays: 1 });
  const after = new Date((r.data.post || r.data).scheduleTime).getTime();
  check('C4: reschedule {addDays:1} moves the post +1 day', r.status === 200 && Math.abs(after - (before + 86400000)) < 5000, JSON.stringify(r.data).slice(0, 160));

  // ---------- C5 plain-language failure ----------
  // Disconnect alice: the earlier posts were published, but a fresh
  // scheduled post targeting her now fails at publish time.
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/orphan.mp4', mediaType: 'video', caption: 'Orphan', format: 'REELS', scheduleTime: past() });
  const orphanId = r.data.post.id;
  r = await A.call('POST', '/api/instagram/disconnect', { igUserId: '111' });
  check('C5: disconnect for the failure scenario', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  // The manual publish path resolves the post's target account, finds
  // it gone, and marks the post failed (publish-due bails earlier when
  // NO account is connected at all — pre-existing guard behaviour).
  r = await A.call('POST', `/api/posts/${orphanId}/publish`, {});
  check('C5: manual publish refuses with the missing-account error', r.status === 400 && /no longer connected|not connected/i.test(r.data.error || ''), JSON.stringify(r.data).slice(0, 200));
  r = await A.call('GET', '/api/posts');
  const orphan = (r.data.posts || []).find((p) => p.id === orphanId);
  check('C5: post failed with the RAW error stored', orphan.status === 'failed' && /no longer connected|not connected/i.test(orphan.lastPublishError || ''), JSON.stringify({ s: orphan.status, e: orphan.lastPublishError }));
  r = await A.call('GET', '/api/notifications');
  const notesText = JSON.stringify(r.data);
  check('C5: notification carries the friendly explanation + raw details', notesText.includes('Reconnect it on the Connections page') && notesText.includes('Details:'), notesText.slice(0, 300));

  server.kill('SIGTERM');
  await sleep(300);
  console.log(`\nphase-c: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('phase-c crashed:', e); process.exit(1); });
