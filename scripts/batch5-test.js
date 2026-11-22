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
  // - Round 2 (D-1): dynamic keys in Tools/AIStudio — tab label keys,
  //   failure-reason keys, and the plan/audit conditional keys.
  const toolsSrc = fs.readFileSync(path.join(srcDir, 'components', 'Tools.jsx'), 'utf8');
  const aiSrc = fs.readFileSync(path.join(srcDir, 'components', 'AIStudio.jsx'), 'utf8');
  for (const m of toolsSrc.matchAll(/'(failReason[A-Za-z]+)'/g)) used.add(m[1]);
  for (const m of aiSrc.matchAll(/'(aiTab[A-Za-z]+|aiPlanAdded[A-Za-z]+|aiAudit[A-Za-z]+)'/g)) used.add(m[1]);
  // D-1 wiring rule: every shell surface must RECEIVE the translator
  // from App and actually consume it (Round 2 — Auth/Tools/AI Studio
  // were the last English-only surfaces).
  check('D-1: App passes tr to Tools', /<Tools[^>]*tr=\{tr\}/.test(appSrc));
  check('D-1: App passes tr to AIStudio', /<AIStudio[^>]*tr=\{tr\}/.test(appSrc));
  check('D-1: Tools consumes tr', /const t = tr \|\|/.test(toolsSrc) && (toolsSrc.match(/t\('/g) || []).length >= 30,
    't calls: ' + (toolsSrc.match(/t\('/g) || []).length);
  check('D-1: AIStudio consumes tr', /const t = tr \|\|/.test(aiSrc) && (aiSrc.match(/t\('/g) || []).length >= 30,
    't calls: ' + (aiSrc.match(/t\('/g) || []).length);
  check('D-1: Auth consumes the translator', /trFor\(lang, dict/.test(fs.readFileSync(path.join(srcDir, 'components', 'Auth.jsx'), 'utf8')));
  const missingEn = [...used].filter((k) => !EN[k]);
  const missingHi = [...used].filter((k) => !HI[k]);
  check('every used i18n key exists in EN', missingEn.length === 0, missingEn.join(','));
  check('every used i18n key exists in HI', missingHi.length === 0, missingHi.join(','));
  check('EN/HI merged key parity', JSON.stringify(Object.keys(EN).sort()) === JSON.stringify(Object.keys(HI).sort()),
    `en=${Object.keys(EN).length} hi=${Object.keys(HI).length}`);

  // ---- 1b. D-4 token governance: public/tokens.css is generated
  // from src/index.css by gen-tokens.mjs — its shared subset must
  // equal the SPA values in both themes, and carry the GENERATED
  // marker so nobody hand-edits it again.
  const spaCss = fs.readFileSync(path.join(srcDir, 'index.css'), 'utf8');
  const tokensCss = fs.readFileSync(path.join(root, 'frontend', 'public', 'tokens.css'), 'utf8');
  const grab = (text, re) => { const m = text.match(re); return m ? m[1] : ''; };
  const parseVars = (blockText) => { const o = {}; for (const m of blockText.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) o[m[1]] = m[2].trim(); return o; };
  const SUBSET = ['--bg', '--surface', '--ink', '--ink-2', '--muted', '--line', '--gold-text', '--brand-text', '--red-text'];
  const spaLight = parseVars(grab(spaCss, /:root\{([^}]+)\}/));
  const spaDark = parseVars(grab(spaCss, /\[data-theme="dark"\]\{([^}]+)\}/));
  const genLight = parseVars(grab(tokensCss, /:root \{\n?\s*([^}]+)\}/));
  const genDark = parseVars(grab(tokensCss, /prefers-color-scheme: dark\) \{\s*:root \{\s*([^}]+)\}/));
  check('D-4: tokens.css carries the GENERATED marker', tokensCss.includes('GENERATED by gen-tokens.mjs'));
  check('D-4: tokens.css light subset matches the SPA tokens', SUBSET.every((n) => genLight[n] === spaLight[n]),
    SUBSET.filter((n) => genLight[n] !== spaLight[n]).map((n) => `${n}: gen=${genLight[n]} spa=${spaLight[n]}`).join(' '));
  check('D-4: tokens.css dark subset matches the SPA tokens', SUBSET.every((n) => genDark[n] === spaDark[n]),
    SUBSET.filter((n) => genDark[n] !== spaDark[n]).map((n) => `${n}: gen=${genDark[n]} spa=${spaDark[n]}`).join(' '));
  // D-4 guard: no var(--x) reference in the SPA stylesheet may point
  // at a token that is never defined (the R2-L1 --radius-md class of
  // bug). A reference WITH a fallback value is allowed by design.
  const definedVars = new Set([...spaCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const undefVars = new Set();
  for (const m of spaCss.matchAll(/var\((--[a-z0-9-]+)(\s*,)?/gi)) {
    if (!m[2] && !definedVars.has(m[1])) undefVars.add(m[1]);
  }
  check('D-4: no undefined var() references in index.css', undefVars.size === 0, [...undefVars].join(','));

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
