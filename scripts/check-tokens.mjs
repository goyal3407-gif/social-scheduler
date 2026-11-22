// check-tokens.mjs — Round 3 (B1) gate for frontend/src/index.css:
//   (a) no hex colour literals outside the :root / [data-theme="dark"]
//       token blocks,
//   (b) no font-size value outside {12,14,16,18,22,28}px
//       (0, inherit/keyword sizes and var() references are ignored),
//   (c) border-radius declarations use only var(--r-*) / 50% / 0.
// Any index.css violation exits 1. Raw-hex counts in
// frontend/src/**/*.jsx|js are reported as WARN only (later batches
// migrate those); they never fail this gate.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const frontendDir = join(here, '..', 'frontend')
const cssPath = join(frontendDir, 'src', 'index.css')
const raw = readFileSync(cssPath, 'utf8')
// Strip comments so prose can mention colours/tokens freely.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

const violations = []
// Remove the two token blocks; everything left is "outside".
let outside = css.replace(/:root\{[^}]+\}/, '')
outside = outside.replace(/\[data-theme="dark"\]\{[^}]+\}/, '')

// (a) hex literals outside token blocks
for (const m of outside.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
  violations.push(`(a) hex colour literal outside token blocks: ${m[0]}`)
}
// (b) font-size scale
const ALLOWED = new Set([12, 14, 16, 18, 22, 28])
for (const m of css.matchAll(/font-size:\s*([^;}]+)/g)) {
  const v = m[1].trim()
  if (v === '0' || v.startsWith('var(') || !/px/.test(v)) continue
  const px = v.match(/(\d+(?:\.\d+)?)px/)
  if (px && !ALLOWED.has(Number(px[1]))) violations.push(`(b) off-scale font-size: ${v}`)
  if (!px) violations.push(`(b) unparseable font-size: ${v}`)
}
// (c) border-radius components
for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) {
  for (const part of m[1].trim().split(/\s+/)) {
    if (part === '50%' || part === '0' || /^var\(--r-[a-z]+\)$/.test(part)) continue
    violations.push(`(c) border-radius component not a radius token: "${part}" in "${m[1].trim()}"`)
  }
}

// WARN-only: raw hex counts in JSX/JS sources
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p)
  }
  return out
}
let jsxHexTotal = 0
for (const f of walk(join(frontendDir, 'src'))) {
  const n = (readFileSync(f, 'utf8').match(/#[0-9a-fA-F]{3,8}\b/g) || []).length
  if (n) { jsxHexTotal += n; console.log(`WARN  ${f.replace(frontendDir + '/', '')}: ${n} raw hex literal(s)`) }
}
console.log(`WARN  frontend/src/**/*.jsx|js raw hex total: ${jsxHexTotal} (warn-only, later batches)`)

if (violations.length) {
  for (const v of violations) console.log(`FAIL  ${v}`)
  console.log(`check-tokens: ${violations.length} violation(s) in index.css`)
  process.exit(1)
}
console.log('check-tokens: index.css PASS (no hex outside token blocks, font sizes on scale, radii tokenised)')
