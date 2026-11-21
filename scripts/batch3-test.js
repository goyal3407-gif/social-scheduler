// KiluaAI batch-3 deep suite: one-tap retry, caption library sets,
// AI caption assistant (Gemini stubbed), team/agency foundation with
// server-side role enforcement, best-time data foundation
// (publishedAt + igMediaId), and basic stats — plus the security
// pass: team IDOR, role bypass attempts via direct API calls,
// caption-library isolation, AI abuse caps.
//
// Boots the real server against an isolated JSON data dir (no
// MongoDB) with the Instagram Graph API AND generativelanguage
// stubbed at the fetch layer — the same harness as batch2-test.js.
// A second instance boots WITHOUT a Gemini key for the AI_OFF path.
//
// Run: node scripts/batch3-test.js
// Exits non-zero if any check fails. No secrets are printed.
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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

// Stub: Graph succeeds except container creation for a post whose
// caption contains FAILME while the <dataDir>/failme-on flag file
// exists. Gemini returns a fixed JSON suggestion, a 500 for topics
// containing FAILGEM, and non-JSON text for BADJSON topics.
const STUB_SOURCE = `
const fs = require('fs');
const dataDir = process.env.DATA_DIR;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com')) {
    const body = String((opts && opts.body) || '');
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    if (body.includes('FAILGEM')) return json({ error: { message: 'stub gemini failure' } }, 500);
    if (body.includes('BADJSON')) return json({ candidates: [{ content: { parts: [{ text: 'sorry, no json here' }] } }] });
    const payload = JSON.stringify({ caption: 'Stub caption, fresh from the test oven!', hashtags: '#stub #kiluaai #test', cta: 'Follow for more' });
    return json({ candidates: [{ content: { parts: [{ text: payload }] } }] });
  }
  if (u.includes('graph.facebook.com') || u.includes('graph.instagram.com')) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('debug_token')) return json({ data: { is_valid: true, expires_at: 0, type: 'USER' } });
    if (u.includes('oauth/access_token') || u.includes('refresh_access_token')) return json({ access_token: 'stub-token', token_type: 'bearer', expires_in: 5184000 });
    if (method === 'POST' && u.includes('media_publish')) return json({ id: 'igmedia-stub-1' });
    if (method === 'POST' && /\\/media(\\?|$)/.test(u)) {
      const body = String((opts && opts.body) || '');
      let caption = '';
      try { caption = JSON.parse(body).caption || ''; } catch { /* ignore */ }
      if (caption.includes('FAILME') && fs.existsSync(dataDir + '/failme-on')) {
        return json({ error: { message: 'stub publish failure', code: 100, error_subcode: 0 } });
      }
      return json({ id: 'ctr-stub-1' });
    }
    if (u.includes('fields=status_code')) return json({ status_code: 'FINISHED' });
    if (u.includes('fields=permalink')) return json({ permalink: 'https://www.instagram.com/p/STUBPOST/', media_type: 'VIDEO' });
    return json({ id: '999', username: 'stubuser' });
  }
  return origFetch(url, opts);
};
`;

