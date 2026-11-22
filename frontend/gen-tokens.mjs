// gen-tokens.mjs — thin shim (Round 3, B1). The real generator now
// lives at scripts/build-tokens.mjs (repo root); this file only
// delegates to it so the existing build wiring (`node gen-tokens.mjs`
// in frontend/package.json) keeps working unchanged.
import '../scripts/build-tokens.mjs'
