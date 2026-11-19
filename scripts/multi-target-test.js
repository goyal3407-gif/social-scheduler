// KiluaAI multi-target Instagram test suite.
//
// Boots the real server against an isolated JSON data dir (no MongoDB)
// with the Instagram Graph API + Google/YouTube stubbed at the fetch
// layer (a --require preload). Two Instagram accounts are connected
// through the real Unified-Login OAuth flow (alice=111/token-alice,
// bob=222/token-bob), so the suite can assert WHICH account's token
// each target published with.
//
// Coverage: two accounts ticked -> both publish with their own tokens
// and per-target first comments; one target fails -> post is Partial,
// only that target retries (at its armed retry time, via publish-due),
// and the media bridge copy survives until EVERY target is terminal;
// zero targets + no YouTube -> 400; zero targets + YouTube -> a valid
// YouTube-only post; an unconnected ticked account -> 400 at save;
// legacy posts (create with only igAccountId, and a hand-written
// pre-multi-target record with no igTargets at all) still publish;
// a YouTube-only post publishes with zero Graph calls.
//
// The bob failure is driven by a flag file the stub checks, so the
// test can flip bob from failing to healthy mid-run.
//
// Run: node scripts/multi-target-test.js
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

const PORT = 3105;
const BASE = `http://127.0.0.1:${PORT}`;
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const GRAPH_STUB = `
  if (u.includes('graph.facebook.com') || u.includes('graph.instagram.com')) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    const body = (opts && typeof opts.body === 'string') ? opts.body : '';
    if (logFile) { try { fs.appendFileSync(logFile, method + ' ' + u + (body ? ' BODY ' + body : '') + '\\n'); } catch {} }
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
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
    if (method === 'POST' && /\\/(\\d+)\\/media(\\?|$)/.test(u)) {
      const acct = u.match(/\\/(\\d+)\\/media/)[1];
      if (acct === '222' && failFlag && fs.existsSync(failFlag)) {
        return json({ error: { message: 'stub bob create failure', code: 100, type: 'OAuthException' } }, 400);
      }
      return json({ id: 'ctr-' + acct });
    }
    if (u.includes('fields=status_code')) return json({ status_code: 'FINISHED' });
    if (u.includes('fields=permalink')) return json({ permalink: 'https://www.instagram.com/p/STUBPOST/', media_type: 'VIDEO' });
    return json({ id: '111', username: 'alice' });
  }
`;

const GOOGLE_STUB = `
  if (u.includes('oauth2.googleapis.com/token')) {
    const body = typeof opts.body === 'string' ? opts.body : '';
    const params = new URLSearchParams(body);
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    if (params.get('grant_type') === 'authorization_code') {
      if (params.get('code') === 'yt-code-good') { const o = { expires_in: 3600, token_type: 'Bearer' }; o['access' + '_token'] = 'yt-access-1'; o['refresh' + '_token'] = 'yt-refresh-1'; return json(o); }
      return json({ error: 'invalid_grant' }, 400);
    }
    if (params.get('grant_type') === 'refresh_token') {
      if (params.get('refresh_token') === 'yt-refresh-1') { const o = { expires_in: 3600, token_type: 'Bearer' }; o['access' + '_token'] = 'yt-access-2'; return json(o); }
      return json({ error: 'invalid_grant' }, 400);
    }
    return json({ error: 'unsupported' }, 400);
  }
  if (u.includes('googleapis.com/youtube/v3/channels')) {
    return new Response(JSON.stringify({ items: [{ id: 'chan-1', snippet: { title: 'Test Channel', thumbnails: { default: { url: 'https://yt.example/thumb.jpg' } } } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('googleapis.com/upload/youtube/v3/videos')) {
    return new Response('', { status: 200, headers: { Location: 'https://upload.stub/session-1' } });
  }
  if (u.startsWith('https://upload.stub/')) {
    return new Response(JSON.stringify({ id: 'ytvid-123' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.startsWith('https://example.com/')) {
    return new Response(Buffer.from('fake-video-bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4' } });
  }
`;

const STUB_SOURCE = `
const fs = require('fs');
const logFile = process.env.GRAPH_STUB_LOG;
const failFlag = process.env.FAIL_FLAG;
const origFetch = globalThis.fetch;
const ACCOUNTS = {
  'code-alice': { token: 'token-alice', id: '111', username: 'alice' },
  'code-bob': { token: 'token-bob', id: '222', username: 'bob' },
};
const BY_TOKEN = {};
for (const a of Object.values(ACCOUNTS)) BY_TOKEN[a.token] = a;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  ${GRAPH_STUB}
  ${GOOGLE_STUB}
  return origFetch(url, opts);
};
`;

