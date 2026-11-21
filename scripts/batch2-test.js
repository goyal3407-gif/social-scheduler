// KiluaAI batch-2 deep suite: owner console (admin panel), plan
// limits, pre-flight check — plus the security pass the user asked
// for (404 doctrine, server-side enforcement, IDOR, attempt caps).
//
// Boots the real server against an isolated JSON data dir (no
// MongoDB) with the Instagram Graph API stubbed at the fetch layer —
// the same harness as scripts/reused-media-test.js.
//
// Run: node scripts/batch2-test.js
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

// The console path segment — mirrors server.js (test-side only; the
// client app never contains it).
const SLUG = 'hq-7f3k9';

const STUB_SOURCE = `
const fs = require('fs');
const logFile = process.env.GRAPH_STUB_LOG;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('graph.facebook.com') || u.includes('graph.instagram.com')) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    if (logFile) { try { fs.appendFileSync(logFile, method + ' ' + u + '\\n'); } catch {} }
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('debug_token')) return json({ data: { is_valid: true, expires_at: 0, type: 'USER' } });
    if (u.includes('oauth/access_token') || u.includes('refresh_access_token')) return json({ access_token: 'stub-token', token_type: 'bearer', expires_in: 5184000 });
    if (method === 'POST' && u.includes('media_publish')) return json({ id: 'igmedia-stub-1' });
    if (method === 'POST' && /\\/media(\\?|$)/.test(u)) return json({ id: 'ctr-stub-1' });
    if (u.includes('fields=status_code')) return json({ status_code: 'FINISHED' });
    if (u.includes('fields=permalink')) return json({ permalink: 'https://www.instagram.com/p/STUBPOST/', media_type: 'VIDEO' });
    return json({ id: '999', username: 'stubuser' });
  }
  return origFetch(url, opts);
};
`;

