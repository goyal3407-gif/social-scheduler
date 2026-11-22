// KiluaAI Gmail-alias normalization suite (22 Nov 2026):
//   (A) canonical identity over HTTP — signup stores the canonical
//       form and rejects dotted/+alias/googlemail duplicates; login
//       and forgot-password resolve any Gmail spelling of the inbox
//       (canonical -> exact -> legacy sweep, so pre-existing accounts
//       are never locked out); non-Gmail dots stay significant; the
//       owner comp resolves for a dotted variant; team invites are
//       stored canonically and bind canonically at create + signup.
//   (B) the guarded one-time alias-duplicate cleanup — fixture data
//       dirs prove the exact production shape fires (empty +alias
//       account removed, keeper + posts intact, audit entry written,
//       second boot a no-op) and every off-shape is a no-op: both
//       empty, both with content, no canonical keeper, owner dup.
// Boots the real server against isolated JSON data dirs (no MongoDB),
// the same harness as scripts/auditfix-test.js.
// Run: node scripts/gmail-alias-test.js
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

function startServer({ port, dataDir }) {
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test' };
  env['SESSION_' + 'SECRET'] = 'gmail-alias-test-secret'; // throwaway, local instance only
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

function makeClient(base) {
  let cookie = '';
  return {
    async call(method, p, body) {
      const r = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = r.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await r.json(); } catch { /* not json */ }
      return { status: r.status, data };
    },
  };
}

const readJson = (dir, name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return fallback; }
};
const PW = 'Kilua-Test-9871';