function startServer({ port, dataDir, extraEnv = {} }) {
  const stubPath = path.join(dataDir, 'fetch-stub.cjs');
  fs.writeFileSync(stubPath, STUB_SOURCE);
  const server = spawn('node', ['--require', stubPath, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir,
      SESSION_SECRET: 'batch3-test-secret-0123456789', NODE_ENV: 'test',
      CRON_SECRET: 'batch3-cron-secret', ...extraEnv,
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
  async function call(method, p, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;
    if (opts.workspace) headers['x-workspace-id'] = opts.workspace;
    const res = await fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) for (const part of sc.split(',')) { const m = part.trim().match(/^([^=]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  }
  return { call };
}

function seedInstagram(dataDir, userId, accounts, defaultId) {
  const file = path.join(dataDir, 'instagram.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  all[userId] = { accounts, defaultIgUserId: defaultId || (accounts[0] && accounts[0].igUserId) || '' };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}
const igAcct = (id, username, extra = {}) => ({
  igUserId: id, username, token: 'stub-token', tokenHost: 'facebook',
  tokenType: 'SYSTEM_USER', tokenNeverExpires: true, connectedAt: new Date().toISOString(), ...extra,
});
const future = (ms) => new Date(Date.now() + ms).toISOString();

async function main() {
  const port = 3231;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiluaai-batch3-'));
  fs.writeFileSync(path.join(dataDir, 'failme-on'), '1');
  const { server, getLog } = startServer({ port, dataDir, extraEnv: { GEMINI_API_KEY: 'batch3-test-key' } });
  const port2 = 3232;
  const base2 = `http://127.0.0.1:${port2}`;
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kiluaai-batch3-nokey-'));
  const s2 = startServer({ port: port2, dataDir: dataDir2, extraEnv: { GEMINI_API_KEY: '' } });
  try {
    check('server boots (gemini key set)', await waitUp(base), getLog().slice(-400));
    check('server boots (no gemini key)', await waitUp(base2), s2.getLog().slice(-400));

    const O = makeClient(base); // owner (first signup — operator, Ultra)
    const R = makeClient(base); // retry user (Free)
    const R3 = makeClient(base); // dead-media user (Free)
    const R4 = makeClient(base); // broken-connection user (Free)
    const X = makeClient(base); // IDOR / isolation user (Free)
    const M = makeClient(base); // team member — scheduler
    const V = makeClient(base); // team member — viewer
    const A2 = makeClient(base); // AI cap user (Free)
    const S = makeClient(base); // fresh stats user (Free)
    const CAP = makeClient(base); // owner-comp Ultra (team cap test)
    const signup = async (client, email) => client.call('POST', '/api/auth/signup', { email, password: 'password123', name: email.split('@')[0] });

    let r = await signup(O, 'owner@example.com');
    check('owner signup', r.status === 200 && r.data.user.role === 'owner', JSON.stringify(r.data).slice(0, 160));
    const ownerId = r.data.user.id;
    const rId = (await signup(R, 'retry@example.com')).data.user.id;
    const r3Id = (await signup(R3, 'deadmedia@example.com')).data.user.id;
    const r4Id = (await signup(R4, 'broken@example.com')).data.user.id;
    const xId = (await signup(X, 'other@example.com')).data.user.id;
    const a2Id = (await signup(A2, 'aicap@example.com')).data.user.id;
    await signup(S, 'fresh@example.com');
    const capId = (await signup(CAP, 'astuugoyal@gmail.com')).data.user.id;
    check('owner-comp email signup is Ultra', (await CAP.call('GET', '/api/auth/me')).data.user.plan === 'ultra');

    const getPost = async (client, id) => {
      const list = await client.call('GET', '/api/posts?limit=500');
      return (list.data.posts || []).find((p) => p.id === id) || null;
    };

    // ================= S1: one-tap retry =================
    seedInstagram(dataDir, rId, [igAcct('ig-r', 'retryuser')]);
    r = await R.call('POST', '/api/posts', { mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption: 'FAILME launch post', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' });
    check('retry: post created', r.status === 200 && !!r.data.post, JSON.stringify(r.data).slice(0, 200));
    const failPost = r.data.post;
    r = await R.call('POST', `/api/posts/${failPost.id}/publish`, {});
    check('retry: first publish fails via stub', r.status === 502 || (r.data && r.data.ok === false), `got ${r.status}`);
    let p = await getPost(R, failPost.id);
    check('retry: post is failed', p && p.status === 'failed', p && p.status);
    r = await R.call('POST', `/api/posts/${failPost.id}/retry`, {});
    check('retry: retry while stub still failing -> not ok, retried flag', r.data && r.data.ok === false && r.data.retried === true, JSON.stringify(r.data).slice(0, 200));
    p = await getPost(R, failPost.id);
    check('retry: post still failed after failed retry', p && p.status === 'failed', p && p.status);
    fs.rmSync(path.join(dataDir, 'failme-on'), { force: true });
    r = await R.call('POST', `/api/posts/${failPost.id}/retry`, {});
    check('retry: retry succeeds once the cause is gone', r.status === 200 && r.data.ok === true && r.data.retried === true, JSON.stringify(r.data).slice(0, 200));
    p = await getPost(R, failPost.id);
    check('retry: post now published', p && p.status === 'published', p && p.status);
    // Best-time foundation (#11): publish time + media id recorded.
    check('foundation: post-level publishedAt recorded', !!(p && p.publishedAt), p && p.publishedAt);
    const tgt = p && (p.igTargets || [])[0];
    check('foundation: target publishedAt recorded', !!(tgt && tgt.publishedAt));
    check('foundation: target igMediaId recorded', !!tgt && tgt.igMediaId === 'igmedia-stub-1', tgt && tgt.igMediaId);
    r = await R.call('POST', `/api/posts/${failPost.id}/retry`, {});
    check('retry: published post -> 409', r.status === 409, `got ${r.status}`);
    r = await R.call('POST', '/api/posts', { mediaUrl: 'https://example.com/v2.mp4', mediaType: 'video', caption: 'plain scheduled', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' });
    const schedPost = r.data.post;
    r = await R.call('POST', `/api/posts/${schedPost.id}/retry`, {});
    check('retry: scheduled (never failed) post -> 409', r.status === 409, `got ${r.status}`);
    r = await X.call('POST', `/api/posts/${failPost.id}/retry`, {});
    check('SEC retry: someone else\'s post -> 404', r.status === 404, `got ${r.status}`);

    // Retry blocked by a broken connection (pre-flight gate).
    seedInstagram(dataDir, r4Id, [igAcct('ig-r4', 'brokenuser')]);
    fs.writeFileSync(path.join(dataDir, 'failme-on'), '1');
    r = await R4.call('POST', '/api/posts', { mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption: 'FAILME broken conn', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' });
    const brokenPost = r.data.post;
    await R4.call('POST', `/api/posts/${brokenPost.id}/publish`, {});
    p = await getPost(R4, brokenPost.id);
    check('retry-gate: setup post failed', p && p.status === 'failed', p && p.status);
    seedInstagram(dataDir, r4Id, [igAcct('ig-r4', 'brokenuser', { tokenRefreshError: 'revoked-or-expired' })]);
    fs.rmSync(path.join(dataDir, 'failme-on'), { force: true });
    r = await R4.call('POST', `/api/posts/${brokenPost.id}/retry`, {});
    check('retry-gate: broken connection -> 422 with checks', r.status === 422 && Array.isArray(r.data.checks) && r.data.checks.find((c) => c.id === 'connection' && c.ok === false), `got ${r.status} ${JSON.stringify(r.data).slice(0, 220)}`);
    p = await getPost(R4, brokenPost.id);
    check('retry-gate: blocked retry leaves the post failed (not re-armed)', p && p.status === 'failed', p && p.status);

    // Retry blocked by dead media: the library item (and with it the
    // stored copy) is deleted while a queued post still uses its URL
    // — the batch-1 dead-copy scenario.
    r = await R3.call('POST', '/api/media/upload', { name: 'shared.png', dataUrl: PNG_DATA_URL, folder: 'Uploads' });
    check('retry-gate: upload ok', r.status === 200 && !!r.data.media, JSON.stringify(r.data).slice(0, 160));
    const item = r.data.media;
    seedInstagram(dataDir, r3Id, [igAcct('ig-r3', 'deadmediauser')]);
    r = await R3.call('POST', '/api/posts', { mediaUrl: item.url, mediaType: 'image', caption: 'doomed post', scheduleTime: future(3600000), status: 'scheduled', format: 'FEED' });
    const doomed = r.data.post;
    check('retry-gate: doomed post created while copy alive', !!doomed, JSON.stringify(r.data).slice(0, 160));
    r = await R3.call('DELETE', `/api/media/${item.id}`);
    check('retry-gate: library delete removes the copy', r.status === 200, `got ${r.status}`);
    r = await R3.call('POST', `/api/posts/${doomed.id}/publish`, {});
    check('retry-gate: doomed post fails on dead copy', r.data && r.data.ok === false, JSON.stringify(r.data).slice(0, 200));
    p = await getPost(R3, doomed.id);
    check('retry-gate: doomed post is failed', p && p.status === 'failed', p && p.status);
    r = await R3.call('POST', `/api/posts/${doomed.id}/retry`, {});
    check('retry-gate: dead media -> 422 naming the media check', r.status === 422 && Array.isArray(r.data.checks) && r.data.checks.find((c) => c.id === 'media' && c.ok === false), `got ${r.status} ${JSON.stringify(r.data).slice(0, 220)}`);

    // ================= S2: caption library =================
    r = await R.call('POST', '/api/templates', { name: 'Launch set', text: 'Big launch today!', hashtags: '#launch #new', cta: 'Follow for more' });
    check('library: set saved with hashtags + cta', r.status === 200 && r.data.template && r.data.template.hashtags === '#launch #new' && r.data.template.cta === 'Follow for more', JSON.stringify(r.data).slice(0, 220));
    const setId = r.data.template.id;
    r = await R.call('GET', '/api/templates');
    check('library: set listed for its owner with fields', (r.data.templates || []).some((t) => t.id === setId && t.hashtags === '#launch #new'));
    r = await X.call('GET', '/api/templates');
    check('SEC library: other user does not see the set', !(r.data.templates || []).some((t) => t.id === setId));
    r = await X.call('DELETE', `/api/templates/${setId}`);
    check('SEC library: other user cannot delete the set -> 404', r.status === 404, `got ${r.status}`);
    r = await R.call('POST', '/api/templates', { name: 'Too many tags', text: 'x', hashtags: '#'.padEnd(600, 'a') });
    check('library: oversized hashtags -> 400', r.status === 400, `got ${r.status}`);
    r = await R.call('POST', '/api/templates', { name: 'Plain old template', text: 'Caption only' });
    check('library: text-only template still saves (back-compat)', r.status === 200 && r.data.template.text === 'Caption only');

    // ================= S3: AI caption assistant =================
    r = await R.call('POST', '/api/ai/caption', { topic: 'my new bakery opening in Delhi' });
    check('ai: suggestion returned', r.status === 200 && r.data.ok === true && /Stub caption/.test(r.data.caption || '') && (r.data.hashtags || '').includes('#stub'), `got ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    check('ai: remaining reported (Free cap 5 -> 4)', r.data.remaining === 4, JSON.stringify(r.data).slice(0, 120));
    r = await R.call('POST', '/api/ai/caption', { topic: 'ab' });
    check('ai: too-short topic -> 400', r.status === 400, `got ${r.status}`);
    r = await R.call('POST', '/api/ai/caption', { topic: 'FAILGEM topic here' });
    check('ai: gemini 500 -> graceful 502', r.status === 502 && r.data.code === 'AI_ERROR', `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    r = await R.call('POST', '/api/ai/caption', { topic: 'BADJSON topic here' });
    check('ai: unparseable answer -> graceful 502', r.status === 502 && r.data.code === 'AI_ERROR', `got ${r.status}`);
    // Daily cap: A2 (Free = 5/day) — 5 good calls, the 6th is capped.
    let capOk = true;
    for (let i = 0; i < 5; i++) {
      const rr = await A2.call('POST', '/api/ai/caption', { topic: `cap test topic number ${i}` });
      if (!(rr.status === 200 && rr.data.ok)) capOk = false;
    }
    check('ai: 5 suggestions within the Free daily cap', capOk);
    r = await A2.call('POST', '/api/ai/caption', { topic: 'one suggestion too many' });
    check('ai: 6th suggestion -> 429 AI_CAP', r.status === 429 && r.data.code === 'AI_CAP', `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    r = await A2.call('GET', '/api/plan/usage');
    check('ai: plan usage shows the cap reached', r.data.ai && r.data.ai.perDay === 5 && r.data.ai.usedToday >= 5 && r.data.ai.remaining === 0, JSON.stringify(r.data.ai || {}));
    seedInstagram(dataDir, a2Id, [igAcct('ig-a2', 'aicapuser')]);
    r = await A2.call('POST', '/api/posts', { mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption: 'scheduling still works', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' });
    check('ai: scheduling is NOT blocked when the AI cap is hit', r.status === 200 && !!r.data.post, `got ${r.status}`);
    // No-key instance: AI_OFF, scheduling untouched.
    const N = makeClient(base2);
    const nId = (await N.call('POST', '/api/auth/signup', { email: 'nokey@example.com', password: 'password123' })).data.user.id;
    r = await N.call('POST', '/api/ai/caption', { topic: 'a perfectly good topic' });
    check('ai: no key -> 503 AI_OFF with plain message', r.status === 503 && r.data.code === 'AI_OFF' && /not switched on/.test(r.data.error || ''), `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    seedInstagram(dataDir2, nId, [igAcct('ig-n', 'nokeyuser')]);
    r = await N.call('POST', '/api/posts', { mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption: 'works without ai', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' });
    check('ai: scheduling works on the no-key instance', r.status === 200 && !!r.data.post, `got ${r.status}`);

    // ================= S4: basic stats =================
    r = await R.call('GET', '/api/my-stats');
    check('stats: published counted from own records', r.status === 200 && r.data.stats && r.data.stats.published >= 1, JSON.stringify(r.data.stats || {}).slice(0, 200));
    check('stats: per-account row for the publishing account', (r.data.stats.perAccount || []).some((a) => a.account === '@retryuser' && a.published >= 1), JSON.stringify(r.data.stats.perAccount || []).slice(0, 200));
    check('stats: honest note present (no invented engagement)', /App Review/.test(r.data.note || ''));
    r = await S.call('GET', '/api/my-stats');
    check('stats: fresh user sees zeros + null rate', r.data.stats && r.data.stats.published === 0 && r.data.stats.successRate === null, JSON.stringify(r.data.stats || {}).slice(0, 160));
    r = await X.call('GET', '/api/my-stats');
    check('SEC stats: other user\'s numbers are isolated', r.data.stats && r.data.stats.published === 0, JSON.stringify(r.data.stats || {}).slice(0, 160));

    // ================= S5: team / agency foundation =================
    // Non-Ultra cannot invite.
    r = await X.call('POST', '/api/team/invite', { email: 'friend@example.com', role: 'viewer' });
    check('team: Free user invite -> 403 (Ultra feature)', r.status === 403, `got ${r.status}`);
    r = await X.call('GET', '/api/team');
    check('team: Free user team list -> 403', r.status === 403, `got ${r.status}`);
    // Owner seeds a post the team will see.
    seedInstagram(dataDir, ownerId, [igAcct('ig-o', 'owneruser')]);
    r = await O.call('POST', '/api/posts', { mediaUrl: 'https://example.com/o.mp4', mediaType: 'video', caption: 'owner post for team', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' });
    const ownerPost = r.data.post;
    check('team: owner post created', !!ownerPost, JSON.stringify(r.data).slice(0, 160));
    // Invite validation.
    r = await O.call('POST', '/api/team/invite', { email: 'not-an-email', role: 'viewer' });
    check('team: bad email -> 400', r.status === 400, `got ${r.status}`);
    r = await O.call('POST', '/api/team/invite', { email: 'someone@example.com', role: 'boss' });
    check('team: bad role -> 400', r.status === 400, `got ${r.status}`);
    r = await O.call('POST', '/api/team/invite', { email: 'owner@example.com', role: 'viewer' });
    check('team: inviting yourself -> 400', r.status === 400, `got ${r.status}`);
    // Invite M (scheduler) BEFORE M has an account -> invited, binds at signup.
    r = await O.call('POST', '/api/team/invite', { email: 'member@example.com', role: 'scheduler' });
    check('team: invite created (pending)', r.status === 200 && r.data.member && r.data.member.status === 'invited', JSON.stringify(r.data).slice(0, 200));
    const mInviteId = r.data.member.id;
    r = await signup(M, 'member@example.com');
    const mId = r.data.user.id;
    check('team: member signup', r.status === 200 && !!mId);
    r = await M.call('GET', '/api/team/memberships');
    check('team: invite bound at signup — membership listed', (r.data.memberships || []).some((m) => m.ownerId === ownerId && m.role === 'scheduler'), JSON.stringify(r.data).slice(0, 200));
    // Invite V (viewer) AFTER V has an account -> binds immediately.
    const vId = (await signup(V, 'viewer@example.com')).data.user.id;
    r = await O.call('POST', '/api/team/invite', { email: 'viewer@example.com', role: 'viewer' });
    check('team: invite for existing account binds at once', r.status === 200 && r.data.member.status === 'active', JSON.stringify(r.data).slice(0, 200));
    // Owner list shows both.
    r = await O.call('GET', '/api/team');
    check('team: owner sees both members', (r.data.members || []).filter((m) => m.status !== 'removed').length === 2, JSON.stringify(r.data).slice(0, 200));
    // --- reads in workspace ---
    r = await M.call('GET', '/api/posts?limit=500', undefined, { workspace: ownerId });
    check('team: scheduler reads owner posts in workspace', r.status === 200 && (r.data.posts || []).some((p) => p.id === ownerPost.id), `got ${r.status}`);
    r = await M.call('GET', '/api/posts?limit=500');
    check('team: same member without the header sees only own (empty) posts', r.status === 200 && !(r.data.posts || []).some((p) => p.id === ownerPost.id));
    r = await V.call('GET', '/api/posts?limit=500', undefined, { workspace: ownerId });
    check('team: viewer reads owner posts', r.status === 200 && (r.data.posts || []).some((p) => p.id === ownerPost.id));
    r = await M.call('GET', '/api/team/context', undefined, { workspace: ownerId });
    check('team: context reports workspace + role', r.data.inWorkspace === true && r.data.role === 'scheduler' && r.data.ownerEmail === 'owner@example.com', JSON.stringify(r.data).slice(0, 160));
    // --- viewer write attempts: all blocked server-side ---
    r = await V.call('POST', '/api/posts', { mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption: 'viewer attempt', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' }, { workspace: ownerId });
    check('SEC team: viewer create post -> 403', r.status === 403, `got ${r.status}`);
    r = await V.call('POST', '/api/ai/caption', { topic: 'viewer ai attempt' }, { workspace: ownerId });
    check('SEC team: viewer AI call -> 403', r.status === 403, `got ${r.status}`);
    r = await V.call('GET', '/api/settings', undefined, { workspace: ownerId });
    check('SEC team: viewer reading owner settings -> 403', r.status === 403, `got ${r.status}`);
    r = await V.call('DELETE', `/api/posts/${ownerPost.id}`, undefined, { workspace: ownerId });
    check('SEC team: viewer delete -> 403', r.status === 403, `got ${r.status}`);
    // --- scheduler: allowed writes, forbidden zones ---
    r = await M.call('POST', '/api/posts', { mediaUrl: 'https://example.com/m.mp4', mediaType: 'video', caption: 'scheduled by member', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' }, { workspace: ownerId });
    check('team: scheduler creates a post in the owner workspace', r.status === 200 && !!r.data.post, `got ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    const memberPost = r.data.post;
    r = await O.call('GET', '/api/posts?limit=500');
    check('team: the member-created post belongs to the owner', (r.data.posts || []).some((p) => p.id === memberPost.id));
    r = await M.call('GET', '/api/posts?limit=500');
    check('team: member does NOT own the post they created', !(r.data.posts || []).some((p) => p.id === memberPost.id));
    r = await M.call('PATCH', `/api/posts/${memberPost.id}`, { caption: 'edited by member' }, { workspace: ownerId });
    check('team: scheduler can edit the post (caption)', r.status === 200, `got ${r.status}`);
    r = await M.call('DELETE', `/api/posts/${memberPost.id}`, undefined, { workspace: ownerId });
    check('SEC team: scheduler delete -> 403 (no deletes in a workspace)', r.status === 403, `got ${r.status}`);
    r = await M.call('GET', '/api/settings', undefined, { workspace: ownerId });
    check('SEC team: scheduler reading owner settings -> 403', r.status === 403, `got ${r.status}`);
    r = await M.call('POST', '/api/instagram/disconnect', {}, { workspace: ownerId });
    check('SEC team: scheduler touching connections -> 403', r.status === 403, `got ${r.status}`);
    r = await M.call('GET', '/api/team', undefined, { workspace: ownerId });
    check('SEC team: scheduler reading the team list -> 403', r.status === 403, `got ${r.status}`);
    r = await M.call('POST', '/api/team/invite', { email: 'sneaky@example.com', role: 'viewer' }, { workspace: ownerId });
    check('SEC team: scheduler inviting others -> 403', r.status === 403, `got ${r.status}`);
    r = await M.call('GET', '/api/export', undefined, { workspace: ownerId });
    check('SEC team: scheduler exporting owner data -> 403', r.status === 403, `got ${r.status}`);
    // --- IDOR: no header, direct object access ---
    r = await M.call('PATCH', `/api/posts/${ownerPost.id}`, { caption: 'idor attempt' });
    check('SEC team: member PATCH owner post without workspace -> 404', r.status === 404, `got ${r.status}`);
    r = await M.call('POST', `/api/posts/${ownerPost.id}/publish`, {});
    check('SEC team: member publish owner post without workspace -> 404', r.status === 404, `got ${r.status}`);
    // --- bogus workspace ids ---
    r = await M.call('GET', '/api/posts?limit=500', undefined, { workspace: xId });
    check('SEC team: workspace of a non-owner -> 403', r.status === 403, `got ${r.status}`);
    r = await X.call('GET', '/api/posts?limit=500', undefined, { workspace: ownerId });
    check('SEC team: non-member with owner workspace header -> 403', r.status === 403, `got ${r.status}`);
    // --- role change via re-invite ---
    r = await O.call('POST', '/api/team/invite', { email: 'member@example.com', role: 'viewer' });
    check('team: re-invite updates the role', r.status === 200 && r.data.member.role === 'viewer', JSON.stringify(r.data).slice(0, 160));
    r = await M.call('POST', '/api/posts', { mediaUrl: 'https://example.com/m.mp4', mediaType: 'video', caption: 'demoted member attempt', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' }, { workspace: ownerId });
    check('SEC team: demoted scheduler (now viewer) create -> 403', r.status === 403, `got ${r.status}`);
    r = await O.call('POST', '/api/team/invite', { email: 'member@example.com', role: 'scheduler' });
    check('team: role restored to scheduler', r.status === 200 && r.data.member.role === 'scheduler');
    // --- removal cuts access on the next request ---
    r = await O.call('DELETE', `/api/team/${mInviteId}`);
    check('team: owner removes the member', r.status === 200, `got ${r.status}`);
    r = await M.call('GET', '/api/posts?limit=500', undefined, { workspace: ownerId });
    check('SEC team: removed member loses access immediately -> 403', r.status === 403, `got ${r.status}`);
    r = await M.call('GET', '/api/team/memberships');
    check('team: removed member has no memberships left', (r.data.memberships || []).length === 0, JSON.stringify(r.data).slice(0, 160));
    r = await O.call('DELETE', '/api/team/team-nonexistent');
    check('team: removing a missing member -> 404', r.status === 404, `got ${r.status}`);
    // --- member cap (owner-comp Ultra owner) ---
    let capHit = false;
    for (let i = 0; i < 26; i++) {
      const rr = await CAP.call('POST', '/api/team/invite', { email: `cap${i}@example.com`, role: 'viewer' });
      if (i < 25 && rr.status !== 200) { capHit = false; break; }
      if (i === 25) capHit = rr.status === 400;
    }
    check('team: 26th live invite -> 400 (cap 25)', capHit);

    console.log(`\n${passes} passed, ${failures} failed`);
    if (failures) { console.log('SERVER LOG TAIL:\n' + getLog().slice(-1500)); process.exitCode = 1; }
  } finally {
    server.kill('SIGKILL');
    s2.server.kill('SIGKILL');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dataDir2, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
