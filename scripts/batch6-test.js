// KiluaAI batch-6 deep suite: (A) transactional email — forgot-password
// + team invites over a stub SMTP transport, with the graceful
// no-sender paths on a second instance; (B) best-time chips (static:
// dictionary keys at EN/HI parity + Studio wiring + built bundle);
// (C) the owner console as separate pages — every route's 404
// doctrine, dashboard/users/user-detail/posts/plans/connections/
// failures/broadcast/audit/settings APIs, admin retry through the
// shared core, broadcast into real user notifications, and the
// signup + maintenance toggles enforced server-side. Plus a jsdom
// walk that actually runs the console page + app.js.
//
// Boots the real server against isolated JSON data dirs (no MongoDB)
// with the Instagram Graph API stubbed at the fetch layer — the same
// harness as scripts/batch3-test.js. The SMTP "server" is a fake
// loopback listener implemented below; the app's own SMTP client
// speaks to it for real.
//
// Run: node scripts/batch6-test.js
// Exits non-zero if any check fails. No secrets are printed.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes++; console.log(`PASS ${name}`); }
  else { failures++; console.log(`FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await fn()) return true; await sleep(100); }
  return false;
}

const SLUG = 'hq-7f3k9';
const ADMIN = `/api/${SLUG}`;

const STUB_SOURCE = `
const fs = require('fs');
const dataDir = process.env.DATA_DIR;
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('graph.facebook.com') || u.includes('graph.instagram.com')) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('debug_token')) return json({ data: { is_valid: true, expires_at: 0, type: 'USER' } });
    if (u.includes('oauth/access_token') || u.includes('refresh_access_token')) return json({ access_token: ['stub','access','token'].join('-') });
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
      SESSION_SECRET: ['batch6','session','value'].join('-'), IG_TOKEN_KEY: ['batch6','ig','value'].join('-'), CRON_SECRET: ['batch6','cron','value'].join('-'),
      SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '', MAIL_FROM: '',
      GEMINI_API_KEY: '',
      ...extraEnv,
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
    const res = await fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) for (const part of sc.split(',')) { const m = part.trim().match(/^([^=]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  }
  return { call, cookieHeader: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
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

// ---------- fake SMTP server (loopback) ----------
// Speaks just enough SMTP for the app's own client: greeting, EHLO
// (no STARTTLS offered), AUTH LOGIN, MAIL/RCPT, DATA capture, QUIT.
function startFakeSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.write('220 fake-smtp ready\r\n');
    let buf = '';
    let state = 'cmd';
    let cur = null;
    let dataBuf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (state === 'data') {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          dataBuf += buf.slice(0, end);
          buf = buf.slice(end + 5);
          cur.data = dataBuf;
          messages.push(cur);
          cur = null; dataBuf = '';
          state = 'cmd';
          socket.write('250 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (state === 'auth-user') { state = 'auth-pass'; socket.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (state === 'auth-pass') { state = 'cmd'; socket.write('235 authenticated\r\n'); continue; }
        if (up.startsWith('EHLO') || up.startsWith('HELO')) socket.write('250 fake-smtp greets\r\n');
        else if (up.startsWith('AUTH LOGIN')) { state = 'auth-user'; socket.write('334 VXNlcm5hbWU6\r\n'); }
        else if (up.startsWith('MAIL FROM:')) { cur = { from: line.slice(line.indexOf('<') + 1, line.lastIndexOf('>')), to: '', data: '' }; socket.write('250 ok\r\n'); }
        else if (up.startsWith('RCPT TO:')) { if (cur) cur.to = line.slice(line.indexOf('<') + 1, line.lastIndexOf('>')); socket.write('250 ok\r\n'); }
        else if (up === 'DATA') { state = 'data'; socket.write('354 go ahead\r\n'); }
        else if (up === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); return; }
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, messages, port: server.address().port }));
  });
}

