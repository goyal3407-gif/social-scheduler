'use strict';
// Batch 5 (fix batch, 2026-11-21) static guarantees:
//  1. Every translation key used anywhere in frontend/src exists in BOTH
//     languages of the merged dictionary (CORE in i18n.js + lazy DICT in
//     i18n-dict.js) — including the dynamic keys (drawer NAV ids,
//     Pricing PLAN_EXTRAS / PLAN_BLURBS values).
//  2. Bundle shape proofs for the dedupe (item 2) and wizard merge
//     (item 3): no home-search pill, no inline topnav search form, no
//     "Two quick steps", no GuideWizard chunk; the merged wizard copy
//     and the Hinglish dictionary ship in the lazy chunk, not main.
//  3. Main chunk stays under the 220 KB guard.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

async function main() {
  const root = path.join(__dirname, '..');
  const core = await import(pathToFileURL(path.join(root, 'frontend', 'src', 'i18n.js')).href);
  const dict = await import(pathToFileURL(path.join(root, 'frontend', 'src', 'i18n-dict.js')).href);
  const EN = { ...core.CORE.en, ...dict.DICT.en };
  const HI = { ...core.CORE.hi, ...dict.DICT.hi };

  // ---- 1. key coverage ----
  const srcDir = path.join(root, 'frontend', 'src');
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.jsx?$/.test(f)) files.push(p);
    }
  })(srcDir);
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:t|tr|tt)\('([A-Za-z0-9]+)'\)/g)) used.add(m[1]);
  }
  // Dynamic keys the literal scan cannot see:
  // - the drawer renders tr(id) for each NAV id ('ai' maps to 'aiStudio')
  const appSrc = fs.readFileSync(path.join(srcDir, 'App.jsx'), 'utf8');
  const navStart = appSrc.indexOf('const NAV = [');
  const navBlock = appSrc.slice(navStart, appSrc.indexOf(']', navStart));
  for (const m of navBlock.matchAll(/id: '([a-z]+)'/g)) used.add(m[1] === 'ai' ? 'aiStudio' : m[1]);
  // - Pricing renders t(k) for PLAN_EXTRAS values and t(PLAN_BLURBS[plan])
  const pricingSrc = fs.readFileSync(path.join(srcDir, 'components', 'Pricing.jsx'), 'utf8');
  for (const m of pricingSrc.matchAll(/'(feat[A-Za-z]+|blurb[A-Za-z]+)'/g)) used.add(m[1]);
  const missingEn = [...used].filter((k) => !EN[k]);
  const missingHi = [...used].filter((k) => !HI[k]);
  check('every used i18n key exists in EN', missingEn.length === 0, missingEn.join(','));
  check('every used i18n key exists in HI', missingHi.length === 0, missingHi.join(','));
  check('EN/HI merged key parity', JSON.stringify(Object.keys(EN).sort()) === JSON.stringify(Object.keys(HI).sort()),
    `en=${Object.keys(EN).length} hi=${Object.keys(HI).length}`);

  // ---- 2/3. bundle shape ----
  const assetsDir = path.join(root, 'frontend', 'dist', 'assets');
  check('frontend dist exists (build ran)', fs.existsSync(assetsDir), 'run: npm --prefix frontend run build');
  if (fs.existsSync(assetsDir)) {
    const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    const read = (f) => fs.readFileSync(path.join(assetsDir, f), 'utf8');
    const main = jsFiles.find((f) => f.startsWith('index-'));
    const mainSrc = main ? read(main) : '';
    const allSrc = jsFiles.map(read).join('\n');
    check('main chunk exists', !!main, jsFiles.join(','));
    check('main JS chunk < 220 KB', !!main && fs.statSync(path.join(assetsDir, main)).size < 220 * 1024,
      main ? String(fs.statSync(path.join(assetsDir, main)).size) : 'no main');
    check('no home-search pill in any chunk (item 2 dedupe)', !allSrc.includes('home-search'));
    check('no topnav-search form in any chunk (item 2 dedupe)', !allSrc.includes('topnav-search'));
    check('no "Two quick steps" anywhere (item 3 wizard merge)', !allSrc.includes('Two quick steps'));
    check('no GuideWizard chunk ships (item 3 wizard merge)', !jsFiles.some((f) => f.startsWith('GuideWizard')));
    check('merged wizard copy ships ("Three quick steps")', allSrc.includes('Three quick steps'));
    check('Hinglish glance heading ships outside the main chunk (lazy dict)',
      allSrc.includes('Aaj ek nazar mein') && !mainSrc.includes('Aaj ek nazar mein'));
    check('language switch affordance ships (item 4)', mainSrc.includes('Badlein'));
  }

  console.log(`batch5-test: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.log('FAIL harness error: ' + ((e && e.stack) || e)); process.exit(1); });
