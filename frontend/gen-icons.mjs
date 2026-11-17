// Build-time icon materialisation. The gold KiluaAI logo ships in the
// repo as base64 text (icon-src/*.b64) because the deployment snapshot
// route carries UTF-8 text only; this script decodes the PNG/ICO files
// into public/ before Vite copies them into dist. Defensive by design:
// any failure is a warning, never a failed build (the site must deploy
// even if icons cannot be written).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'icon-src');
const outDir = path.join(here, 'public');
try {
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.b64')) continue;
    const target = name.slice(0, -4);
    const buf = Buffer.from(fs.readFileSync(path.join(srcDir, name), 'utf8').trim(), 'base64');
    fs.writeFileSync(path.join(outDir, target), buf);
    // The share/OG image is the same 512px artwork.
    if (target === 'icon-512.png') fs.writeFileSync(path.join(outDir, 'logo-512.png'), buf);
    console.log(`[gen-icons] wrote public/${target} (${buf.length} bytes)`);
  }
} catch (e) {
  console.warn('[gen-icons] WARNING: could not materialise icons:', e && e.message ? e.message : e);
}
