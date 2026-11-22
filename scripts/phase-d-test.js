// KiluaAI Phase D test suite — polish + growth (server-backed parts).
// Boots the real server against an isolated JSON data dir with the
// Instagram Graph API stubbed at the fetch layer.
// Coverage:
//  D6 link-in-bio: slug validation, save, slug uniqueness (409),
//     public page renders name/links/published post, disabled → 404,
//     unknown slug → 404, link validation (>10, bad URL).
//  D8 preview link: create, public page lists upcoming posts,
//     regenerate invalidates the old token.
//  D9 Gulf caption pack: 5 pack templates for users with and without
//     their own templates; pack delete → 400.
//  D11 referrals: code at signup, ?ref signup records the inviter's
//     count, unknown ref ignored, /api/referral shape.
// Run: node scripts/phase-d-test.js
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

const PORT = 3113;
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
      SESSION_SECRET: ['test', 'secret', 'd'].join('-'), CRON_SECRET: ['cron', 'secret', 'd'].join('-'),
      META_APP_SECRET: ['test', 'meta', 'secret'].join('-'),
      GRAPH_STUB_LOG: stubLog, NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return server;
}

async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('server did not come up');
}

function makeClient(base) {
  let cookie = '';
  return {
    async call(method, p, body) {
      const r = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual'
      });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      return { status: r.status, data, text, headers: r.headers };
    },
    async raw(p) {
      const r = await fetch(base + p, { redirect: 'manual' });
      return { status: r.status, text: await r.text() };
    }
  };
}

