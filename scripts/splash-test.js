'use strict';
// H-07 splash-screen (2026-11-22) static guarantees:
//  1. App.jsx hides the native splash through a DYNAMIC import of
//     @capacitor/splash-screen, behind the isNativeShell() guard, so
//     on the plain web the path is a complete no-op (guard first).
//  2. The hide fires when the auth state settles and a 4 s backstop
//     timer exists, so the splash can never hang forever.
//  3. No static (top-level) import of the plugin anywhere in src —
//     it must stay a lazy chunk, out of the main bundle.
//  4. The plugin is declared in the frontend package.json.
//  5. When the sibling Android project is present in this workspace,
//     the SHIPPED packaging contract (v1.3.5, production-ready pass
//     22 Nov 2026): the SplashScreen plugin is NOT packaged — the
//     v1.3.3 hand-merge that added it dropped the compiled bridge
//     layouts and crashed on launch, so v1.3.4 removed it and v1.3.5
//     rebuilt on the complete v1.3 resource table. The Android
//     capacitor.config.json (root + synced assets copy) must carry
//     NO SplashScreen section, capacitor.plugins.json must register
//     exactly App + Filesystem, both stub pages keep their guarded
//     (harmless, no-op) hide attempt, and build.gradle is at
//     versionCode 9 / 1.3.5. (The plugin stays declared in the
//     Android project's package.json as a documented leftover —
//     uninstall before any future `cap sync`; not asserted here.)
//     These section-5 assertions replaced the v1.3.3-era ones in the
//     production-ready pass; the web-half checks above are unchanged.
const fs = require('fs');
const path = require('path');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function skip(name) { console.log('SKIP ' + name); }

function main() {
  const root = path.join(__dirname, '..');
  const appJsx = fs.readFileSync(path.join(root, 'frontend', 'src', 'App.jsx'), 'utf8');

  // ---- 1+2. hide wiring in App.jsx ----
  const fnStart = appJsx.indexOf('const hideSplash = useCallback');
  check('hideSplash helper exists', fnStart >= 0);
  const fnBody = fnStart >= 0 ? appJsx.slice(fnStart, appJsx.indexOf('}, [])', fnStart)) : '';
  const guardIdx = fnBody.indexOf('isNativeShell()');
  const importIdx = fnBody.indexOf("import('@capacitor/splash-screen')");
  check('dynamic import of @capacitor/splash-screen', importIdx >= 0);
  check('isNativeShell() guard runs before the import (web-inert)', guardIdx >= 0 && importIdx > guardIdx,
    'guard@' + guardIdx + ' import@' + importIdx);
  check('SplashScreen.hide() is called', fnBody.includes('SplashScreen.hide'));
  check('hide path is try/caught', fnBody.includes('try {') && fnBody.includes('catch'));
  check('one-shot ref guard', appJsx.includes('splashHiddenRef'));
  check('hide fires when auth settles', appJsx.includes('if (authChecked) hideSplash()'));
  check('4s backstop timer', appJsx.includes('setTimeout(hideSplash, 4000)'));

  // ---- 3. no static import of the plugin in src ----
  const srcDir = path.join(root, 'frontend', 'src');
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.jsx?$/.test(f)) files.push(p);
    }
  })(srcDir);
  const staticImport = files.some((f) =>
    /^\s*import\s[^;]*@capacitor\/splash-screen/m.test(fs.readFileSync(f, 'utf8')));
  check('no static import of @capacitor/splash-screen in src', !staticImport);

  // ---- dist shape (only when a build exists) ----
  const distAssets = path.join(root, 'frontend', 'dist', 'assets');
  if (fs.existsSync(distAssets)) {
    const chunks = fs.readdirSync(distAssets).filter((f) => f.endsWith('.js'));
    const bodies = chunks.map((f) => fs.readFileSync(path.join(distAssets, f), 'utf8'));
    const mainIdx = bodies.findIndex((b) => b.includes('hideSplash') || b.includes('splashHiddenRef'));
    const lazyIdx = bodies.findIndex((b, i) => i !== mainIdx && b.includes('SplashScreen'));
    check('plugin ships as a lazy chunk (not the main chunk)', lazyIdx >= 0, 'chunks=' + chunks.join(','));
  } else skip('dist chunk shape (no build yet)');

  // ---- 4. frontend declaration ----
  const fePkg = JSON.parse(fs.readFileSync(path.join(root, 'frontend', 'package.json'), 'utf8'));
  check('frontend package.json declares @capacitor/splash-screen',
    !!(fePkg.dependencies && fePkg.dependencies['@capacitor/splash-screen']));

  // ---- 5. Android project (workspace-sibling; skip when absent) ----
  const andRoot = path.join(root, '..', 'goyal-kumar-scheduler-android');
  if (!fs.existsSync(andRoot)) { skip('android project checks (project not in workspace)'); return done(); }

  const cfg = JSON.parse(fs.readFileSync(path.join(andRoot, 'capacitor.config.json'), 'utf8'));
  check('config: NO SplashScreen section (plugin not packaged)',
    !cfg.plugins || !('SplashScreen' in cfg.plugins));

  const assetsCfg = JSON.parse(fs.readFileSync(path.join(andRoot, 'android', 'app', 'src', 'main', 'assets', 'capacitor.config.json'), 'utf8'));
  check('assets capacitor.config.json also has NO SplashScreen section',
    !assetsCfg.plugins || !('SplashScreen' in assetsCfg.plugins));
  const pluginsJson = JSON.parse(fs.readFileSync(path.join(andRoot, 'android', 'app', 'src', 'main', 'assets', 'capacitor.plugins.json'), 'utf8'));
  check('capacitor.plugins.json registers exactly App + Filesystem (no splash plugin)',
    pluginsJson.length === 2 &&
    pluginsJson.some((p) => p.pkg === '@capacitor/app') &&
    pluginsJson.some((p) => p.pkg === '@capacitor/filesystem') &&
    !pluginsJson.some((p) => p.pkg === '@capacitor/splash-screen'),
    'got ' + pluginsJson.map((p) => p.pkg).join(','));

  for (const rel of ['www/index.html', 'android/app/src/main/assets/public/index.html']) {
    const stub = fs.readFileSync(path.join(andRoot, rel), 'utf8');
    check('stub attempts a guarded splash hide: ' + rel,
      stub.includes('Capacitor.Plugins.SplashScreen') && stub.includes('.hide()'));
  }

  const gradle = fs.readFileSync(path.join(andRoot, 'android', 'app', 'build.gradle'), 'utf8');
  check('build.gradle versionCode 9', /versionCode\s+9\b/.test(gradle));
  check('build.gradle versionName 1.3.5', gradle.includes('versionName "1.3.5"'));

  return done();
}

function done() {
  console.log('splash-test: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

main();
