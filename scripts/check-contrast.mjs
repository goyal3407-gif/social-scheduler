// check-contrast.mjs — Round 3 (B1) gate: WCAG contrast for every
// text/fill token pair in frontend/src/index.css, both themes.
// Text pairs must be >= 4.5:1, non-text (focus/brand indicators)
// >= 3.0:1. Prints a table of every pair + ratio + PASS/FAIL and
// the minimum per theme; exits 1 if any pair fails.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'frontend', 'src', 'index.css'), 'utf8')

function block(re) {
  const m = css.match(re)
  if (!m) throw new Error(`check-contrast: token block not found: ${re}`)
  return m[1]
}
function tokens(blockText) {
  const out = {}
  for (const m of blockText.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim()
  return out
}
const light = tokens(block(/:root\{([^}]+)\}/))
const dark = { ...light, ...tokens(block(/\[data-theme="dark"\]\{([^}]+)\}/)) }

function luminance(hex) {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`check-contrast: not a hex colour: ${hex}`)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function ratio(fgHex, bgHex) {
  const a = luminance(fgHex); const b = luminance(bgHex)
  const [hi, lo] = a >= b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const TEXT_TOKENS = ['--ink', '--ink-2', '--muted', '--brand-text', '--gold-text', '--green-text', '--amber-text', '--red-text', '--blue-text']
const SURFACES = ['--bg', '--surface', '--surface-2', '--surface-3']
const SOFT_PAIRS = [['--brand-text', '--brand-soft'], ['--gold-text', '--gold-soft'], ['--green-text', '--green-soft'], ['--amber-text', '--amber-soft'], ['--red-text', '--red-soft'], ['--blue-text', '--blue-soft']]
const NON_TEXT = ['--focus', '--brand']
const NON_TEXT_SURFACES = ['--bg', '--surface']

let failures = 0
const mins = {}
function check(themeName, theme, fgLabel, fgHex, bgLabel, bgHex, threshold) {
  const r = ratio(fgHex, bgHex)
  const ok = r >= threshold
  if (!ok) failures++
  if (mins[themeName] === undefined || r < mins[themeName]) mins[themeName] = r
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${themeName.padEnd(5)}  ${fgLabel} on ${bgLabel}  ${r.toFixed(2)}:1  (>= ${threshold.toFixed(1)})`)
}
for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
  for (const t of TEXT_TOKENS) for (const s of SURFACES) check(themeName, theme, t, theme[t], s, theme[s], 4.5)
  for (const [t, s] of SOFT_PAIRS) check(themeName, theme, t, theme[t], s, theme[s], 4.5)
  for (const fill of ['--brand-btn', '--red-btn']) check(themeName, theme, '#ffffff', '#ffffff', fill, theme[fill], 4.5)
  if (themeName === 'light') check(themeName, theme, '#ffffff', '#ffffff', '--brand', theme['--brand'], 4.5)
  check(themeName, theme, '--on-deep', theme['--on-deep'], '--deep', theme['--deep'], 4.5)
  for (const t of NON_TEXT) for (const s of NON_TEXT_SURFACES) check(themeName, theme, t, theme[t], s, theme[s], 3.0)
}
console.log(`\nMinimum ratio — light: ${mins.light.toFixed(2)}:1, dark: ${mins.dark.toFixed(2)}:1`)
if (failures) { console.log(`check-contrast: ${failures} pair(s) FAILED`); process.exit(1) }
console.log('check-contrast: all pairs PASS')
