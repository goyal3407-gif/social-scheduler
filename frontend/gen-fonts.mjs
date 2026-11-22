// Build-time font materialisation (same defensive pattern as
// gen-icons.mjs). The self-hosted Inter variable font ships in the
// repo as base64 text (font-src/*.b64) because the deployment
// snapshot route carries UTF-8 text only; this script decodes the
// woff2 files into public/fonts/ before Vite copies them into dist.
// Defensive by design: any failure is a warning, never a failed
// build (the site must deploy even if fonts cannot be written —
// the CSS font stack falls back to system fonts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'font-src');
const outDir = path.join(here, 'public', 'fonts');
try {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.b64')) continue;
    const target = name.slice(0, -4);
    const buf = Buffer.from(fs.readFileSync(path.join(srcDir, name), 'utf8').trim(), 'base64');
    fs.writeFileSync(path.join(outDir, target), buf);
    console.log(`[gen-fonts] wrote public/fonts/${target} (${buf.length} bytes)`);
  }
} catch (e) {
  console.warn('[gen-fonts] WARNING: could not materialise fonts:', e && e.message ? e.message : e);
}