function startServer({ port, dataDir, stubLog, failFlag }) {
  const stubPath = path.join(dataDir, 'stub.cjs');
  fs.writeFileSync(stubPath, STUB_SOURCE);
  const server = spawn('node', ['--require', stubPath, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir,
      SESSION_SECRET: 'multi-target-test-secret-0123456789abcdef',
      CRON_SECRET: 'mt-cron-secret', META_APP_SECRET: 'mt-meta-secret',
      YOUTUBE_CLIENT_ID: 'yt-client-stub', YOUTUBE_CLIENT_SECRET: 'yt-secret-stub',
      GRAPH_STUB_LOG: stubLog, FAIL_FLAG: failFlag, NODE_ENV: 'test',
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

async function connectViaOAuth(client, code) {
  const link = await client.call('POST', '/api/instagram/ig-connect-link', {});
  if (!link.data || !link.data.url) throw new Error('connect-link failed: ' + JSON.stringify(link.data));
  const dlg = await fetch(link.data.url, { redirect: 'manual' });
  const state = new URL(dlg.headers.get('location') || '').searchParams.get('state');
  if (!state) throw new Error('no state in dialog redirect');
  const cb = await fetch(`${BASE}/api/instagram/ig-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  return { status: cb.status, text: await cb.text() };
}

async function connectYouTube(client, code) {
  const link = await client.call('POST', '/api/youtube/connect-link', {});
  if (!link.data || !link.data.url) throw new Error('yt connect-link failed: ' + JSON.stringify(link.data));
  const dlg = await fetch(link.data.url, { redirect: 'manual' });
  const loc = dlg.headers.get('location') || '';
  const state = new URL(loc).searchParams.get('state');
  if (!state) throw new Error('no state in youtube dialog redirect: ' + loc);
  const cb = await fetch(`${BASE}/api/youtube/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  return { status: cb.status, text: await cb.text() };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-mtarget-'));
  const stubLog = path.join(dataDir, 'graph.log');
  const failFlag = path.join(dataDir, 'fail-bob.flag');
  const { server, getLog } = startServer({ port: PORT, dataDir, stubLog, failFlag });
  process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* dead */ } });
  const up = await waitUp(BASE);
  check('server boots', up);
  if (!up) { console.log(getLog()); process.exit(1); }
  const graphLog = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : '');
  const clearLog = () => { try { fs.writeFileSync(stubLog, ''); } catch { /* fresh */ } };
  const past = () => new Date(Date.now() - 60000).toISOString();
  const postsFile = path.join(dataDir, 'posts.json');
  const readPostsFile = () => JSON.parse(fs.readFileSync(postsFile, 'utf8'));
  const getPost = async (client, id) => {
    const r = await client.call('GET', '/api/posts?limit=500');
    return (r.data.posts || []).find((p) => p.id === id);
  };

  // ---- user + two Instagram accounts + YouTube ----
  const A = makeClient(BASE);
  let r = await A.call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'password123' });
  check('signup A (owner)', r.status === 200 && !!r.data.user?.id, JSON.stringify(r.data));
  const userAId = r.data.user.id;
  await connectViaOAuth(A, 'code-alice');
  await connectViaOAuth(A, 'code-bob');
  r = await A.call('GET', '/api/settings');
  check('two Instagram accounts connected', (r.data.instagramAccounts || []).length === 2, JSON.stringify(r.data.instagramAccounts));
  const yt = await connectYouTube(A, 'yt-code-good');
  check('YouTube connected', yt.status === 200, yt.text.slice(0, 120));

  // ---- validation: zero targets ----
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/reel.mp4', mediaType: 'video', caption: 'none', format: 'REELS', scheduleTime: past(), igTargets: [] });
  check('zero targets + no YouTube -> 400 tick-at-least-one', r.status === 400 && /Tick at least one platform/.test(r.data.error || ''), JSON.stringify(r.data));
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/reel.mp4', mediaType: 'video', caption: 'ghost', format: 'REELS', scheduleTime: past(), igTargets: ['999'] });
  check('ticked account that is not connected -> 400 at save', r.status === 400 && /not connected/.test(r.data.error || ''), JSON.stringify(r.data));
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/yt.mp4', mediaType: 'video', caption: 'yt via empty targets', format: 'REELS', scheduleTime: past(), igTargets: [], youtube: { enabled: true, title: 'YT via empty targets' } });
  check('zero targets + YouTube ticked -> created as YouTube-only', r.status === 200 && r.data.post?.igEnabled === false && Array.isArray(r.data.post?.igTargets) && r.data.post.igTargets.length === 0, JSON.stringify(r.data.post || r.data));

  // ---- (1) two targets: both publish, each with its own token ----
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/reel.mp4', mediaType: 'video', caption: 'both accounts', format: 'REELS', scheduleTime: past(), igTargets: ['111', '222'], firstComment: '#tags #here' });
  check('create with two targets stores both + first-target mirror', r.status === 200 && (r.data.post?.igTargets || []).length === 2
    && r.data.post.igTargets[0].igUserId === '111' && r.data.post.igTargets[0].username === 'alice'
    && r.data.post.igTargets[1].igUserId === '222' && r.data.post.igTargets[1].username === 'bob'
    && r.data.post.igAccountId === '111' && r.data.post.igAccountUsername === 'alice', JSON.stringify(r.data.post || r.data));
  const post1 = r.data.post;
  clearLog();
  r = await A.call('POST', '/api/publish-due', {});
  check('publish-due reports the two-target post published', (r.data.published || []).some((p) => p.id === post1.id), JSON.stringify(r.data));
  const log1 = graphLog();
  check('alice target created with token-alice', /POST .*\/111\/media /.test(log1) && log1.includes('token-alice'), log1.slice(0, 400));
  check('bob target created with token-bob', /POST .*\/222\/media /.test(log1) && log1.includes('token-bob'), log1.slice(0, 400));
  check('exactly two media_publish calls (one per target)', (log1.match(/media_publish/g) || []).length === 2, log1.slice(0, 400));
  const commentLines = log1.split('\n').filter((l) => l.includes('/comments'));
  check('first comment posted once per target, each with its own token', commentLines.length === 2
    && commentLines.some((l) => l.includes('token-alice')) && commentLines.some((l) => l.includes('token-bob')), commentLines.join(' | '));
  const p1 = await getPost(A, post1.id);
  check('post published with both targets published + liveUrls', p1?.status === 'published'
    && (p1.igTargets || []).every((t) => t.status === 'published' && /instagram\.com\/p\/STUBPOST/.test(t.liveUrl || ''))
    && /instagram\.com\/p\/STUBPOST/.test(p1.liveUrl || ''), JSON.stringify(p1).slice(0, 400));

  // ---- (3)+(4) one target fails -> Partial, retry is per-target,
  //      and the media copy survives until every target is terminal ----
  r = await A.call('POST', '/api/media/upload', { name: 'mt-bridge.png', dataUrl: PNG_DATA_URL });
  check('media upload ok', r.status === 200 && !!r.data.media?.id, JSON.stringify(r.data).slice(0, 200));
  const item = r.data.media;
  fs.writeFileSync(failFlag, '1');
  r = await A.call('POST', '/api/posts', { mediaUrl: item.url, mediaType: 'image', caption: 'partial post', format: 'FEED', scheduleTime: past(), igTargets: ['111', '222'] });
  const post2 = r.data.post;
  check('partial-candidate post created', r.status === 200 && !!post2?.id, JSON.stringify(r.data).slice(0, 200));
  r = await A.call('POST', '/api/publish-due', {});
  check('publish-due counts a partial publish as published (ok)', (r.data.published || []).some((p) => p.id === post2.id), JSON.stringify(r.data));
  const p2 = await getPost(A, post2.id);
  const tAlice = (p2?.igTargets || []).find((t) => t.igUserId === '111');
  const tBob = (p2?.igTargets || []).find((t) => t.igUserId === '222');
  check('post is Partial: alice live, bob failed with retry armed', p2?.status === 'partial'
    && tAlice?.status === 'published' && tBob?.status === 'failed' && tBob?.retryPending === true
    && p2?.retryPending === true && /STUBPOST/.test(p2?.liveUrl || ''), JSON.stringify(p2).slice(0, 500));
  r = await A.call('GET', '/api/notifications');
  check('failure notification names the failed account', (r.data.notifications || []).some((n) => n.type === 'publish-failure' && n.postId === post2.id && /@bob/.test(n.message || '')), JSON.stringify((r.data.notifications || []).slice(0, 3)));
  const fileRes1 = await fetch(`${BASE}${new URL(item.url).pathname}`);
  check('media bridge copy NOT deleted while bob is non-terminal', fileRes1.status === 200, `got ${fileRes1.status}`);
  await fileRes1.text().catch(() => {});
  // Bob recovers; move his retry into the past and sweep again.
  fs.unlinkSync(failFlag);
  const stored = readPostsFile();
  const sp2 = stored.find((p) => p.id === post2.id);
  sp2.igTargets = sp2.igTargets.map((t) => (t.igUserId === '222' ? { ...t, retryAt: past() } : t));
  sp2.retryAt = past();
  fs.writeFileSync(postsFile, JSON.stringify(stored, null, 2));
  clearLog();
  r = await A.call('POST', '/api/publish-due', {});
  check('retry sweep publishes the partial post', (r.data.published || []).some((p) => p.id === post2.id), JSON.stringify(r.data));
  const log3 = graphLog();
  check('retry touched ONLY bob (no /111/media create, one publish)', !/POST .*\/111\/media /.test(log3) && /POST .*\/222\/media /.test(log3)
    && (log3.match(/media_publish/g) || []).length === 1, log3.slice(0, 400));
  const p2b = await getPost(A, post2.id);
  check('post fully published after the per-target retry', p2b?.status === 'published' && (p2b.igTargets || []).every((t) => t.status === 'published'), JSON.stringify(p2b).slice(0, 300));
  const fileRes2 = await fetch(`${BASE}${new URL(item.url).pathname}`);
  check('media bridge copy deleted once EVERY target is terminal', fileRes2.status === 404, `got ${fileRes2.status}`);
  await fileRes2.text().catch(() => {});
  r = await A.call('GET', '/api/media?limit=500');
  const itemAfter = (r.data.media || []).find((m) => m.id === item.id);
  check('library item marked serverCopyRemoved after all-terminal', itemAfter?.serverCopyRemoved === true, JSON.stringify(itemAfter));

  // ---- (6a) legacy create: only igAccountId -> one-element targets ----
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/legacy-create.mp4', mediaType: 'video', caption: 'legacy create', format: 'REELS', scheduleTime: past(), igAccountId: '222' });
  check('legacy igAccountId create becomes a one-element target list', r.status === 200 && (r.data.post?.igTargets || []).length === 1 && r.data.post.igTargets[0].igUserId === '222', JSON.stringify(r.data.post || r.data));
  const postLegacyCreate = r.data.post;
  clearLog();
  r = await A.call('POST', '/api/publish-due', {});
  check('legacy-create post publishes', (r.data.published || []).some((p) => p.id === postLegacyCreate.id), JSON.stringify(r.data));
  check('legacy-create post published with token-bob', /POST .*\/222\/media /.test(graphLog()) && graphLog().includes('token-bob'), graphLog().slice(0, 300));

  // ---- (6b) hand-written legacy record: no igTargets field at all ----
  const stored2 = readPostsFile();
  stored2.push({
    id: 'post-legacy-hand', userId: userAId,
    mediaUrl: 'https://example.com/legacy-hand.mp4', mediaType: 'video',
    caption: 'legacy hand-written', hashtags: '', cta: '', platform: 'Instagram',
    igAccountId: '111', igAccountUsername: 'alice', igEnabled: true,
    scheduleTime: past(), status: 'scheduled', format: 'REELS', liveUrl: '',
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(postsFile, JSON.stringify(stored2, null, 2));
  clearLog();
  r = await A.call('POST', '/api/publish-due', {});
  check('hand-written legacy post publishes', (r.data.published || []).some((p) => p.id === 'post-legacy-hand'), JSON.stringify(r.data));
  check('hand-written legacy post published with token-alice', /POST .*\/111\/media /.test(graphLog()) && graphLog().includes('token-alice'), graphLog().slice(0, 300));
  const pLegacy = await getPost(A, 'post-legacy-hand');
  check('legacy post gains a published igTargets list after publish', pLegacy?.status === 'published'
    && (pLegacy.igTargets || []).length === 1 && pLegacy.igTargets[0].status === 'published', JSON.stringify(pLegacy).slice(0, 300));

  // ---- (7) YouTube-only post: unchanged, zero Graph calls ----
  r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/yt-only.mp4', mediaType: 'video', caption: 'yt only', format: 'REELS', scheduleTime: past(), igEnabled: false, youtube: { enabled: true, title: 'YT only title' } });
  check('YouTube-only post created with Instagram unticked', r.status === 200 && r.data.post?.igEnabled === false, JSON.stringify(r.data.post || r.data));
  const postYt = r.data.post;
  clearLog();
  r = await A.call('POST', '/api/publish-due', {});
  check('YouTube-only post publishes via publish-due', (r.data.published || []).some((p) => p.id === postYt.id), JSON.stringify(r.data));
  check('YouTube-only publish made ZERO Graph calls', !graphLog().includes('graph.facebook.com') && !graphLog().includes('graph.instagram.com'), graphLog().slice(0, 300));
  const pYt = await getPost(A, postYt.id);
  check('YouTube-only post is published with a YouTube liveUrl', pYt?.status === 'published' && /youtube\.com\/watch/.test(pYt?.liveUrl || '') && pYt?.youtubeVideoId === 'ytvid-123', JSON.stringify(pYt).slice(0, 300));

  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