function startServer({ port, dataDir, stubLog }) {
  const stubPath = path.join(dataDir, 'graph-stub.cjs');
  fs.writeFileSync(stubPath, STUB_SOURCE);
  const server = spawn('node', ['--require', stubPath, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir,
      SESSION_SECRET: 'batch2-test-secret-0123456789', NODE_ENV: 'test',
      CRON_SECRET: 'batch2-cron-secret', GRAPH_STUB_LOG: stubLog,
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
    if (opts.auth) headers.Authorization = opts.auth;
    const res = await fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) for (const part of sc.split(',')) { const m = part.trim().match(/^([^=]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  }
  async function raw(method, p) {
    const headers = {};
    const cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) headers.Cookie = cookies;
    const res = await fetch(`${base}${p}`, { method, headers });
    return { status: res.status, text: await res.text() };
  }
  return { call, raw };
}

// Seed helpers — the JSON fallback reads these files fresh per call.
function seedInstagram(dataDir, userId, accounts, defaultId) {
  const file = path.join(dataDir, 'instagram.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  all[userId] = { accounts, defaultIgUserId: defaultId || (accounts[0] && accounts[0].igUserId) || '' };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}
function seedYouTube(dataDir, userId) {
  const file = path.join(dataDir, 'youtube.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  all[userId] = { userId, channelId: 'chan-stub', channelTitle: 'Stub Channel', refreshTokenEnc: 'x' };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}
const igAcct = (id, username, extra = {}) => ({
  igUserId: id, username, token: 'stub-token', tokenHost: 'facebook',
  tokenType: 'SYSTEM_USER', tokenNeverExpires: true, connectedAt: new Date().toISOString(), ...extra,
});

async function main() {
  const port = 3221;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiluaai-batch2-'));
  const stubLog = path.join(dataDir, 'graph.log');
  const { server, getLog } = startServer({ port, dataDir, stubLog });
  try {
    check('server boots', await waitUp(base), getLog().slice(-400));

    const anon = makeClient(base);
    const O = makeClient(base); // owner (first signup)
    const B = makeClient(base);
    const C = makeClient(base);
    const D = makeClient(base);
    const E = makeClient(base);
    const F = makeClient(base);
    const G = makeClient(base);
    const H = makeClient(base);
    const signup = async (client, email) => {
      const r = await client.call('POST', '/api/auth/signup', { email, password: 'password123', name: email.split('@')[0] });
      return r;
    };
    let r = await signup(O, 'owner@example.com');
    check('owner signup', r.status === 200 && r.data.user && r.data.user.role === 'owner', JSON.stringify(r.data).slice(0, 160));
    const ownerId = r.data.user.id;
    check('owner /api/auth/me shows plan ultra (operator bypass)', r.data.user.plan === 'ultra', JSON.stringify(r.data.user).slice(0, 160));
    await signup(B, 'b@example.com');
    const bId = (await B.call('GET', '/api/auth/me')).data.user.id;
    await signup(C, 'c@example.com');
    const cId = (await C.call('GET', '/api/auth/me')).data.user.id;
    await signup(D, 'd@example.com');
    const dId = (await D.call('GET', '/api/auth/me')).data.user.id;
    await signup(E, 'e@example.com');
    await signup(F, 'f@example.com');
    const fId = (await F.call('GET', '/api/auth/me')).data.user.id;
    await signup(G, 'g@example.com');
    const gId = (await G.call('GET', '/api/auth/me')).data.user.id;
    await signup(H, 'h@example.com');
    const hId = (await H.call('GET', '/api/auth/me')).data.user.id;

    const mePlan = async (client) => (await client.call('GET', '/api/auth/me')).data.user.plan;
    check('member defaults to Free plan', (await mePlan(B)) === 'free');

    // ---------- S1: admin 404 doctrine ----------
    r = await anon.call('GET', `/api/${SLUG}/status`);
    check('SEC anon admin status → 404', r.status === 404, `got ${r.status}`);
    r = await anon.call('GET', `/api/${SLUG}/overview`);
    check('SEC anon admin overview → 404', r.status === 404, `got ${r.status}`);
    r = await anon.call('GET', `/api/${SLUG}/users`);
    check('SEC anon admin users → 404', r.status === 404, `got ${r.status}`);
    let raw = await anon.raw('GET', `/${SLUG}`);
    check('SEC anon admin page → 404 page', raw.status === 404 && raw.text.includes('404'), `got ${raw.status}`);
    r = await B.call('GET', `/api/${SLUG}/status`);
    check('SEC member admin status → 404', r.status === 404, `got ${r.status}`);
    r = await B.call('GET', `/api/${SLUG}/overview`, undefined, { headers: { 'x-admin-token': 'forged-token' } });
    check('SEC member + forged token → 404', r.status === 404, `got ${r.status}`);
    raw = await B.raw('GET', `/${SLUG}`);
    check('SEC member admin page → 404 page', raw.status === 404, `got ${raw.status}`);
    r = await O.call('GET', `/api/${SLUG}/status`);
    check('owner admin status → 200, PIN not set', r.status === 200 && r.data.pinSet === false, JSON.stringify(r.data).slice(0, 120));
    raw = await O.raw('GET', `/${SLUG}`);
    check('owner admin page → 200 console HTML', raw.status === 200 && raw.text.includes('Owner Console'), `got ${raw.status}`);
    r = await O.call('GET', `/api/${SLUG}/overview`);
    check('SEC owner data endpoint without PIN token → 404', r.status === 404, `got ${r.status}`);
    r = await O.call('GET', `/api/${SLUG}/users`);
    check('SEC owner users endpoint without PIN token → 404', r.status === 404, `got ${r.status}`);

    // ---------- S2: PIN lifecycle ----------
    r = await O.call('POST', `/api/${SLUG}/set-pin`, { pin: '2468' });
    check('owner set-pin → 200 + token', r.status === 200 && typeof r.data.adminToken === 'string' && r.data.adminToken.length > 10, `got ${r.status}`);
    let adminToken = r.data.adminToken;
    const adm = () => ({ headers: { 'x-admin-token': adminToken } });
    r = await O.call('GET', `/api/${SLUG}/status`, undefined, adm());
    check('status with token → pinSet + unlocked', r.status === 200 && r.data.pinSet === true && r.data.unlocked === true);
    r = await O.call('POST', `/api/${SLUG}/set-pin`, { pin: '9999' });
    check('set-pin twice → 404 (must change instead)', r.status === 404, `got ${r.status}`);
    r = await O.call('POST', `/api/${SLUG}/unlock`, { pin: '0000' });
    check('SEC unlock wrong PIN → 404', r.status === 404, `got ${r.status}`);
    r = await O.call('POST', `/api/${SLUG}/unlock`, { pin: '2468' });
    check('unlock correct PIN → 200 + token', r.status === 200 && !!r.data.adminToken, `got ${r.status}`);
    adminToken = r.data.adminToken;
    r = await O.call('POST', `/api/${SLUG}/change-pin`, { pin: '1357' }, adm());
    check('change-pin with token → 200', r.status === 200 && !!r.data.adminToken, `got ${r.status}`);
    adminToken = r.data.adminToken;
    r = await O.call('POST', `/api/${SLUG}/unlock`, { pin: '2468' });
    check('old PIN no longer unlocks → 404', r.status === 404, `got ${r.status}`);
    r = await O.call('POST', `/api/${SLUG}/unlock`, { pin: '1357' });
    check('new PIN unlocks → 200', r.status === 200 && !!r.data.adminToken, `got ${r.status}`);
    adminToken = r.data.adminToken;

    // ---------- S3: admin actions + audit ----------
    r = await O.call('GET', `/api/${SLUG}/users`, undefined, adm());
    const bRow = (r.data.users || []).find((u) => u.id === bId);
    check('admin users list → member on Free', r.status === 200 && !!bRow && bRow.plan.plan === 'free', JSON.stringify(r.data).slice(0, 160));
    r = await O.call('PATCH', `/api/${SLUG}/users/${bId}`, { plan: 'pro' }, adm());
    check('admin plan change Free→Pro', r.status === 200 && r.data.user.plan.plan === 'pro' && r.data.user.plan.basePlan === 'pro', JSON.stringify(r.data).slice(0, 160));
    let audit = (await O.call('GET', `/api/${SLUG}/audit`, undefined, adm())).data.entries || [];
    check('audit has plan-change for B', audit.some((e) => e.action === 'plan-change' && e.targetUserId === bId && /free/.test(e.summary) && /pro/.test(e.summary)), JSON.stringify(audit).slice(0, 200));
    r = await O.call('PATCH', `/api/${SLUG}/users/${bId}`, { comp: true }, adm());
    check('admin comp grant → effective Ultra + comp flag', r.status === 200 && r.data.user.plan.plan === 'ultra' && r.data.user.plan.comp === true, JSON.stringify(r.data.user && r.data.user.plan).slice(0, 160));
    check('member me reflects comp (Ultra)', (await mePlan(B)) === 'ultra');
    audit = (await O.call('GET', `/api/${SLUG}/audit`, undefined, adm())).data.entries || [];
    check('audit has comp-grant', audit.some((e) => e.action === 'comp-grant' && e.targetUserId === bId));
    r = await O.call('PATCH', `/api/${SLUG}/users/${bId}`, { comp: false }, adm());
    check('admin comp revoke → back to Pro', r.status === 200 && r.data.user.plan.plan === 'pro' && r.data.user.plan.comp === false);
    audit = (await O.call('GET', `/api/${SLUG}/audit`, undefined, adm())).data.entries || [];
    check('audit has comp-revoke', audit.some((e) => e.action === 'comp-revoke' && e.targetUserId === bId));
    r = await O.call('PATCH', `/api/${SLUG}/users/${bId}`, { postLimitOverride: 500 }, adm());
    check('admin limit override set → 500', r.status === 200 && r.data.user.postLimitOverride === 500, JSON.stringify(r.data).slice(0, 140));
    audit = (await O.call('GET', `/api/${SLUG}/audit`, undefined, adm())).data.entries || [];
    check('audit has limit-override', audit.some((e) => e.action === 'limit-override' && e.targetUserId === bId && /500/.test(e.summary)));
    r = await O.call('PATCH', `/api/${SLUG}/users/${bId}`, { postLimitOverride: '' }, adm());
    check('admin limit override cleared → 0', r.status === 200 && r.data.user.postLimitOverride === 0);
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    r = await O.call('PATCH', `/api/${SLUG}/users/${bId}`, { planExpiresAt: yesterday }, adm());
    check('admin sets past expiry → member falls back to Free', r.status === 200 && (await mePlan(B)) === 'free', `me=${await mePlan(B)}`);
    audit = (await O.call('GET', `/api/${SLUG}/audit`, undefined, adm())).data.entries || [];
    check('audit has plan-expiry', audit.some((e) => e.action === 'plan-expiry' && e.targetUserId === bId));
    r = await O.call('PATCH', `/api/${SLUG}/users/${bId}`, { planExpiresAt: '' }, adm());
    check('admin clears expiry → Pro active again', r.status === 200 && (await mePlan(B)) === 'pro');
    r = await O.call('GET', `/api/${SLUG}/overview`, undefined, adm());
    check('overview totals sane', r.status === 200 && r.data.users.total >= 8 && r.data.users.byPlan.pro >= 1 && typeof r.data.posts.total === 'number', JSON.stringify(r.data.users || {}).slice(0, 140));
    r = await B.call('PATCH', `/api/${SLUG}/users/${cId}`, { plan: 'ultra' }, { headers: { 'x-admin-token': adminToken } });
    check('SEC member with stolen token still → 404 (owner identity required)', r.status === 404, `got ${r.status}`);
    r = await O.call('PATCH', `/api/${SLUG}/users/${bId}`, { plan: 'bogus' }, adm());
    check('admin rejects unknown plan → 400', r.status === 400, `got ${r.status}`);

    // ---------- S4: plan limits (member C, Free) ----------
    seedInstagram(dataDir, cId, [igAcct('999', 'cuser')]);
    const day = (y, m, d, h = 10) => new Date(y, m, d, h, 0, 0).toISOString();
    const now = new Date();
    const nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const NY = nm.getFullYear(); const NM = nm.getMonth();
    const post = (client, body) => client.call('POST', '/api/posts', {
      mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption: 't', format: 'REELS',
      status: 'scheduled', igEnabled: true, ...body,
    });
    r = await post(C, { scheduleTime: day(NY, NM, 1, 10) });
    check('Free post 1 on a day → 200', r.status === 200, JSON.stringify(r.data).slice(0, 140));
    r = await post(C, { scheduleTime: day(NY, NM, 1, 12) });
    check('Free post 2 on a day (at limit) → 200', r.status === 200, JSON.stringify(r.data).slice(0, 140));
    r = await post(C, { scheduleTime: day(NY, NM, 1, 14) });
    check('Free post 3 on a day → 403 PLAN_LIMIT daily', r.status === 403 && r.data.code === 'PLAN_LIMIT' && /one day/.test(r.data.error || ''), `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    check('daily denial names the way out (upgrade hint)', /upgrade/i.test(r.data.error || '') && /owner/.test(r.data.error || ''));
    r = await post(C, { scheduleTime: day(NY, NM, 1, 16), status: 'draft' });
    check('draft on a full day → 200 (drafts exempt)', r.status === 200, `got ${r.status}`);
    let fillOk = true;
    for (let d = 2; d <= 15; d++) {
      for (const h of [10, 12]) {
        const rr = await post(C, { scheduleTime: day(NY, NM, d, h) });
        if (rr.status !== 200) { fillOk = false; break; }
      }
      if (!fillOk) break;
    }
    check('Free fills to exactly 30 in the month', fillOk);
    r = await post(C, { scheduleTime: day(NY, NM, 16, 10) });
    check('Free post 31 in the month → 403 PLAN_LIMIT monthly', r.status === 403 && r.data.code === 'PLAN_LIMIT' && /in a month/.test(r.data.error || ''), `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    const nm2 = new Date(NY, NM + 1, 1);
    r = await post(C, { scheduleTime: day(nm2.getFullYear(), nm2.getMonth(), 1, 10) });
    check('month boundary resets the quota → 200', r.status === 200, `got ${r.status}`);

    // Bulk: cumulative plan counting (member D)
    seedInstagram(dataDir, dId, [igAcct('999', 'duser')]);
    const bulkRow = (h) => ({ mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption: 'bulk', format: 'REELS', status: 'scheduled', igEnabled: true, scheduleTime: day(NY, NM, 3, h) });
    r = await D.call('POST', '/api/posts/bulk', { posts: [bulkRow(9), bulkRow(11), bulkRow(13)] });
    check('bulk of 3 on one Free day → 2 imported, Row 3 plan error', r.status === 200 && r.data.imported === 2 && (r.data.errors || []).some((e) => /Row 3/.test(e) && /plan/i.test(e)), JSON.stringify(r.data).slice(0, 220));

    // Reschedule + PATCH enforcement (member D)
    r = await post(D, { scheduleTime: day(NY, NM, 4, 10) });
    const dPost = r.data.post;
    check('D spare-day post created', r.status === 200 && !!dPost);
    r = await D.call('POST', `/api/posts/${dPost.id}/reschedule`, { scheduleTime: day(NY, NM, 3, 15) });
    check('reschedule onto a full day → 403 PLAN_LIMIT', r.status === 403 && r.data.code === 'PLAN_LIMIT', `got ${r.status}`);
    r = await D.call('PATCH', `/api/posts/${dPost.id}`, { scheduleTime: day(NY, NM, 3, 16) });
    check('PATCH move onto a full day → 403 PLAN_LIMIT', r.status === 403 && r.data.code === 'PLAN_LIMIT', `got ${r.status}`);
    const dFull = (await D.call('GET', '/api/posts?limit=50')).data.posts.find((p) => p.scheduleTime === day(NY, NM, 3, 9));
    r = await D.call('PATCH', `/api/posts/${dFull.id}`, { caption: 'quiet caption edit' });
    check('caption-only edit on a full day → 200 (not re-checked)', r.status === 200 && r.data.post.caption === 'quiet caption edit', `got ${r.status}`);

    // ---------- S5: account coverage (member H, 2 IG accounts) ----------
    seedInstagram(dataDir, hId, [
      igAcct('111', 'firstacct', { connectedAt: '2026-01-01T00:00:00.000Z' }),
      igAcct('222', 'secondacct', { connectedAt: '2026-02-01T00:00:00.000Z' }),
    ], '111');
    r = await post(H, { scheduleTime: day(NY, NM, 5, 10), igTargets: ['222'] });
    check('Free post to 2nd IG account → 403 not covered', r.status === 403 && r.data.code === 'PLAN_LIMIT' && /not covered/.test(r.data.error || ''), `got ${r.status} ${JSON.stringify(r.data).slice(0, 180)}`);
    r = await post(H, { scheduleTime: day(NY, NM, 5, 10), igTargets: ['111', '222'] });
    check('Free post to 2 IG accounts → 403 over account cap', r.status === 403 && r.data.code === 'PLAN_LIMIT', `got ${r.status}`);
    r = await post(H, { scheduleTime: day(NY, NM, 5, 10), igTargets: ['111'] });
    check('Free post to 1st IG account → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.data).slice(0, 140)}`);
    seedYouTube(dataDir, hId);
    r = await post(H, { scheduleTime: day(NY, NM, 6, 10), igTargets: ['222'] });
    check('Free with YouTube connected: 2nd IG still not covered → 403', r.status === 403 && r.data.code === 'PLAN_LIMIT', `got ${r.status}`);
    await O.call('PATCH', `/api/${SLUG}/users/${hId}`, { comp: true }, adm());
    r = await post(H, { scheduleTime: day(NY, NM, 6, 11), igTargets: ['111', '222'] });
    check('comp (Ultra) post to both accounts → 200', r.status === 200, `got ${r.status}`);
    await O.call('PATCH', `/api/${SLUG}/users/${hId}`, { comp: false }, adm());
    r = await post(H, { scheduleTime: day(NY, NM, 6, 12), igTargets: ['222'] });
    check('comp removed → 2nd account blocked again → 403', r.status === 403, `got ${r.status}`);

    // ---------- S6: upgrade/downgrade + grandfathering (member C) ----------
    await O.call('PATCH', `/api/${SLUG}/users/${cId}`, { plan: 'pro' }, adm());
    const past = new Date(Date.now() - 3600000).toISOString();
    r = await post(C, { scheduleTime: past, caption: 'grandfather me' });
    check('Pro: due post created', r.status === 200 && !!r.data.post, `got ${r.status}`);
    const dueId = r.data.post.id;
    await O.call('PATCH', `/api/${SLUG}/users/${cId}`, { plan: 'free' }, adm());
    r = await C.call('POST', '/api/publish-due');
    const cPosts = (await C.call('GET', '/api/posts?limit=500')).data.posts || [];
    const duePost = cPosts.find((p) => p.id === dueId);
    check('grandfathered queue still publishes after downgrade', r.status === 200 && !!duePost && duePost.status === 'published', `due=${duePost && duePost.status}`);
    const todayAt = (h) => { const t = new Date(); t.setHours(h, 0, 0, 0); return t.toISOString(); };
    r = await post(C, { scheduleTime: todayAt(23) });
    check('downgraded Free: 2nd post today → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.data).slice(0, 140)}`);
    r = await post(C, { scheduleTime: todayAt(22) });
    check('downgraded Free: 3rd post today → 403 daily (new schedules bite)', r.status === 403 && r.data.code === 'PLAN_LIMIT', `got ${r.status}`);

    // ---------- S7: pre-flight ----------
    const pf = (client, body) => client.call('POST', '/api/posts/preflight', {
      mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption: 'pf', format: 'REELS',
      status: 'scheduled', igEnabled: true, scheduleTime: day(NY, NM, 20, 10), ...body,
    });
    const pfCheck = (r, id) => (r.data.checks || []).find((c) => c.id === id) || {};
    r = await pf(E, {});
    check('preflight no-IG user → connection check fails (not connected)', r.status === 200 && pfCheck(r, 'connection').ok === false && /not connected/.test(pfCheck(r, 'connection').message || ''), JSON.stringify(r.data).slice(0, 220));
    r = await pf(E, { mediaUrl: '' });
    check('preflight missing media → media check fails', pfCheck(r, 'media').ok === false, JSON.stringify(r.data).slice(0, 200));
    seedInstagram(dataDir, fId, [igAcct('999', 'fuser', { tokenRefreshError: 'revoked-or-expired' })]);
    r = await pf(F, {});
    check('preflight broken connection → connection check fails (broken)', pfCheck(r, 'connection').ok === false && /broken/.test(pfCheck(r, 'connection').message || ''), JSON.stringify(r.data).slice(0, 220));
    r = await pf(C, { scheduleTime: day(NY, NM, 1, 18) });
    check('preflight over-limit day → plan check fails', pfCheck(r, 'plan').ok === false && /plan/i.test(pfCheck(r, 'plan').message || ''), JSON.stringify(r.data).slice(0, 220));
    r = await post(C, { scheduleTime: day(NY, NM, 1, 18) });
    check('preflight agrees with enforcement (create also 403)', r.status === 403, `got ${r.status}`);
    r = await pf(D, { scheduleTime: day(NY, NM, 21, 10) });
    check('preflight clean post → all checks green', r.status === 200 && r.data.ok === true && (r.data.checks || []).every((c) => c.ok) && r.data.plan.planName === 'Free', JSON.stringify(r.data).slice(0, 220));
    r = await pf(O, {});
    check('preflight owner → Ultra plan shown', r.status === 200 && r.data.plan.plan === 'ultra', JSON.stringify(r.data.plan || {}).slice(0, 120));

    // ---------- S8: IDOR + auth ----------
    const cPostId = cPosts[0] && cPosts[0].id;
    r = await B.call('PATCH', `/api/posts/${cPostId}`, { caption: 'hijack' });
    check('SEC IDOR: B cannot PATCH C post → 404', r.status === 404, `got ${r.status}`);
    r = await B.call('DELETE', `/api/posts/${cPostId}`);
    check('SEC IDOR: B cannot DELETE C post → 404', r.status === 404, `got ${r.status}`);
    r = await B.call('POST', `/api/posts/${cPostId}/reschedule`, { scheduleTime: day(NY, NM, 22, 10) });
    check('SEC IDOR: B cannot reschedule C post → 404', r.status === 404, `got ${r.status}`);
    r = await B.call('GET', '/api/posts?limit=500');
    check('SEC IDOR: B post list contains none of C posts', r.status === 200 && !(r.data.posts || []).some((p) => p.id === cPostId));
    r = await anon.call('GET', '/api/posts');
    check('SEC anon GET /api/posts → 401', r.status === 401, `got ${r.status}`);
    r = await anon.call('POST', '/api/posts/preflight', {});
    check('SEC anon preflight → 401', r.status === 401, `got ${r.status}`);
    r = await anon.call('POST', '/api/posts', { mediaUrl: 'https://example.com/v.mp4' });
    check('SEC anon create post → 401', r.status === 401, `got ${r.status}`);

    // ---------- S9: server-rule bridge routing (member G) ----------
    seedInstagram(dataDir, gId, [igAcct('999', 'guser')]);
    r = await post(G, { mediaUrl: PNG_DATA_URL, mediaType: 'image', scheduleTime: day(NY, NM, 7, 10), caption: 'bridge one' });
    const g1 = r.data.post && r.data.post.id;
    check('G data-URL post 1 created', r.status === 200 && !!g1, `got ${r.status}`);
    r = await post(G, { mediaUrl: PNG_DATA_URL, mediaType: 'image', scheduleTime: day(NY, NM, 8, 10), caption: 'bridge two' });
    const g2 = r.data.post && r.data.post.id;
    check('G data-URL post 2 created', r.status === 200 && !!g2, `got ${r.status}`);
    r = await anon.call('POST', '/api/cron/token-refresh', undefined, { auth: 'Bearer batch2-cron-secret' });
    check('cron token-refresh runs', r.status === 200, `got ${r.status}`);
    const readPostsFile = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'posts.json'), 'utf8'));
    let filePosts = readPostsFile();
    const fp1 = filePosts.find((p) => p.id === g1);
    const fp2 = filePosts.find((p) => p.id === g2);
    check('Free bridge: next due post pre-bridged to a server /media/ URL', !!fp1 && String(fp1.mediaUrl).includes('/media/') && !String(fp1.mediaUrl).startsWith('data:'), fp1 && String(fp1.mediaUrl).slice(0, 30));
    check('Free bridge: later post NOT bridged yet (still data:)', !!fp2 && String(fp2.mediaUrl).startsWith('data:'), fp2 && String(fp2.mediaUrl).slice(0, 30));
    await O.call('PATCH', `/api/${SLUG}/users/${gId}`, { comp: true }, adm());
    r = await anon.call('POST', '/api/cron/token-refresh', undefined, { auth: 'Bearer batch2-cron-secret' });
    filePosts = readPostsFile();
    const fp2b = filePosts.find((p) => p.id === g2);
    check('Ultra bridge: whole queue pre-bridged after comp', !!fp2b && String(fp2b.mediaUrl).includes('/media/') && !String(fp2b.mediaUrl).startsWith('data:'), fp2b && String(fp2b.mediaUrl).slice(0, 30));

    // ---------- S10: owner bypass ----------
    let ownerOk = true;
    for (const h of [9, 11, 13]) {
      const rr = await post(O, { scheduleTime: day(NY, NM, 9, h) });
      if (rr.status !== 200) ownerOk = false;
    }
    check('owner schedules past Free daily limit (operator bypass)', ownerOk);

    // ---------- S11: PIN attempt cap (LAST — blocks for 10 min) ----------
    for (let i = 0; i < 5; i++) await O.call('POST', `/api/${SLUG}/unlock`, { pin: '0000' });
    r = await O.call('POST', `/api/${SLUG}/unlock`, { pin: '1357' });
    check('SEC PIN attempt cap: correct PIN refused after 5 wrong tries', r.status === 404, `got ${r.status}`);
    r = await O.call('GET', `/api/${SLUG}/status`);
    check('status reports pinBlocked to the owner', r.status === 200 && r.data.pinBlocked === true, JSON.stringify(r.data).slice(0, 120));

    console.log(`\nBATCH2: ${passes} passed, ${failures} failed`);
    if (failures) { console.log(getLog().slice(-600)); process.exitCode = 1; }
  } finally {
    server.kill('SIGKILL');
  }
}

main().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
