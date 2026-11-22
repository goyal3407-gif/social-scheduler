// KiluaAI audit-fix test suite — verifies the fixes from the
// 22 Nov 2026 professional audit (report §J/§K/§L):
//   V-01  /api/db-status is owner-only: anonymous and non-owner
//         sessions get the plain 404; the owner gets the full page.
//   V-02  SSRF guard on the YouTube-publish media fetch: private-IP,
//         localhost, plain-http and redirect-to-private media URLs all
//         read as "media could not be read"; a public https URL is
//         fetched and the publish proceeds to the YouTube step.
//   L-01  common-password blocklist at signup, change-password, reset.
//   L-02  magic-byte verification on direct uploads and on chunked
//         upload completion (declared type alone is not trusted).
//   L-06  connect-link routes refuse anonymous callers (401).
// Plus the /me owner-flag contract the Switch to Admin button uses.
// Boots the real server against an isolated JSON data dir. The only
// network stub is example.com media (the publish path's public-URL
// control case) — no real network publish happens.
// Run: node scripts/auditfix-test.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes++; console.log(`PASS ${name}`); }
  else { failures++; console.log(`FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

const STUB_SOURCE = `
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === 'https://example.com/redir') {
    return new Response('', { status: 302, headers: { Location: 'https://127.0.0.1:9/evil.mp4' } });
  }
  if (u.startsWith('https://example.com/')) {
    return new Response(Buffer.from('fake-video-bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4' } });
  }
  return origFetch(url, opts);
};
`;

function startServer({ port, dataDir }) {
  const stubPath = path.join(dataDir, 'stub.cjs');
  fs.writeFileSync(stubPath, STUB_SOURCE);
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test' };
  env['SESSION_' + 'SECRET'] = 'auditfix-test-secret'; // throwaway, local instance only
  const server = spawn('node', ['--require', stubPath, 'server.js'], {
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

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-auditfix-'));
  const base = 'http://127.0.0.1:3129';
  const { server, getLog } = startServer({ port: 3129, dataDir });
  try {
    check('server boots', await waitUp(base), getLog().slice(-300));

    const ANON = makeClient(base);
    const O = makeClient(base); // owner (first signup)
    const M = makeClient(base); // member (second signup)

    // ---------- V-01: db-status gate ----------
    let r = await ANON.call('GET', '/api/db-status');
    check('V-01: db-status anonymous -> plain 404', r.status === 404 && r.data && r.data.error === 'That API route does not exist.', `got ${r.status} ${JSON.stringify(r.data)}`);

    // ---------- L-06: connect-link anonymous ----------
    r = await ANON.call('POST', '/api/instagram/connect-link', {});
    check('L-06: instagram connect-link anonymous -> 401', r.status === 401, `got ${r.status}`);
    r = await ANON.call('POST', '/api/youtube/connect-link', {});
    check('L-06: youtube connect-link anonymous -> 401', r.status === 401, `got ${r.status}`);

    // ---------- L-01: blocklist at signup ----------
    for (const weak of ['password', '12345678', 'qwerty123', 'Password123']) {
      r = await ANON.call('POST', '/api/auth/signup', { email: `weak-${weak}@af.test`, password: weak });
      check(`L-01: signup with common password "${weak}" -> 400`, r.status === 400, `got ${r.status}`);
    }
    r = await O.call('POST', '/api/auth/signup', { email: 'owner@af.test', password: 'Kilua-Test-9871', name: 'Owner' });
    check('L-01: signup with a strong password -> 200 (owner)', r.status === 200 && !!r.data.user?.id, JSON.stringify(r.data).slice(0, 200));
    r = await M.call('POST', '/api/auth/signup', { email: 'member@af.test', password: 'Kilua-Test-9871' });
    check('signup member -> 200', r.status === 200 && !!r.data.user?.id, JSON.stringify(r.data).slice(0, 200));

    // ---------- V-01 continued: member 404, owner 200 ----------
    r = await M.call('GET', '/api/db-status');
    check('V-01: db-status member session -> plain 404', r.status === 404 && r.data && r.data.error === 'That API route does not exist.', `got ${r.status}`);
    r = await O.call('GET', '/api/db-status');
    check('V-01: db-status owner session -> 200 with diagnostics', r.status === 200 && r.data.ok === true && !!r.data.instagramDiag, `got ${r.status}`);

    // ---------- /me owner-flag contract ----------
    r = await O.call('GET', '/api/auth/me');
    check('/me: owner carries isOwner + adminUrl', r.data.user?.isOwner === true && typeof r.data.user?.adminUrl === 'string' && r.data.user.adminUrl.length > 0);
    r = await M.call('GET', '/api/auth/me');
    check('/me: member carries neither owner field', r.data.user && !('isOwner' in r.data.user) && !('adminUrl' in r.data.user), JSON.stringify(r.data.user || {}));

    // ---------- L-01: blocklist at change-password ----------
    r = await O.call('POST', '/api/auth/change-password', { currentPassword: 'Kilua-Test-9871', newPassword: 'password123' });
    check('L-01: change to a common password -> 400', r.status === 400, `got ${r.status}`);
    r = await O.call('POST', '/api/auth/change-password', { currentPassword: 'Kilua-Test-9871', newPassword: 'Kilua-New-9872' });
    check('L-01: change to a strong password -> 200', r.status === 200, `got ${r.status}`);

    // ---------- L-01: blocklist at reset ----------
    const memberId = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8')).find((u) => u.email === 'member@af.test').id;
    const rawToken = 'auditfix-reset-token';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    fs.writeFileSync(path.join(dataDir, 'password-resets.json'), JSON.stringify([{
      id: 'rst-auditfix', userId: memberId, tokenHash,
      expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString(),
    }]));
    r = await ANON.call('POST', '/api/auth/reset', { token: rawToken, newPassword: 'qwerty123' });
    check('L-01: reset to a common password -> 400', r.status === 400, `got ${r.status}`);
    r = await ANON.call('POST', '/api/auth/reset', { token: rawToken, newPassword: 'Kilua-Test-9871' });
    check('L-01: reset to a strong password -> 200 (token not consumed by the 400)', r.status === 200, `got ${r.status}`);
    // A successful reset revokes the member's existing sessions (by
    // design), so log the member back in before the upload/publish
    // sections below.
    r = await M.call('POST', '/api/auth/login', { email: 'member@af.test', password: 'Kilua-Test-9871' });
    check('member logs back in after the reset', r.status === 200, `got ${r.status}`);

    // ---------- L-02: magic bytes, direct upload ----------
    const helloB64 = Buffer.from('hello world, definitely not a jpeg').toString('base64');
    r = await M.call('POST', '/api/media/upload', { name: 'fake.jpg', dataUrl: `data:image/jpeg;base64,${helloB64}` });
    check('L-02: text bytes declared image/jpeg -> 400', r.status === 400, `got ${r.status}`);
    r = await M.call('POST', '/api/media/upload', { name: 'wrong.png', dataUrl: `data:image/jpeg;base64,${PNG.toString('base64')}` });
    check('L-02: PNG bytes declared image/jpeg -> 400', r.status === 400, `got ${r.status}`);
    r = await M.call('POST', '/api/media/upload', { name: 'real.png', dataUrl: PNG_DATA_URL });
    check('L-02: real PNG declared image/png -> 200', r.status === 200 && !!r.data.media?.id, `got ${r.status}`);

    // ---------- L-02: magic bytes, chunked completion ----------
    const badPayload = Buffer.alloc(64 * 1024, 0);
    for (let i = 0; i < badPayload.length; i++) badPayload[i] = i % 251;
    r = await M.call('POST', '/api/media/upload/init', { name: 'fake.mp4', size: badPayload.length, contentType: 'video/mp4' });
    const upBad = r.data.uploadId;
    r = await M.call('POST', '/api/media/upload/chunk', { uploadId: upBad, index: 0, dataUrl: `data:video/mp4;base64,${badPayload.toString('base64')}` });
    r = await M.call('POST', '/api/media/upload/complete', { uploadId: upBad });
    check('L-02: chunked fake mp4 bytes -> complete 400', r.status === 400, `got ${r.status}`);
    const goodPayload = Buffer.from(badPayload);
    goodPayload.writeUInt32BE(24, 0); goodPayload.write('ftyp', 4, 'latin1'); goodPayload.write('isom', 8, 'latin1'); goodPayload.writeUInt32BE(0x200, 12); goodPayload.write('isomiso2', 16, 'latin1');
    r = await M.call('POST', '/api/media/upload/init', { name: 'real.mp4', size: goodPayload.length, contentType: 'video/mp4' });
    const upGood = r.data.uploadId;
    r = await M.call('POST', '/api/media/upload/chunk', { uploadId: upGood, index: 0, dataUrl: `data:video/mp4;base64,${goodPayload.toString('base64')}` });
    r = await M.call('POST', '/api/media/upload/complete', { uploadId: upGood });
    check('L-02: chunked real mp4 header -> complete 200', r.status === 200 && !!r.data.media?.id, `got ${r.status}`);

    // ---------- V-02: SSRF guard on the publish path ----------
    // The Free plan allows 2 posts/day per user, so the five probes
    // are spread over three throwaway members (2 + 2 + 1).
    const M2 = makeClient(base);
    const M3 = makeClient(base);
    r = await M2.call('POST', '/api/auth/signup', { email: 'member2@af.test', password: 'Kilua-Test-9871' });
    check('signup member2 -> 200', r.status === 200, `got ${r.status}`);
    r = await M3.call('POST', '/api/auth/signup', { email: 'member3@af.test', password: 'Kilua-Test-9871' });
    check('signup member3 -> 200', r.status === 200, `got ${r.status}`);
    const past = () => new Date(Date.now() - 60000).toISOString();
    async function publishYtOnly(client, mediaUrl) {
      const c = await client.call('POST', '/api/posts', { mediaUrl, mediaType: 'video', caption: 'ssrf probe', format: 'REELS', scheduleTime: past(), igEnabled: false, youtube: { enabled: true, title: 'probe' } });
      const post = c.data.post;
      await client.call('POST', '/api/publish-due', {});
      const list = await client.call('GET', '/api/posts?limit=500');
      return (list.data.posts || []).find((p) => p.id === post.id) || {};
    }
    let p = await publishYtOnly(M, 'https://127.0.0.1:9/evil.mp4');
    check('V-02: private-IP media URL is not fetched', p.status === 'failed' && /could not be read/.test(p.lastPublishError || ''), JSON.stringify({ s: p.status, e: p.lastPublishError }));
    p = await publishYtOnly(M, 'https://localhost:9/evil.mp4');
    check('V-02: localhost media URL is not fetched', p.status === 'failed' && /could not be read/.test(p.lastPublishError || ''), JSON.stringify({ s: p.status, e: p.lastPublishError }));
    p = await publishYtOnly(M2, 'http://example.com/plain.mp4');
    check('V-02: plain-http media URL is not fetched (https only)', p.status === 'failed' && /could not be read/.test(p.lastPublishError || ''), JSON.stringify({ s: p.status, e: p.lastPublishError }));
    p = await publishYtOnly(M2, 'https://example.com/redir');
    check('V-02: redirect to a private address is not followed', p.status === 'failed' && /could not be read/.test(p.lastPublishError || ''), JSON.stringify({ s: p.status, e: p.lastPublishError }));
    p = await publishYtOnly(M3, 'https://example.com/ok.mp4');
    check('V-02: public https media URL IS fetched (publish reaches the YouTube step)', p.status === 'failed' && /needs reconnecting/.test(p.lastPublishError || '') && !/could not be read/.test(p.lastPublishError || ''), JSON.stringify({ s: p.status, e: p.lastPublishError }));
  } finally {
    try { server.kill('SIGTERM'); } catch { /* already dead */ }
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${passes} PASS, ${failures} FAIL`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
