// KiluaAI multi-account support test suite.
//
// Boots the real server against an isolated JSON data dir (no MongoDB)
// with the Instagram Graph API stubbed at the fetch layer (a --require
// preload). The stub keys tokens/accounts off the OAuth `code`, so the
// FULL Unified-Login connect flow runs locally: connect-link ->
// ig-connect (302 to the dialog URL) -> ig-callback (code exchange +
// /me/assigned_instagram_accounts discovery) -> account stored. Publish
// calls are logged with their request bodies, so the suite can assert
// WHICH account's token each post was published with.
//
// Coverage: two accounts per user + default selection, per-post target
// stored at create, publish-due uses the matching token per post,
// disconnect of one account leaves the other + its posts intact, a post
// targeting a disconnected account fails with a notification and is
// NOT published from the other account, legacy single-connection
// records migrate lazily (publish keeps working, legacy top-level
// fields stay mirrored for rollback), and cross-user isolation.
//
// Run: node scripts/multi-account-test.js
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

const PORT = 3104;
const BASE = `http://127.0.0.1:${PORT}`;

// The Graph stub: code-alice -> token-alice -> IG 111 @alice, etc.
const STUB_SOURCE = `
const fs = require('fs');
const logFile = process.env.GRAPH_STUB_LOG;
const origFetch = globalThis.fetch;
const ACCOUNTS = {
  'code-alice': { token: 'token-alice', id: '111', username: 'alice' },
  'code-bob': { token: 'token-bob', id: '222', username: 'bob' },
  'code-carol': { token: 'token-carol', id: '333', username: 'carol' },
};
const BY_TOKEN = {};
for (const a of Object.values(ACCOUNTS)) BY_TOKEN[a.token] = a;
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
      if (code && ACCOUNTS[code]) return tokResp(ACCOUNTS[code].token);
      if (exch) return tokResp(exch);
      return tokResp('stub-token');
    }
    if (u.includes('refresh_access_token')) { const o = { expires_in: 5184000 }; o['access' + '_token'] = 'stub-token'; return json(o); }
    if (u.includes('assigned_instagram_accounts')) {
      const t = new URL(u).searchParams.get('access_token');
      const a = BY_TOKEN[t];
      return json({ data: a ? [{ id: a.id, username: a.username }] : [] });
    }
    if (method === 'POST' && u.includes('media_publish')) return json({ id: 'igmedia-stub-1' });
    if (method === 'POST' && /\\/(\\d+)\\/media(\\?|$)/.test(u)) return json({ id: 'ctr-' + u.match(/\\/(\\d+)\\/media/)[1] });
    if (u.includes('fields=status_code')) return json({ status_code: 'FINISHED' });
    if (u.includes('fields=permalink')) return json({ permalink: 'https://www.instagram.com/p/STUBPOST/', media_type: 'VIDEO' });
    return json({ id: '111', username: 'alice' });
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
      SESSION_SECRET: 'multi-account-test-secret-0123456789abcdef',
      CRON_SECRET: 'multi-cron-secret', META_APP_SECRET: 'multi-meta-secret',
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
  async function call(method, p, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
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
  return { call };
}

// Run the real Unified-Login connect flow for one account: mint a
// one-time link, open it (302 -> dialog URL carries the signed state),
// then land on the callback with the stub code for that account.
async function connectViaOAuth(client, code) {
  const link = await client.call('POST', '/api/instagram/ig-connect-link', {});
  if (!link.data || !link.data.url) throw new Error('connect-link failed: ' + JSON.stringify(link.data));
  const linkUrl = link.data.url;
  const dlg = await fetch(linkUrl, { redirect: 'manual' });
  const loc = dlg.headers.get('location') || '';
  const state = new URL(loc).searchParams.get('state');
  if (!state) throw new Error('no state in dialog redirect: ' + loc);
  const cb = await fetch(`${BASE}/api/instagram/ig-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  const text = await cb.text();
  return { linkUrl, status: cb.status, text };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-multi-'));
  const stubLog = path.join(dataDir, 'graph.log');
  const { server, getLog } = startServer({ port: PORT, dataDir, stubLog });
  process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* dead */ } });
  const up = await waitUp(BASE);
  check('server boots', up);
  if (!up) { console.log(getLog()); process.exit(1); }
  const graphLog = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : '');
  const past = () => new Date(Date.now() - 60000).toISOString();
  const postBody = (extra = {}) => ({ mediaUrl: 'https://example.com/reel.mp4', mediaType: 'video', caption: 'hello', format: 'REELS', scheduleTime: past(), ...extra });

  // ---- users ----
  const A = makeClient(BASE);
  const B = makeClient(BASE);
  const C = makeClient(BASE);
  let r = await A.call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  check('signup A (owner)', r.status === 200 && r.data.user?.role === 'owner', JSON.stringify(r.data));
  const userAId = r.data.user.id;
  r = await B.call('POST', '/api/auth/signup', { email: 'b@example.com', password: 'password123' });
  check('signup B', r.status === 200, JSON.stringify(r.data));
  r = await C.call('POST', '/api/auth/signup', { email: 'c@example.com', password: 'password123' });
  check('signup C', r.status === 200, JSON.stringify(r.data));
  const userCId = r.data.user.id;

  // ---- A connects alice, then bob ----
  const c1 = await connectViaOAuth(A, 'code-alice');
  check('connect alice: callback page confirms', c1.status === 200 && /Instagram connected/.test(c1.text), c1.text.slice(0, 200));
  r = await A.call('GET', '/api/settings');
  check('A: one account after first connect', (r.data.instagramAccounts || []).length === 1, JSON.stringify(r.data.instagramAccounts));
  check('A: alice is default', r.data.defaultIgUserId === '111' && r.data.instagramAccounts?.[0]?.username === 'alice' && r.data.instagramAccounts?.[0]?.isDefault === true, JSON.stringify(r.data.instagramAccounts));
  check('A: legacy settings fields show alice', r.data.instagramConnected === true && r.data.instagramUsername === 'alice');

  const c2 = await connectViaOAuth(A, 'code-bob');
  check('connect bob: callback page confirms', c2.status === 200 && /Instagram connected/.test(c2.text), c2.text.slice(0, 200));
  r = await A.call('GET', '/api/settings');
  check('A: two accounts after second connect', (r.data.instagramAccounts || []).length === 2, JSON.stringify(r.data.instagramAccounts));
  check('A: default stays alice after adding bob', r.data.defaultIgUserId === '111' && r.data.instagramUsername === 'alice', JSON.stringify({ d: r.data.defaultIgUserId, u: r.data.instagramUsername }));
  const bobSummary = (r.data.instagramAccounts || []).find((a) => a.igUserId === '222');
  check('A: bob listed, not default, never-expiring health', !!bobSummary && bobSummary.isDefault === false && bobSummary.health?.tokenNeverExpires === true, JSON.stringify(bobSummary));

  // Connect links stay single-use (fix-round behaviour preserved).
  const replay = await fetch(c1.linkUrl, { redirect: 'manual' });
  check('connect link replay -> 401 page', replay.status === 401, `got ${replay.status}`);

  // ---- scheduling: targets stored per post ----
  r = await A.call('POST', '/api/posts', postBody({ caption: 'for default' }));
  const pDefault = r.data.post;
  check('post without target stores the default account', r.status === 200 && pDefault.igAccountId === '111' && pDefault.igAccountUsername === 'alice', JSON.stringify(pDefault));
  r = await A.call('POST', '/api/posts', postBody({ caption: 'for bob', igAccountId: '222' }));
  const pBob = r.data.post;
  check('post with target stores bob', r.status === 200 && pBob.igAccountId === '222' && pBob.igAccountUsername === 'bob', JSON.stringify(pBob));
  r = await A.call('POST', '/api/posts', postBody({ igAccountId: '999' }));
  check('post targeting an unconnected account -> 400', r.status === 400, `got ${r.status}`);

  // ---- publish-due: each post uses its own account's token ----
  const logBefore = graphLog();
  r = await A.call('POST', '/api/publish-due', {});
  const newCalls = graphLog().slice(logBefore.length);
  check('publish-due published both posts', r.status === 200 && (r.data.published || []).length === 2, JSON.stringify(r.data));
  check('alice post published via /111/media with token-alice', /POST https:\/\/graph\.facebook\.com\/v27\.0\/111\/media/.test(newCalls) && newCalls.includes('"access_token":"token-alice"'), newCalls.slice(0, 400));
  check('bob post published via /222/media with token-bob', /POST https:\/\/graph\.facebook\.com\/v27\.0\/222\/media/.test(newCalls) && newCalls.includes('"access_token":"token-bob"'), newCalls.slice(0, 400));
  r = await A.call('GET', '/api/posts');
  const byId = Object.fromEntries((r.data.posts || []).map((p) => [p.id, p]));
  check('both posts now published', byId[pDefault.id]?.status === 'published' && byId[pBob.id]?.status === 'published', JSON.stringify({ a: byId[pDefault.id]?.status, b: byId[pBob.id]?.status }));

  // ---- default switching ----
  r = await A.call('POST', '/api/instagram/default', { igUserId: '222' });
  check('set default to bob', r.status === 200 && r.data.defaultIgUserId === '222', JSON.stringify(r.data));
  r = await A.call('GET', '/api/settings');
  check('legacy mirror follows the new default (bob)', r.data.instagramUsername === 'bob' && r.data.defaultIgUserId === '222');
  r = await A.call('POST', '/api/posts', postBody({ caption: 'new default post' }));
  check('new post now stores bob as target', r.data.post?.igAccountId === '222', JSON.stringify(r.data.post));
  const pBobDefault = r.data.post;
  r = await A.call('POST', '/api/instagram/default', { igUserId: '999' });
  check('set default to unconnected account -> 404', r.status === 404, `got ${r.status}`);

  // ---- disconnect the default: promotion + mirror ----
  r = await A.call('POST', '/api/instagram/disconnect', { igUserId: '222' });
  check('disconnect bob: still connected via alice', r.status === 200 && r.data.instagramConnected === true && r.data.instagramUsername === 'alice', JSON.stringify(r.data));
  check('disconnect bob: one account left, alice promoted to default', (r.data.instagramAccounts || []).length === 1 && r.data.defaultIgUserId === '111', JSON.stringify(r.data.instagramAccounts));
  const rawAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'instagram.json'), 'utf8'));
  const docA = rawAfter[userAId];
  check('stored doc: accounts array materialised with alice only', Array.isArray(docA?.accounts) && docA.accounts.length === 1 && docA.accounts[0].igUserId === '111', JSON.stringify(Object.keys(docA || {})));
  check('stored doc: legacy top-level mirror intact (rollback-safe)', docA?.username === 'alice' && docA?.igUserId === '111' && !!docA?.tokenEnc, JSON.stringify({ u: docA?.username, ig: docA?.igUserId }));

  // The post that targeted bob (already published) is unaffected; the
  // scheduled one targeting bob-as-default still has target 222 stored.
  r = await A.call('GET', '/api/posts');
  const byId2 = Object.fromEntries((r.data.posts || []).map((p) => [p.id, p]));
  check('published bob post untouched by disconnect', byId2[pBob.id]?.status === 'published');

  // ---- disconnected target: loud failure, no cross-account publish ----
  await connectViaOAuth(A, 'code-bob'); // reconnect bob
  r = await A.call('POST', '/api/posts', postBody({ caption: 'bob again', igAccountId: '222' }));
  const pBob2 = r.data.post;
  r = await A.call('POST', '/api/posts', postBody({ caption: 'alice again', igAccountId: '111' }));
  const pAlice2 = r.data.post;
  await A.call('POST', '/api/instagram/disconnect', { igUserId: '222' });
  const logBefore2 = graphLog();
  r = await A.call('POST', '/api/publish-due', {});
  const newCalls2 = graphLog().slice(logBefore2.length);
  check('publish-due: alice post published, bob post failed', (r.data.published || []).some((p) => p.id === pAlice2.id) && (r.data.failed || []).some((p) => p.id === pBob2.id), JSON.stringify(r.data));
  check('no Graph publish happened for the disconnected account', !newCalls2.includes('/222/media') && !newCalls2.includes('token-bob'), newCalls2.slice(0, 300));
  check('exactly one media_publish in that run (alice only)', (newCalls2.match(/media_publish/g) || []).length === 1, newCalls2.slice(0, 300));
  r = await A.call('GET', '/api/posts');
  const byId3 = Object.fromEntries((r.data.posts || []).map((p) => [p.id, p]));
  check('disconnected-target post marked failed with clear reason', byId3[pBob2.id]?.status === 'failed' && /no longer connected/.test(byId3[pBob2.id]?.lastPublishError || ''), JSON.stringify(byId3[pBob2.id]));
  r = await A.call('GET', '/api/notifications');
  check('failure notification recorded for the disconnected-target post', (r.data.notifications || []).some((n) => n.type === 'publish-failure' && n.postId === pBob2.id && /no longer connected/.test(n.message || '')), JSON.stringify((r.data.notifications || []).slice(0, 3)));
  // The orphaned scheduled post from the default-switch step (target
  // 222, never published) also failed in an earlier/later run — assert
  // it was never published either.
  check('earlier bob-targeted scheduled post not published from alice', byId3[pBobDefault.id]?.status !== 'published', JSON.stringify(byId3[pBobDefault.id]?.status));

  // ---- publish-now on a disconnected target also fails loudly ----
  await connectViaOAuth(A, 'code-bob');
  r = await A.call('POST', '/api/posts', postBody({ caption: 'bob three', igAccountId: '222', scheduleTime: new Date(Date.now() + 3600000).toISOString() }));
  const pBob3 = r.data.post;
  await A.call('POST', '/api/instagram/disconnect', { igUserId: '222' });
  r = await A.call('POST', `/api/posts/${pBob3.id}/publish`, {});
  check('publish-now on disconnected target -> 400 with clear message', r.status === 400 && /no longer connected/.test(r.data.error || ''), JSON.stringify(r.data));

  // ---- isolation: user B ----
  r = await B.call('GET', '/api/settings');
  check('B: no accounts visible', (r.data.instagramAccounts || []).length === 0 && r.data.instagramConnected === false, JSON.stringify(r.data.instagramAccounts));
  r = await B.call('POST', '/api/posts', postBody({ igAccountId: '111' }));
  check("B: cannot schedule to A's account -> 400", r.status === 400, `got ${r.status}`);
  r = await B.call('POST', '/api/instagram/default', { igUserId: '111' });
  check("B: cannot set A's account as default -> 404", r.status === 404, `got ${r.status}`);
  r = await B.call('POST', '/api/instagram/disconnect', { igUserId: '111' });
  r = await A.call('GET', '/api/settings');
  check("A: alice survives B's bogus disconnect", (r.data.instagramAccounts || []).some((a) => a.igUserId === '111') && r.data.instagramConnected === true, JSON.stringify(r.data.instagramAccounts));
  r = await B.call('GET', '/api/posts');
  check("B: sees none of A's posts", (r.data.posts || []).length === 0, JSON.stringify((r.data.posts || []).length));

  // ---- legacy migration: user C with a pre-multi-account record ----
  const legacyDoc = {
    [userCId]: {
      token: 'legacy-token', igUserId: '777', username: 'legacy', pageId: '',
      connectedAt: new Date().toISOString(), tokenType: 'SYSTEM_USER', tokenNeverExpires: true, tokenHost: 'facebook',
    },
  };
  const igFile = path.join(dataDir, 'instagram.json');
  const existing = fs.existsSync(igFile) ? JSON.parse(fs.readFileSync(igFile, 'utf8')) : {};
  fs.writeFileSync(igFile, JSON.stringify({ ...existing, ...legacyDoc }, null, 2));
  r = await C.call('GET', '/api/settings');
  check('C: legacy connection reads as one migrated account (default)', r.data.instagramConnected === true && r.data.instagramUsername === 'legacy' && (r.data.instagramAccounts || []).length === 1 && r.data.defaultIgUserId === '777', JSON.stringify({ u: r.data.instagramUsername, n: (r.data.instagramAccounts || []).length, d: r.data.defaultIgUserId }));
  r = await C.call('POST', '/api/posts', postBody({ caption: 'legacy post' }));
  const pLegacy = r.data.post;
  check('C: new post targets the migrated legacy account', pLegacy?.igAccountId === '777', JSON.stringify(pLegacy));
  const logBefore3 = graphLog();
  r = await C.call('POST', `/api/posts/${pLegacy.id}/publish`, {});
  const newCalls3 = graphLog().slice(logBefore3.length);
  check('C: legacy post publishes with the legacy token', r.status === 200 && newCalls3.includes('/777/media') && newCalls3.includes('"access_token":"legacy-token"'), JSON.stringify(r.data) + ' ' + newCalls3.slice(0, 200));
  // Adding a second account materialises the list and keeps legacy as default.
  await connectViaOAuth(C, 'code-carol');
  r = await C.call('GET', '/api/settings');
  check('C: legacy + carol coexist, legacy stays default', (r.data.instagramAccounts || []).length === 2 && r.data.defaultIgUserId === '777' && r.data.instagramUsername === 'legacy', JSON.stringify(r.data.instagramAccounts));
  const rawC = JSON.parse(fs.readFileSync(igFile, 'utf8'))[userCId];
  check('C: stored doc materialised accounts + legacy mirror kept', Array.isArray(rawC?.accounts) && rawC.accounts.length === 2 && rawC.username === 'legacy' && rawC.igUserId === '777', JSON.stringify({ n: rawC?.accounts?.length, u: rawC?.username }));

  // ---- db-status: default account surfaced as before + counts ----
  r = await A.call('GET', '/api/db-status');
  check('db-status ok with instagram diagnostic', r.data.ok === true && !!r.data.instagram && r.data.instagram.connected === true, JSON.stringify(r.data.instagramDiag));
  check('db-status surfaces the default account (@alice for the owner)', r.data.instagram.username === 'alice', JSON.stringify(r.data.instagram));
  check('db-status counts connected accounts (A:1 + C:2 = 3)', r.data.instagramDiag?.accountsConnected === 3, JSON.stringify(r.data.instagramDiag));

  // ---- cron token-refresh runs the keeper per connection ----
  r = await A.call('POST', '/api/cron/token-refresh', {}, { auth: 'Bearer multi-cron-secret' });
  const entryC = (r.data.summary || []).find((s) => s.userId === userCId);
  check('cron token-refresh reports per-account health for C', r.status === 200 && !!entryC && Array.isArray(entryC.accounts) && entryC.accounts.length === 1 && entryC.accounts[0].igUserId === '333', JSON.stringify(entryC));

  try { server.kill('SIGTERM'); } catch { /* dead */ }
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