async function connectInstagram(client, base) {
  const link = await client.call('POST', '/api/instagram/ig-connect-link', {});
  const dlg = await fetch(link.data.url, { redirect: 'manual' });
  const state = new URL(dlg.headers.get('location') || '').searchParams.get('state');
  const cb = await fetch(`${base}/api/instagram/ig-callback?code=code-alice&state=${encodeURIComponent(state)}`);
  return { status: cb.status, text: await cb.text() };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiluaai-phase-d-'));
  const stubLog = path.join(dataDir, 'graph.log');
  const server = startServer({ port: PORT, dataDir, stubLog });
  try {
    await waitUp(BASE);

    // ---------- D11 referrals ----------
    const A = makeClient(BASE);
    let r = await A.call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'Kilua-Test-9871', name: 'Alice A' });
    check('D: inviter signup succeeds', r.status === 200, JSON.stringify(r.data).slice(0, 120));
    r = await A.call('GET', '/api/referral');
    check('D11: referral returns a code + link + zero count', r.data.ok && /^K[0-9A-F]{6}$/.test(r.data.code || '') && (r.data.link || '').includes(`?ref=${r.data.code}`) && r.data.count === 0, JSON.stringify(r.data).slice(0, 200));
    const codeA = r.data.code;

    const B = makeClient(BASE);
    r = await B.call('POST', '/api/auth/signup', { email: 'b@example.com', password: 'Kilua-Test-9871', ref: codeA });
    check('D11: signup with a valid ref succeeds', r.status === 200);
    r = await A.call('GET', '/api/referral');
    check('D11: inviter count is 1 after the referred signup', r.data.count === 1, `count=${r.data.count}`);

    const Cx = makeClient(BASE);
    r = await Cx.call('POST', '/api/auth/signup', { email: 'c@example.com', password: 'Kilua-Test-9871', ref: 'ZZZZZZ' });
    check('D11: signup with an unknown ref still succeeds (ignored)', r.status === 200);
    r = await A.call('GET', '/api/referral');
    check('D11: unknown ref does not change the count', r.data.count === 1, `count=${r.data.count}`);

    // ---------- D9 caption pack ----------
    r = await B.call('GET', '/api/templates');
    const packForB = (r.data.templates || []).filter((t) => String(t.id).startsWith('pack-'));
    check('D9: pack of 5 present for a user with no own templates', packForB.length === 5, `got ${packForB.length}`);
    check('D9: pack covers salon/real estate/restaurant/garage/cleaning', ['pack-salon', 'pack-realestate', 'pack-restaurant', 'pack-garage', 'pack-cleaning'].every((id) => packForB.some((t) => t.id === id)));
    r = await B.call('POST', '/api/templates', { name: 'Mine', text: 'my own caption' });
    check('D9: own template can be created', r.status === 200 || r.status === 201, `status ${r.status}`);
    r = await B.call('GET', '/api/templates');
    const all = r.data.templates || [];
    check('D9: pack still present alongside own templates', all.filter((t) => String(t.id).startsWith('pack-')).length === 5 && all.some((t) => t.name === 'Mine'));
    r = await B.call('DELETE', '/api/templates/pack-salon');
    check('D9: pack templates cannot be deleted', r.status === 400, `status ${r.status}`);

    // ---------- D6 link-in-bio ----------
    r = await A.call('POST', '/api/bio', { slug: 'Bad Slug!', enabled: true, links: [] });
    check('D6: invalid slug rejected', r.status === 400, `status ${r.status}`);
    r = await A.call('POST', '/api/bio', { slug: 'alice-page', enabled: true, links: [{ title: 'My shop', url: 'https://shop.example.com' }, { title: 'Bad', url: 'notaurl' }] });
    check('D6: link without a full URL rejected', r.status === 400, `status ${r.status}`);
    r = await A.call('POST', '/api/bio', { slug: 'alice-page', enabled: true, links: Array.from({ length: 11 }, (_, i) => ({ title: `L${i}`, url: 'https://x.example.com' })) });
    check('D6: more than 10 links rejected', r.status === 400, `status ${r.status}`);
    r = await A.call('POST', '/api/bio', { slug: 'alice-page', enabled: true, links: [{ title: 'My shop', url: 'https://shop.example.com' }] });
    check('D6: bio saves', r.status === 200 && r.data.bio.slug === 'alice-page', JSON.stringify(r.data).slice(0, 160));
    r = await B.call('POST', '/api/bio', { slug: 'alice-page', enabled: true, links: [] });
    check('D6: slug taken by another user → 409', r.status === 409, `status ${r.status}`);

    // publish one post for A so the bio page has a published thumbnail/link
    await connectInstagram(A, BASE);
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/bio.mp4', mediaType: 'video', caption: 'Bio post', format: 'REELS', scheduleTime: new Date(Date.now() - 60000).toISOString() });
    const bioPostId = r.data.post.id;
    r = await A.call('POST', `/api/posts/${bioPostId}/publish`, {});
    check('D6: setup post publishes (stub)', r.status === 200, `status ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);

    let pub = await A.raw('/bio/alice-page');
    check('D6: public bio page renders', pub.status === 200 && pub.text.includes('Alice A') && pub.text.includes('My shop') && pub.text.includes('Powered by') && pub.text.includes('KiluaAI'), pub.text.slice(0, 200));
    check('D6: bio page links the published post', pub.text.includes('https://www.instagram.com/p/STUBPOST/'));

    r = await A.call('POST', '/api/bio', { slug: 'alice-page', enabled: false, links: [{ title: 'My shop', url: 'https://shop.example.com' }] });
    pub = await A.raw('/bio/alice-page');
    check('D6: disabled bio page → 404', pub.status === 404, `status ${pub.status}`);
    pub = await A.raw('/bio/no-such-page');
    check('D6: unknown slug → 404', pub.status === 404, `status ${pub.status}`);

    // ---------- D8 preview link ----------
    r = await A.call('GET', '/api/preview-link');
    check('D8: no preview link initially', r.status === 200 && r.data.url === '', JSON.stringify(r.data).slice(0, 120));
    r = await A.call('POST', '/api/posts', { mediaUrl: 'https://example.com/soon.mp4', mediaType: 'video', caption: 'Upcoming preview post', format: 'REELS', scheduleTime: new Date(Date.now() + 86400000).toISOString() });
    check('D8: setup scheduled post saves', r.status === 200);
    r = await A.call('POST', '/api/preview-link', {});
    check('D8: preview link created', r.status === 200 && /\/preview\//.test(r.data.url || ''), JSON.stringify(r.data).slice(0, 160));
    const token1 = r.data.url.split('/preview/')[1];
    pub = await A.raw(`/preview/${token1}`);
    check('D8: public preview lists the upcoming post (no login)', pub.status === 200 && pub.text.includes('Upcoming preview post'), pub.text.slice(0, 160));
    r = await A.call('POST', '/api/preview-link/regenerate', {});
    const token2 = (r.data.url || '').split('/preview/')[1];
    check('D8: regenerate returns a different token', Boolean(token2) && token2 !== token1);
    pub = await A.raw(`/preview/${token1}`);
    check('D8: old preview link dies after regenerate', pub.status === 404, `status ${pub.status}`);
    pub = await A.raw(`/preview/${token2}`);
    check('D8: new preview link works', pub.status === 200 && pub.text.includes('Upcoming preview post'));
    pub = await A.raw('/preview/garbage.token');
    check('D8: garbage token → 404', pub.status === 404, `status ${pub.status}`);
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nphase-d: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