async function partA() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-gmailalias-a-'));
  const base = 'http://127.0.0.1:3141';
  const { server, getLog } = startServer({ port: 3141, dataDir });
  try {
    check('A: server boots', await waitUp(base), getLog().slice(-300));
    const ANON = makeClient(base);
    const P = makeClient(base); // first signup -> role owner (Ultra)

    // --- signup canonicalizes the stored address ---
    let r = await P.call('POST', '/api/auth/signup', { email: 'Person.One+promo@Gmail.com', password: PW, name: 'Person' });
    check('A: signup with dotted +alias Gmail -> 200', r.status === 200 && !!r.data.user?.id, `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    check('A: stored/returned email is the canonical form', r.data.user?.email === 'personone@gmail.com', `got ${r.data.user?.email}`);
    const usersFile = readJson(dataDir, 'users.json', []);
    check('A: users.json holds the canonical address', usersFile.some((u) => u.email === 'personone@gmail.com') && !usersFile.some((u) => u.email !== 'personone@gmail.com' && u.email.includes('person')), JSON.stringify(usersFile.map((u) => u.email)));

    // --- duplicates under any Gmail spelling are rejected ---
    r = await ANON.call('POST', '/api/auth/signup', { email: 'personone@gmail.com', password: PW });
    check('A: plain-form duplicate signup -> 409', r.status === 409, `got ${r.status}`);
    r = await ANON.call('POST', '/api/auth/signup', { email: 'p.ersonone@googlemail.com', password: PW });
    check('A: googlemail dotted duplicate signup -> 409', r.status === 409, `got ${r.status}`);
    r = await ANON.call('POST', '/api/auth/signup', { email: 'personone+other@gmail.com', password: PW });
    check('A: +alias duplicate signup -> 409', r.status === 409, `got ${r.status}`);

    // --- login resolves any spelling of the inbox ---
    const L = makeClient(base);
    r = await L.call('POST', '/api/auth/login', { email: 'p.erson.one+news@gmail.com', password: PW });
    check('A: login with a dotted +alias spelling -> 200', r.status === 200 && r.data.user?.email === 'personone@gmail.com', `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    r = await ANON.call('POST', '/api/auth/login', { email: 'personone@gmail.com', password: 'Wrong-Pass-1234' });
    check('A: login with the wrong password -> 401', r.status === 401, `got ${r.status}`);

    // --- forgot-password finds the account under a dotted spelling ---
    r = await ANON.call('POST', '/api/auth/forgot', { email: 'person.one@gmail.com' });
    check('A: forgot with dotted spelling -> generic 200', r.status === 200 && r.data.ok === true, `got ${r.status}`);
    const resets = readJson(dataDir, 'password-resets.json', []);
    const personId = usersFile.find((u) => u.email === 'personone@gmail.com')?.id;
    check('A: forgot created a reset record for the canonical account', resets.some((x) => x.userId === personId), JSON.stringify(resets).slice(0, 160));

    // --- non-Gmail dots are significant ---
    r = await ANON.call('POST', '/api/auth/signup', { email: 'first.last@af.test', password: PW });
    check('A: non-Gmail dotted signup -> 200', r.status === 200, `got ${r.status}`);
    r = await ANON.call('POST', '/api/auth/signup', { email: 'firstlast@af.test', password: PW });
    check('A: non-Gmail undotted signup is a DIFFERENT account -> 200', r.status === 200, `got ${r.status}`);
    const usersNow = readJson(dataDir, 'users.json', []);
    check('A: non-Gmail dotted address stored untouched', usersNow.some((u) => u.email === 'first.last@af.test'));

    // --- owner comp resolves for a dotted variant of an owner email ---
    const G = makeClient(base);
    r = await G.call('POST', '/api/auth/signup', { email: 'goyal.dhiman00@gmail.com', password: PW });
    check('A: dotted owner-email signup -> 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    check('A: canonical form stored for the owner-email signup', r.data.user?.email === 'goyaldhiman00@gmail.com', `got ${r.data.user?.email}`);
    check('A: owner comp resolves (effective plan Ultra)', r.data.user?.plan === 'ultra' && r.data.user?.comp === true, JSON.stringify(r.data.user || {}).slice(0, 200));

    // --- team invites: stored + bound canonically ---
    r = await P.call('POST', '/api/team/invite', { email: 'Teammate.One@Gmail.com', role: 'scheduler' });
    check('A: invite to a dotted Gmail -> 200, status invited', r.status === 200 && r.data.member?.status === 'invited', `got ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    check('A: invite stored under the canonical address', r.data.member?.email === 'teammateone@gmail.com', `got ${r.data.member?.email}`);
    const T = makeClient(base);
    r = await T.call('POST', '/api/auth/signup', { email: 'teammateone@gmail.com', password: PW });
    check('A: invited member signup -> 200', r.status === 200, `got ${r.status}`);
    let invites = readJson(dataDir, 'team-invites.json', []);
    const inv1 = invites.find((i) => i.email === 'teammateone@gmail.com');
    check('A: invite bound at signup (active + memberUserId)', !!inv1 && inv1.status === 'active' && inv1.memberUserId === r.data.user?.id, JSON.stringify(inv1 || {}));
    // invite an EXISTING account under an alias spelling: binds at once
    const M2 = makeClient(base);
    r = await M2.call('POST', '/api/auth/signup', { email: 'membertwo@gmail.com', password: PW });
    const memberTwoId = r.data.user?.id;
    check('A: second member signup -> 200', r.status === 200 && !!memberTwoId, `got ${r.status}`);
    r = await P.call('POST', '/api/team/invite', { email: 'Member.Two+team@Gmail.com', role: 'viewer' });
    check('A: invite by +alias spelling binds the existing account at once', r.status === 200 && r.data.member?.status === 'active' && r.data.member?.memberUserId === memberTwoId, `got ${r.status} ${JSON.stringify(r.data).slice(0, 220)}`);
    check('A: second invite also stored canonically', r.data.member?.email === 'membertwo@gmail.com', `got ${r.data.member?.email}`);

    // --- legacy sweep: an account stored non-canonically still logs in ---
    const LG = makeClient(base);
    r = await LG.call('POST', '/api/auth/signup', { email: 'legacy@gmail.com', password: PW });
    check('A: legacy fixture signup -> 200', r.status === 200, `got ${r.status}`);
    const legacyId = r.data.user?.id;
    const usersLegacy = readJson(dataDir, 'users.json', []);
    const legacyDoc = usersLegacy.find((u) => u.id === legacyId);
    legacyDoc.email = 'leg.acy+old@gmail.com'; // simulate a pre-normalization record
    fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(usersLegacy, null, 2));
    const L2 = makeClient(base);
    r = await L2.call('POST', '/api/auth/login', { email: 'legacy@gmail.com', password: PW });
    check('A: login by canonical form finds the legacy-stored account (sweep)', r.status === 200 && r.data.user?.id === legacyId, `got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    const L3 = makeClient(base);
    r = await L3.call('POST', '/api/auth/login', { email: 'leg.acy@gmail.com', password: PW });
    check('A: login by another spelling also finds it (sweep)', r.status === 200 && r.data.user?.id === legacyId, `got ${r.status}`);
  } finally {
    server.kill('SIGKILL');
  }
}

// ---------- Part B: the guarded cleanup, one fixture per boot ----------
function seedDir(users, posts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-gmailalias-b-'));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users, null, 2));
  if (posts) fs.writeFileSync(path.join(dir, 'posts.json'), JSON.stringify(posts, null, 2));
  return dir;
}
const U = (id, email, role, createdAt) => ({ id, email, salt: 'fixture', passwordHash: 'fixture', role, createdAt });
const BOSS = U('u-boss', 'boss@af.test', 'owner', '2026-01-01T00:00:00.000Z');

async function bootFixture(port, dir) {
  const base = `http://127.0.0.1:${port}`;
  const { server, getLog } = startServer({ port, dataDir: dir });
  const up = await waitUp(base); // /api/health passes the cleanup gate first
  await sleep(150);
  return { server, up, getLog };
}

async function partB() {
  // B1 — the exact production shape: canonical keeper WITH a post,
  // empty +alias duplicate -> duplicate removed, audit written,
  // second boot changes nothing.
  {
    const dir = seedDir(
      [BOSS,
        U('u-keep', 'goyaldhiman00@gmail.com', 'member', '2026-01-02T00:00:00.000Z'),
        U('u-dup', 'goyaldhiman00+metareview@gmail.com', 'member', '2026-01-03T00:00:00.000Z')],
      [{ id: 'p1', userId: 'u-keep', caption: 'kept post' }],
    );
    let { server, up } = await bootFixture(3142, dir);
    check('B1: fixture server boots', up);
    let users = readJson(dir, 'users.json', []);
    check('B1: empty +alias duplicate removed', users.length === 2 && !users.some((u) => u.id === 'u-dup'), JSON.stringify(users.map((u) => u.email)));
    check('B1: keeper account untouched', users.some((u) => u.id === 'u-keep' && u.email === 'goyaldhiman00@gmail.com'));
    const posts = readJson(dir, 'posts.json', []);
    check('B1: keeper post intact', posts.length === 1 && posts[0].userId === 'u-keep');
    let audits = readJson(dir, 'admin-audit.json', []).filter((a) => a.action === 'gmail-alias-cleanup');
    check('B1: audit entry names the removed address', audits.length === 1 && audits[0].targetEmail === 'goyaldhiman00+metareview@gmail.com', JSON.stringify(audits).slice(0, 200));
    server.kill('SIGKILL');
    await sleep(300);
    ({ server, up } = await bootFixture(3142, dir));
    check('B1: second boot still up', up);
    users = readJson(dir, 'users.json', []);
    audits = readJson(dir, 'admin-audit.json', []).filter((a) => a.action === 'gmail-alias-cleanup');
    check('B1: idempotent — second boot changes nothing', users.length === 2 && audits.length === 1, `users=${users.length} audits=${audits.length}`);
    server.kill('SIGKILL');
  }
  // B2 — both empty: no canonical keeper content -> no-op.
  {
    const dir = seedDir([BOSS,
      U('u-keep', 'someone@gmail.com', 'member', '2026-01-02T00:00:00.000Z'),
      U('u-dup', 'someone+tag@gmail.com', 'member', '2026-01-03T00:00:00.000Z')], null);
    const { server, up } = await bootFixture(3143, dir);
    check('B2: fixture server boots', up);
    const users = readJson(dir, 'users.json', []);
    check('B2: both-empty collision is a no-op', users.length === 3, `users=${users.length}`);
    server.kill('SIGKILL');
  }
  // B3 — duplicate HAS content -> no-op.
  {
    const dir = seedDir([BOSS,
      U('u-keep', 'someone@gmail.com', 'member', '2026-01-02T00:00:00.000Z'),
      U('u-dup', 'some.one@gmail.com', 'member', '2026-01-03T00:00:00.000Z')],
      [{ id: 'p1', userId: 'u-keep' }, { id: 'p2', userId: 'u-dup' }]);
    const { server, up } = await bootFixture(3144, dir);
    check('B3: fixture server boots', up);
    const users = readJson(dir, 'users.json', []);
    check('B3: duplicate-with-content collision is a no-op', users.length === 3, `users=${users.length}`);
    server.kill('SIGKILL');
  }
  // B4 — no canonical keeper (both stored non-canonically) -> no-op.
  {
    const dir = seedDir([BOSS,
      U('u-a', 'a.b@gmail.com', 'member', '2026-01-02T00:00:00.000Z'),
      U('u-b', 'ab+tag@gmail.com', 'member', '2026-01-03T00:00:00.000Z')],
      [{ id: 'p1', userId: 'u-a' }]);
    const { server, up } = await bootFixture(3145, dir);
    check('B4: fixture server boots', up);
    const users = readJson(dir, 'users.json', []);
    check('B4: no-canonical-keeper collision is a no-op', users.length === 3, `users=${users.length}`);
    server.kill('SIGKILL');
  }
  // B5 — duplicate is an owner account -> no-op.
  {
    const dir = seedDir([BOSS,
      U('u-keep', 'someone@gmail.com', 'member', '2026-01-02T00:00:00.000Z'),
      U('u-dup', 'someone+tag@gmail.com', 'owner', '2026-01-03T00:00:00.000Z')],
      [{ id: 'p1', userId: 'u-keep' }]);
    const { server, up } = await bootFixture(3146, dir);
    check('B5: fixture server boots', up);
    const users = readJson(dir, 'users.json', []);
    check('B5: owner duplicate is a no-op', users.length === 3, `users=${users.length}`);
    server.kill('SIGKILL');
  }
}

async function main() {
  await partA();
  await partB();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