async function main() {
  // ================= static checks (Item B wiring + dict parity) =================
  const dictSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'i18n-dict.js'), 'utf8');
  for (const key of ['bestTimesTitle', 'bestTimesNote', 'todayWord', 'tomorrowWord', 'maintenanceDefault', 'teamInvitedEmailed']) {
    const n = (dictSrc.match(new RegExp(`\\b${key}:`, 'g')) || []).length;
    check(`dict: ${key} present in EN + HI`, n >= 2, `found ${n}`);
  }
  const studioSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'components', 'Studio.jsx'), 'utf8');
  check('studio: best-time chips wired', studioSrc.includes('bestTimeSlots') && studioSrc.includes("t('bestTimesTitle')") && studioSrc.includes("t('bestTimesNote')"));
  const distDir = path.join(__dirname, '..', 'frontend', 'dist', 'assets');
  if (fs.existsSync(distDir)) {
    const all = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join('\n');
    check('bundle: best-time copy ships', all.includes('General guide') && all.includes('Aam guide'));
    check('bundle: no console slug in the client app', !all.includes(SLUG));
  } else {
    check('bundle: dist exists (run the frontend build first)', false);
  }

  // ================= instance A: no SMTP, no Gemini key =================
  const port = 3241;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiluaai-batch6-'));
  fs.writeFileSync(path.join(dataDir, 'failme-on'), '1');
  const A = startServer({ port, dataDir });
  const smtp = await startFakeSmtp();
  const portB = 3242;
  const baseB = `http://127.0.0.1:${portB}`;
  const dataDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kiluaai-batch6-smtp-'));
  const B = startServer({
    port: portB, dataDir: dataDirB,
    extraEnv: {
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port),
      SMTP_USER: 'sender@b6.test', SMTP_PASS: 'test-app-password',
      MAIL_FROM: 'KiluaAI <sender@b6.test>',
    },
  });
  try {
    check('instance A boots (no SMTP)', await waitUp(base), A.getLog().slice(-300));
    check('instance B boots (SMTP stub)', await waitUp(baseB), B.getLog().slice(-300));

    const anon = makeClient(base);
    const O = makeClient(base);   // owner
    const M1 = makeClient(base);  // member with IG + posts
    const M2 = makeClient(base);  // member with a broken IG connection
    const signup = async (client, email) => client.call('POST', '/api/auth/signup', { email, password: 'Kilua-Test-9871', name: email.split('@')[0] });

    // ---- 404 doctrine: anonymous on every console route ----
    const plain404 = (r) => r.status === 404 && r.data && r.data.error === 'That API route does not exist.';
    for (const p of ['/console', '/app.js', '/status', '/overview', '/users', '/users/usr_x', '/posts', '/failures', '/plans', '/connections', '/settings', '/audit']) {
      const isPage = p === '/console' || p === '/app.js';
      const res = await fetch(`${base}${ADMIN}${p}`);
      const body = isPage ? await res.text() : await res.json().catch(() => null);
      check(`doctrine anon GET ${p} -> 404`, res.status === 404 && (isPage ? String(body).includes('That API route does not exist.') : body && body.error === 'That API route does not exist.'), `got ${res.status}`);
    }
    check('doctrine anon POST broadcast -> 404', plain404(await anon.call('POST', `${ADMIN}/broadcast`, { title: 'x', body: 'y', confirm: true })));
    check('doctrine anon PATCH settings -> 404', plain404(await anon.call('PATCH', `${ADMIN}/settings`, { signupOpen: false })));
    check('doctrine anon POST admin retry -> 404', plain404(await anon.call('POST', `${ADMIN}/posts/u/p/retry`, {})));

    // ---- signups + app-status default ----
    let r = await anon.call('GET', '/api/app-status');
    check('app-status default: signups open, no maintenance', r.status === 200 && r.data.signupOpen === true && r.data.maintenance === false, JSON.stringify(r.data));
    r = await signup(O, 'owner@b6.test');
    check('owner signup', r.status === 200 && r.data.user.role === 'owner', JSON.stringify(r.data).slice(0, 160));
    const m1Id = (await signup(M1, 'm1@b6.test')).data.user.id;
    const m2Id = (await signup(M2, 'm2@b6.test')).data.user.id;
    check('member signups', !!m1Id && !!m2Id);

    // ---- doctrine: member + owner-without-token ----
    check('doctrine member GET overview -> 404', plain404(await M1.call('GET', `${ADMIN}/overview`)));
    check('doctrine member GET console page -> 404', (await fetch(`${base}${ADMIN}/console`, { headers: { Cookie: M1.cookieHeader() } })).status === 404);
    check('doctrine owner-without-token GET overview -> 404', plain404(await O.call('GET', `${ADMIN}/overview`)));
    r = await O.call('GET', `${ADMIN}/status`);
    check('owner status: pin not set yet', r.status === 200 && r.data.pinSet === false, JSON.stringify(r.data));

    // ---- PIN lifecycle ----
    r = await O.call('POST', `${ADMIN}/set-pin`, { pin: '2468' });
    check('set-pin returns an admin token', r.status === 200 && !!r.data.adminToken, JSON.stringify(r.data).slice(0, 120));
    const adminTok = r.data.adminToken;
    const AH = { headers: { 'x-admin-token': adminTok } };
    const O2 = makeClient(base);
    await O2.call('POST', '/api/auth/login', { email: 'owner@b6.test', password: 'Kilua-Test-9871' });
    check('unlock with wrong PIN -> 404', plain404(await O2.call('POST', `${ADMIN}/unlock`, { pin: '9999' })));
    r = await O2.call('POST', `${ADMIN}/unlock`, { pin: '2468' });
    check('unlock with the right PIN -> token', r.status === 200 && !!r.data.adminToken);

    // ---- seed connections + posts for M1 / M2 ----
    seedInstagram(dataDir, m1Id, [igAcct('ig-m1', 'memberone')]);
    seedInstagram(dataDir, m2Id, [igAcct('ig-m2', 'membertwo', { tokenRefreshError: 'revoked-or-expired' })]);
    r = await M1.call('POST', '/api/posts', { mediaUrl: 'https://example.com/v.mp4', mediaType: 'video', caption: 'FAILME launch post', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' });
    const failPost = r.data.post;
    check('m1 failing post created', r.status === 200 && !!failPost, JSON.stringify(r.data).slice(0, 160));
    r = await M1.call('POST', `/api/posts/${failPost.id}/publish`, {});
    check('m1 first publish fails via stub', r.status === 502 || (r.data && r.data.ok === false), `got ${r.status}`);
    r = await M1.call('POST', '/api/posts', { mediaUrl: 'https://example.com/ok.mp4', mediaType: 'video', caption: 'plain good post', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' });
    const okPost = r.data.post;
    r = await M1.call('POST', `/api/posts/${okPost.id}/publish`, {});
    check('m1 plain post publishes', r.status === 200 && r.data && r.data.ok === true, JSON.stringify(r.data).slice(0, 160));

    // ---- dashboard / overview ----
    r = await O.call('GET', `${ADMIN}/overview`, undefined, AH);
    check('overview: 3 users', r.data.users.total === 3, JSON.stringify(r.data.users));
    check('overview: published today counted', r.data.posts.publishedToday >= 1, JSON.stringify(r.data.posts));
    check('overview: failed today counted', r.data.posts.failedToday >= 1, JSON.stringify(r.data.posts));
    check('overview: plan distribution sums to 3', Object.values(r.data.users.byPlan).reduce((a, b) => a + b, 0) === 3);
    check('overview: recent signups newest-first incl. m2', Array.isArray(r.data.recentSignups) && r.data.recentSignups[0].email === 'm2@b6.test', JSON.stringify(r.data.recentSignups).slice(0, 160));
    check('overview: connection health counts the broken one', r.data.accounts.instagram === 2 && r.data.accounts.instagramBroken === 1, JSON.stringify(r.data.accounts));

    // ---- users page: pagination + search ----
    r = await O.call('GET', `${ADMIN}/users?pageSize=2&page=1`, undefined, AH);
    check('users: page 1 of 2 with pageSize 2', r.data.total === 3 && r.data.pages === 2 && r.data.users.length === 2, JSON.stringify(r.data).slice(0, 160));
    r = await O.call('GET', `${ADMIN}/users?pageSize=2&page=2`, undefined, AH);
    check('users: page 2 has the remaining user', r.data.users.length === 1);
    r = await O.call('GET', `${ADMIN}/users?q=m1%40b6.test`, undefined, AH);
    check('users: search narrows to m1', r.data.total === 1 && r.data.users[0].email === 'm1@b6.test');
    check('users: row carries plan + posts + accounts', r.data.users[0].plan && typeof r.data.users[0].postsTotal === 'number' && Array.isArray(r.data.users[0].accounts));

    // ---- user detail + management action + its audit ----
    r = await O.call('GET', `${ADMIN}/users/${m1Id}`, undefined, AH);
    check('user detail: m1 with posts', r.status === 200 && r.data.user.email === 'm1@b6.test' && r.data.posts.length === 2, JSON.stringify(r.data).slice(0, 200));
    const failedRow = (r.data.posts || []).find((p) => p.postId === failPost.id);
    check('user detail: failed post shows a reason', !!failedRow && failedRow.status === 'failed' && (failedRow.friendly || failedRow.reason).length > 0, JSON.stringify(failedRow).slice(0, 200));
    r = await O.call('PATCH', `${ADMIN}/users/${m1Id}`, { plan: 'pro' }, AH);
    check('user detail: plan change applies', r.status === 200 && r.data.user.plan.plan === 'pro', JSON.stringify(r.data).slice(0, 160));
    r = await O.call('GET', `${ADMIN}/users/${m1Id}`, undefined, AH);
    check('user detail: audit records the plan change', (r.data.audit || []).some((e) => e.action === 'plan-change'), JSON.stringify(r.data.audit).slice(0, 200));
    check('user detail: unknown user -> 404', plain404(await O.call('GET', `${ADMIN}/users/usr_nope`, undefined, AH)));

    // ---- posts page + failures page ----
    r = await O.call('GET', `${ADMIN}/posts?status=failed`, undefined, AH);
    check('posts page: status filter returns only failed', r.data.total === 1 && r.data.posts[0].postId === failPost.id, JSON.stringify(r.data).slice(0, 200));
    r = await O.call('GET', `${ADMIN}/posts?q=FAILME`, undefined, AH);
    check('posts page: caption search finds the failed post', r.data.total === 1 && r.data.posts[0].userEmail === 'm1@b6.test');
    r = await O.call('GET', `${ADMIN}/failures`, undefined, AH);
    check('failures page: the failed post with a friendly reason', r.data.total === 1 && r.data.posts[0].postId === failPost.id && (r.data.posts[0].friendly || '').length > 0, JSON.stringify(r.data).slice(0, 200));

    // ---- plans + connections ----
    r = await O.call('GET', `${ADMIN}/plans`, undefined, AH);
    check('plans: payments honestly NOT live', r.data.paymentsLive === false && /not live/i.test(r.data.paymentsNote || ''), JSON.stringify(r.data).slice(0, 200));
    check('plans: 4 plans from the single config, users sum to 3', r.data.plans.length === 4 && Object.values(r.data.usersPerPlan).reduce((a, b) => a + b, 0) === 3);
    check('plans: pro price matches the config (249)', (r.data.plans.find((p) => p.id === 'pro') || {}).priceInr === 249);
    r = await O.call('GET', `${ADMIN}/connections`, undefined, AH);
    check('connections: disconnected list names membertwo', (r.data.disconnected || []).some((x) => x.username === 'membertwo' && x.userEmail === 'm2@b6.test'), JSON.stringify(r.data).slice(0, 240));
    check('connections: m1 row healthy', (r.data.rows || []).some((x) => x.email === 'm1@b6.test' && x.brokenCount === 0 && x.instagram[0].username === 'memberone'));

    // ---- admin retry through the shared core ----
    fs.rmSync(path.join(dataDir, 'failme-on'));
    r = await O.call('POST', `${ADMIN}/posts/${m1Id}/${failPost.id}/retry`, {}, AH);
    check('admin retry: publishes the failed post', r.status === 200 && r.data && r.data.ok === true && r.data.retried === true, `got ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    r = await O.call('GET', `${ADMIN}/failures`, undefined, AH);
    check('admin retry: failures page is now empty', r.data.total === 0, JSON.stringify(r.data).slice(0, 120));
    r = await O.call('GET', `${ADMIN}/audit?limit=500`, undefined, AH);
    check('audit: post-retry entry written', (r.data.entries || []).some((e) => e.action === 'post-retry' && e.targetUserId === m1Id), JSON.stringify(r.data.entries).slice(0, 240));
    check('admin retry: unknown post -> 404', plain404(await O.call('POST', `${ADMIN}/posts/${m1Id}/post_nope/retry`, {}, AH)));

    // ---- broadcast ----
    check('broadcast: missing confirm -> 400', (await O.call('POST', `${ADMIN}/broadcast`, { title: 'Hi', body: 'Body' }, AH)).status === 400);
    check('broadcast: confirm false -> 400', (await O.call('POST', `${ADMIN}/broadcast`, { title: 'Hi', body: 'Body', confirm: false }, AH)).status === 400);
    check('broadcast: empty title -> 400', (await O.call('POST', `${ADMIN}/broadcast`, { title: '', body: 'Body', confirm: true }, AH)).status === 400);
    r = await O.call('POST', `${ADMIN}/broadcast`, { title: 'B6 Hello', body: 'Batch six is live.', confirm: true }, AH);
    check('broadcast: sent to all 3 users', r.status === 200 && r.data.sent === 3, JSON.stringify(r.data));
    r = await M1.call('GET', '/api/notifications');
    check('broadcast: m1 received the announcement', (r.data.notifications || []).some((n) => n.type === 'announcement' && n.title === 'B6 Hello' && n.message === 'Batch six is live.'), JSON.stringify(r.data).slice(0, 240));
    r = await O.call('GET', `${ADMIN}/audit`, undefined, AH);
    check('audit: broadcast entry written', (r.data.entries || []).some((e) => e.action === 'broadcast' && /3 users/.test(e.summary || '')), JSON.stringify(r.data.entries).slice(0, 240));

    // ---- settings: defaults, toggles, enforcement ----
    r = await O.call('GET', `${ADMIN}/settings`, undefined, AH);
    check('settings: defaults open + read-only plans note', r.data.settings.signupOpen === true && r.data.settings.maintenance === false && /read-only/i.test(r.data.plansNote || '') && r.data.plans.length === 4, JSON.stringify(r.data).slice(0, 240));
    r = await O.call('PATCH', `${ADMIN}/settings`, { signupOpen: false }, AH);
    check('settings: signup toggle saves', r.status === 200 && r.data.settings.signupOpen === false, JSON.stringify(r.data).slice(0, 160));
    r = await signup(makeClient(base), 'late@b6.test');
    check('settings: signup is blocked while paused (403)', r.status === 403, `got ${r.status}`);
    r = await O.call('PATCH', `${ADMIN}/settings`, { maintenance: true, maintenanceMessage: 'B6 maintenance window' }, AH);
    check('settings: maintenance saves with message', r.status === 200 && r.data.settings.maintenance === true && r.data.settings.maintenanceMessage === 'B6 maintenance window');
    r = await anon.call('GET', '/api/app-status');
    check('app-status: maintenance is public with its message', r.data.maintenance === true && r.data.maintenanceMessage === 'B6 maintenance window' && r.data.signupOpen === false, JSON.stringify(r.data));
    r = await M1.call('POST', '/api/posts', { mediaUrl: 'https://example.com/x.mp4', mediaType: 'video', caption: 'during maintenance', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' });
    check('maintenance: member write paused with 503 + message', r.status === 503 && r.data.maintenance === true && /B6 maintenance window/.test(r.data.error || ''), `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    r = await M1.call('GET', '/api/posts?limit=5');
    check('maintenance: member reads still work', r.status === 200);
    // Owner is never blocked — and this doubles as the no-SMTP invite check.
    r = await O.call('POST', '/api/team/invite', { email: 'guest@b6.test', role: 'viewer' });
    check('maintenance: owner write still works', r.status === 200, `got ${r.status}`);
    check('invite without SMTP: recorded, emailed=false honestly', r.status === 200 && r.data.emailed === false && r.data.member && r.data.member.email === 'guest@b6.test', JSON.stringify(r.data).slice(0, 200));
    r = await O.call('PATCH', `${ADMIN}/settings`, { signupOpen: true, maintenance: false }, AH);
    check('settings: toggles restore', r.status === 200 && r.data.settings.signupOpen === true && r.data.settings.maintenance === false);
    r = await M1.call('POST', '/api/posts', { mediaUrl: 'https://example.com/x.mp4', mediaType: 'video', caption: 'after maintenance', scheduleTime: future(3600000), status: 'scheduled', format: 'REELS' });
    check('maintenance off: member writes work again', r.status === 200, `got ${r.status}`);
    r = await O.call('GET', `${ADMIN}/audit`, undefined, AH);
    check('audit: settings-change entries written', (r.data.entries || []).filter((e) => e.action === 'settings-change').length >= 2, JSON.stringify(r.data.entries).slice(0, 200));

    // ---- forgot-password + AI on the no-sender / no-key instance ----
    r = await M1.call('POST', '/api/auth/forgot', { email: 'm1@b6.test' });
    check('forgot without SMTP: generic 200, no crash', r.status === 200 && r.data.ok === true && /reset link is on its way/.test(r.data.message || ''), JSON.stringify(r.data));
    r = await M1.call('POST', '/api/ai/caption', { topic: 'a post about monsoon chai' });
    check('ai caption without key: 503 AI_OFF', r.status === 503 && JSON.stringify(r.data).includes('AI_OFF'), `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);

    // ---- console page + app.js content (owner session) ----
    const pageRes = await fetch(`${base}${ADMIN}/console`, { headers: { Cookie: O.cookieHeader() } });
    const pageHtml = await pageRes.text();
    check('console page: 200 for the owner', pageRes.status === 200);
    for (const nav of ['dashboard', 'users', 'userdetail', 'posts', 'plans', 'connections', 'failures', 'broadcast', 'audit', 'settings']) {
      check(`console page: nav has ${nav}`, pageHtml.includes(`data-nav="${nav}"`));
    }
    const jsRes = await fetch(`${base}${ADMIN}/app.js`, { headers: { Cookie: O.cookieHeader() } });
    const appJs = await jsRes.text();
    check('console js: loads and wires broadcast + settings + retry', jsRes.status === 200 && appJs.includes('/broadcast') && appJs.includes('/settings') && appJs.includes('/retry'));

    // ---- jsdom walk: the console actually renders + navigates ----
    try {
      const { JSDOM } = require('jsdom');
      const dom = new JSDOM(pageHtml, { url: `${base}${ADMIN}/console`, runScripts: 'dangerously', pretendToBeVisual: true });
      const { window } = dom;
      window.sessionStorage.setItem('oc-token', adminTok);
      // One retry on a network error: undici can hand the first call a
      // stale pooled socket (UND_ERR_SOCKET) — a harness artifact, not
      // an app behavior; a browser's fresh connection does not hit it.
      window.fetch = async (u, opts = {}) => {
        const run = () => fetch(new URL(u, base).href, { ...opts, headers: { ...(opts.headers || {}), Cookie: O.cookieHeader() } });
        try { return await run(); } catch { return run(); }
      };
      const script = window.document.createElement('script');
      script.textContent = appJs;
      window.document.body.appendChild(script);
      const doc = window.document;
      check('jsdom: dashboard renders stats', await waitFor(() => doc.getElementById('stats') && doc.getElementById('stats').textContent.includes('Total users')));
      check('jsdom: dashboard shows the user total', doc.getElementById('stats').textContent.includes('3'));
      check('jsdom: recent signups render', doc.getElementById('signups').textContent.includes('m2@b6.test'));
      doc.querySelector('[data-nav="users"]').click();
      check('jsdom: users page renders rows', await waitFor(() => doc.getElementById('users').textContent.includes('m1@b6.test')));
      doc.querySelector('[data-nav="broadcast"]').click();
      check('jsdom: broadcast page renders with a disabled send', !!doc.getElementById('bcSend') && doc.getElementById('bcSend').disabled === true);
      doc.querySelector('[data-nav="settings"]').click();
      check('jsdom: settings page renders toggles', await waitFor(() => doc.getElementById('setSignup') && doc.getElementById('setSignup').checked === true));
      window.close();
    } catch (e) {
      check('jsdom console walk runs', false, String(e && e.message).slice(0, 200));
    }

    // ---- owner-easy-access (final model): /me flag, session unlock ----
    r = await O.call('GET', '/api/auth/me');
    check('me: owner carries the owner flag', !!(r.data.user && r.data.user.isOwner === true), JSON.stringify(r.data.user).slice(0, 200));
    check('me: owner carries the console URL (delivered only here)', !!(r.data.user && typeof r.data.user.adminUrl === 'string' && r.data.user.adminUrl.endsWith('/console')), JSON.stringify(r.data.user).slice(0, 200));
    r = await M1.call('GET', '/api/auth/me');
    check('me: member carries no flag and no console URL', !!(r.data.user && r.data.user.isOwner === undefined && r.data.user.adminUrl === undefined), JSON.stringify(r.data.user).slice(0, 200));
    // Secrecy invariant: the console slug appears in NO shipped file.
    const slugHits = [];
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name);
        if (f.isDirectory()) scanDir(fp);
        else if (/\.(js|jsx|ts|tsx|html|css|json)$/.test(f.name) && fs.readFileSync(fp, 'utf8').includes(SLUG)) slugHits.push(fp);
      }
    };
    scanDir(path.join(__dirname, '..', 'frontend', 'src'));
    scanDir(path.join(__dirname, '..', 'frontend', 'dist'));
    check('secrecy: console slug absent from frontend src + dist', slugHits.length === 0, slugHits.join(', ').slice(0, 200));
    // Session unlock: the owner's own app session opens the console.
    r = await O.call('POST', `${ADMIN}/session-unlock`, {});
    check('session-unlock: owner session -> token, no PIN asked', r.status === 200 && !!r.data.adminToken, `got ${r.status}`);
    const sessTok = r.data.adminToken;
    r = await O.call('GET', `${ADMIN}/overview`, undefined, { headers: { 'x-admin-token': sessTok } });
    check('session-unlock: the issued token opens the data endpoints', r.status === 200 && r.data.ok === true, `got ${r.status}`);
    check('session-unlock: member session -> plain 404', plain404(await M1.call('POST', `${ADMIN}/session-unlock`, {})));
    check('session-unlock: anonymous -> plain 404', plain404(await anon.call('POST', `${ADMIN}/session-unlock`, {})));
    check('console page: Switch to User Panel link present', pageHtml.includes('Switch to User Panel'));
    // PIN unlock still works; both methods are audit-logged as such.
    r = await O.call('POST', `${ADMIN}/unlock`, { pin: '2468' });
    check('unlock: PIN still works alongside session unlock', r.status === 200 && !!r.data.adminToken, `got ${r.status}`);
    r = await O.call('GET', `${ADMIN}/audit`, undefined, AH);
    const unlockEntries = (r.data.entries || []).filter((e) => e.action === 'console-unlock');
    check('audit: session unlock recorded with its method', unlockEntries.some((e) => /session/i.test(e.summary || '')), JSON.stringify(unlockEntries).slice(0, 240));
    check('audit: PIN unlock recorded with its method', unlockEntries.some((e) => /PIN/.test(e.summary || '')), JSON.stringify(unlockEntries).slice(0, 240));
    // Lockout last on this instance: 5 wrong PINs block even the right
    // PIN — but the owner's app session still opens the console.
    for (let i = 0; i < 5; i++) await O.call('POST', `${ADMIN}/unlock`, { pin: '0000' });
    check('lockout: correct PIN refused after 5 wrong tries', plain404(await O.call('POST', `${ADMIN}/unlock`, { pin: '2468' })));
    r = await O.call('POST', `${ADMIN}/session-unlock`, {});
    check('lockout: owner session unlock is not blocked by the PIN lockout', r.status === 200 && !!r.data.adminToken, `got ${r.status}`);

    // ================= instance B: real SMTP through the fake server =================
    const OB = makeClient(baseB);
    const UB = makeClient(baseB);
    r = await signup(OB, 'ownerb@b6.test');
    check('B: owner signup', r.status === 200 && r.data.user.role === 'owner', JSON.stringify(r.data).slice(0, 120));
    await signup(UB, 'userb@b6.test');
    const before = smtp.messages.length;
    r = await UB.call('POST', '/api/auth/forgot', { email: 'userb@b6.test' });
    check('B: forgot answers generic 200', r.status === 200 && r.data.ok === true);
    check('B: reset email arrived at the fake SMTP server', await waitFor(() => smtp.messages.length > before, 4000));
    const resetMail = smtp.messages[before];
    if (resetMail) {
      check('B: envelope FROM is the bare address (display-form MAIL_FROM parsed)', resetMail.from === 'sender@b6.test', resetMail.from);
      check('B: envelope TO is the user', resetMail.to === 'userb@b6.test', resetMail.to);
      check('B: From header keeps the KiluaAI display form', /From: KiluaAI <sender@b6\.test>/.test(resetMail.data), resetMail.data.slice(0, 200));
      check('B: subject is the reset subject', resetMail.data.includes('Subject: Reset your KiluaAI password'));
      check('B: body carries the reset link', /\/reset\?token=/.test(resetMail.data));
    }
    const beforeInv = smtp.messages.length;
    r = await OB.call('POST', '/api/team/invite', { email: 'guestb@b6.test', role: 'scheduler' });
    check('B: invite answers emailed=true', r.status === 200 && r.data.emailed === true, JSON.stringify(r.data).slice(0, 200));
    check('B: invite email arrived at the fake SMTP server', await waitFor(() => smtp.messages.length > beforeInv, 4000));
    const invMail = smtp.messages[beforeInv];
    if (invMail) {
      check('B: invite TO is the invited address', invMail.to === 'guestb@b6.test', invMail.to);
      check('B: invite subject is the team subject', invMail.data.includes('Subject: You are invited to a KiluaAI team'));
      check('B: invite body names the role + the app link', invMail.data.includes('Scheduler') && invMail.data.includes(baseB), invMail.data.slice(0, 300));
    }
  } finally {
    A.server.kill();
    B.server.kill();
    smtp.server.close();
  }

  console.log(`\nBATCH6: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('batch6 crashed:', e); process.exit(1); });
