// KiluaAI batch-4 suite: UI/UX batch — compact Dashboard, Pricing as
// its own tab, one job per tab.
//
// What an API suite can honestly verify for a UI batch:
//   1. i18n parity — every dictionary key exists in BOTH languages
//      (the batch adds ~45 keys; a missing Hindi twin would silently
//      fall back to English for Hindi users).
//   2. The Pricing tab's data contract — /api/plan/usage pricing
//      options now carry each plan's limits + bridge/AI facts from
//      the server's single plan config, so the comparison the user
//      reads is the config the server enforces.
//   3. The built bundle — Pricing is its own lazy chunk (the main
//      chunk must not carry its copy), the removed Dashboard sections
//      are really gone from every chunk, and the new dictionary
//      strings (both languages) shipped.
// Render-level behaviour (glance renders, Pricing tab renders, the
// best-for-you marker) is covered by scripts/render-smoke.js.
//
// Run: node scripts/batch4-test.js   (build first: npm --prefix frontend run build)
// Exits non-zero if any check fails.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

let failures = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) { passes++; console.log(`PASS ${name}`); }
  else { failures++; console.log(`FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  // ---- 1. i18n parity ----
  const i18n = await import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'i18n.js')).href);
  const dictMod = await import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'i18n-dict.js')).href);
  // Batch 5: the dictionary is split — CORE in i18n.js, the full dict in
  // the lazily loaded i18n-dict.js. Parity is checked on the MERGED set.
  const STRINGS = { en: { ...i18n.CORE.en, ...dictMod.DICT.en }, hi: { ...i18n.CORE.hi, ...dictMod.DICT.hi } };
  const en = Object.keys(STRINGS.en).sort();
  const hi = Object.keys(STRINGS.hi).sort();
  check('i18n EN/HI exact key parity', JSON.stringify(en) === JSON.stringify(hi), `en=${en.length} hi=${hi.length}`);
  const batch4Keys = ['pricing', 'myPlan', 'todayGlance', 'publishedToday', 'problems', 'allGood', 'connected', 'notConnected', 'connectionBroken', 'reconnect', 'openConnections', 'reviewInQueue', 'nothingScheduled', 'monthly', 'yearly', 'twoMonthsFree', 'mostPopular', 'bestForYou', 'currentPlan', 'perMonth', 'perYear', 'postsToday', 'postsThisMonth', 'accountsConnected', 'aiCaptionsToday', 'lifetime', 'activeUntil', 'upgrade', 'paymentSoon', 'recHitting', 'recNear', 'recFits', 'recTop', 'recComp', 'featAccounts', 'featAccountsUnlimited', 'featPostsMonth', 'featPostsMonthUnlimited', 'featPostsDay', 'featServerReadyAll', 'featServerReadyNext', 'featCrossPostBulk', 'featPriority', 'featMultiAccount', 'featTeam', 'featAnalytics', 'featSupportFirst', 'featAi', 'featAiUnlimited', 'pricingSub', 'upgradeYearlyLine', 'probPosts', 'probOverdue', 'probConnection'];
  check('all batch-4 keys present in both languages', batch4Keys.every((k) => STRINGS.en[k] && STRINGS.hi[k]),
    batch4Keys.filter((k) => !STRINGS.en[k] || !STRINGS.hi[k]).join(','));
  check('recommendation strings carry the {plan} placeholder in both languages',
    ['recHitting', 'recNear'].every((k) => STRINGS.en[k].includes('{plan}') && STRINGS.hi[k].includes('{plan}')));

  // ---- 2. Pricing data contract ----
  const port = 3241;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiluaai-batch4-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SESSION_SECRET: 'test-secret-for-batch4-only-0123456789abcdef', NODE_ENV: 'test', CRON_SECRET: 'test-cron-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(`${base}/api/health`); up = r.ok; } catch { await sleep(250); }
    }
    check('server boots', up, serverLog.slice(-300));
    // The FIRST account on a fresh server is the owner (effective
    // Ultra by design) — sign one up and discard it, so the account
    // under test is an ordinary member on the Free plan.
    const ownerClient = makeClient(base);
    await ownerClient.call('POST', '/api/auth/signup', { email: 'owner-first@test.local', password: 'batch4-pass-123', name: 'Owner First' });
    const A = makeClient(base);
    const su = await A.call('POST', '/api/auth/signup', { email: 'batch4@test.local', password: 'batch4-pass-123', name: 'Batch Four' });
    check('signup works', su.status === 200 && !!su.data?.user, JSON.stringify(su.data).slice(0, 160));
    const u = await A.call('GET', '/api/plan/usage');
    const opts = u.data?.pricing?.options || [];
    check('pricing options: 4 plans in order', opts.map((o) => o.plan).join(',') === 'free,pro,max,ultra', opts.map((o) => o.plan).join(','));
    check('every option carries limits + fullBridge + aiPerDay from the server config',
      opts.every((o) => o.limits && ['accounts', 'igAccounts', 'postsPerDay', 'postsPerMonth'].every((k) => k in o.limits) && typeof o.fullBridge === 'boolean' && 'aiPerDay' in o));
    const by = Object.fromEntries(opts.map((o) => [o.plan, o]));
    check('free limits are the enforced ones (2 accounts, 1 IG, 2/day, 30/month)',
      by.free?.limits?.accounts === 2 && by.free?.limits?.igAccounts === 1 && by.free?.limits?.postsPerDay === 2 && by.free?.limits?.postsPerMonth === 30,
      JSON.stringify(by.free?.limits));
    check('pro limits (3 accounts, 100/month, no daily cap)', by.pro?.limits?.accounts === 3 && by.pro?.limits?.postsPerMonth === 100 && by.pro?.limits?.postsPerDay === null);
    check('max is full-bridge with unlimited posts', by.max?.fullBridge === true && by.max?.limits?.postsPerMonth === null && by.max?.limits?.accounts === 10);
    check('ultra is full-bridge, unlimited accounts + AI', by.ultra?.fullBridge === true && by.ultra?.limits?.accounts === null && by.ultra?.aiPerDay === null);
    // ITEM 6 (owner decision 2026-11-21): pin the decided plan numbers
    // so any future drift fails loudly — Free AI 5/day · Pro AI 25/day ·
    // Max AI 100/day, and Max/Ultra carry no post caps at all.
    check('ITEM-6 decided limits pinned (AI 5/25/100, max+ultra no post caps)',
      by.free?.aiPerDay === 5 && by.pro?.aiPerDay === 25 && by.max?.aiPerDay === 100
      && by.max?.limits?.postsPerDay === null && by.ultra?.limits?.postsPerDay === null && by.ultra?.limits?.postsPerMonth === null,
      JSON.stringify(opts.map((o) => [o.plan, o.aiPerDay, o.limits?.postsPerDay, o.limits?.postsPerMonth])));
    check('free user kinds: free=current, rest=upgrade, charge = full price',
      by.free?.kind === 'current' && ['pro', 'max', 'ultra'].every((k) => by[k]?.kind === 'upgrade' && by[k]?.chargeInr === by[k]?.priceInr));
    check('usage block still present for the meters', !!u.data?.usage && 'postsThisMonth' in u.data.usage && 'accountsConnected' in u.data.usage);
  } finally {
    try { server.kill('SIGTERM'); } catch { /* already dead */ }
  }

  // ---- 3. Built bundle shape ----
  const assetsDir = path.join(__dirname, '..', 'frontend', 'dist', 'assets');
  check('frontend dist exists (build ran)', fs.existsSync(assetsDir), 'run: npm --prefix frontend run build');
  if (fs.existsSync(assetsDir)) {
    const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    const read = (f) => fs.readFileSync(path.join(assetsDir, f), 'utf8');
    const main = files.find((f) => f.startsWith('index-'));
    const pricingChunk = files.find((f) => f.startsWith('Pricing-'));
    check('main chunk exists', !!main, files.join(','));
    check('Pricing is its own lazy chunk', !!pricingChunk, files.join(','));
    const mainSrc = main ? read(main) : '';
    const pricingSrc = pricingChunk ? read(pricingChunk) : '';
    const allSrc = files.map(read).join('\n');
    check('Pricing-only copy lives outside the main chunk (batch 5: lazy dict chunk)',
      allSrc.includes('whole queue server-ready') && !mainSrc.includes('whole queue server-ready'));
    check('removed Dashboard sections are gone from every chunk',
      !allSrc.includes('Daily plan — today') && !allSrc.includes('Last 14 days') && !allSrc.includes('Recent activity'));
    check('old PlanCard heading literal is gone', !allSrc.includes('My Plan —'));
    check('new dictionary strings shipped in both languages',
      allSrc.includes('Today at a glance') && allSrc.includes('Tumhare liye best') && allSrc.includes('Plans ke daam'));
    check('MyStats moved, not deleted (its honest note still ships)', allSrc.includes('Your numbers') || allSrc.includes('Aapke numbers'));
    check('prices use Indian digit grouping (en-IN) in the Pricing chunk', pricingSrc.includes('en-IN'));
  }

  console.log(`batch4-test: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.log('FAIL harness error: ' + ((e && e.stack) || e)); process.exit(1); });
