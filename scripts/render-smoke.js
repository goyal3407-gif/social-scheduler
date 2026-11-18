#!/usr/bin/env node
// Render smoke test: actually EXECUTES the built frontend bundle in jsdom
// and asserts the app renders. This exists because the 2026-11-18 UX pack 2
// build passed every API/unit suite while shipping a bundle that rendered
// a blank white page (a TDZ ReferenceError in App.jsx: `visiblePosts` was
// referenced by a useCallback above its const declaration). API tests
// cannot catch a first-render crash; this test can.
//
// Usage:
//   node scripts/render-smoke.js [bundleDir]
// bundleDir defaults to frontend/dist (run `npm --prefix frontend run build`
// first). jsdom must be resolvable: it is looked up in the repo root
// node_modules, then frontend/node_modules, then /tmp/jsdomtest/node_modules,
// then $RENDER_SMOKE_JSDOM (a path to a jsdom module). If it is missing the
// test exits 2 with instructions (`npm i --no-save jsdom` at the repo root).
//
// Scenarios (each in a fresh child process, fresh module registry):
//   A logged-out: /api/auth/me -> 401; the login form must render.
//   B logged-in:  stubbed API with seeded posts; the dashboard must render,
//                 then the Queue tab must render with scheduled posts first
//                 (soonest at top), other statuses below, newest first.
//   C update guard: like B, but /build-id.json + /api/version report a
//                 DIFFERENT build id than the bundle's own — the "new
//                 version available" banner must render. (In A/B the
//                 stub reports the bundle's real build id, read from
//                 dist/build-id.json, and no banner may appear.)
// Any ReferenceError/TypeError reaching console.error, an unhandled
// rejection, or an empty #root fails the test.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO = path.join(__dirname, '..')

function loadJsdom() {
  const candidates = [
    path.join(REPO, 'node_modules', 'jsdom'),
    path.join(REPO, 'frontend', 'node_modules', 'jsdom'),
    '/tmp/jsdomtest/node_modules/jsdom',
    process.env.RENDER_SMOKE_JSDOM || '',
  ].filter(Boolean)
  for (const c of candidates) {
    try { return require(c) } catch { /* try next */ }
  }
  return null
}

function entryFile(bundleDir) {
  const html = fs.readFileSync(path.join(bundleDir, 'index.html'), 'utf8')
  const m = html.match(/src="(\/assets\/index-[^"]+\.js)"/)
  if (!m) throw new Error('no module entry found in ' + path.join(bundleDir, 'index.html'))
  return path.join(bundleDir, m[1])
}

// ---------------------------------------------------------------- child run
async function runScenario(scenario, bundleDir) {
  const jsdomPkg = loadJsdom()
  if (!jsdomPkg) {
    console.error('render-smoke: jsdom not found. Install it with: npm i --no-save jsdom (repo root)')
    process.exit(2)
  }
  const { JSDOM } = jsdomPkg
  const entry = entryFile(bundleDir)

  const errors = []
  const origError = console.error
  console.error = (...a) => {
    const s = a.map((x) => (x && x.stack) || String(x)).join(' ')
    if (/ReferenceError|TypeError|Cannot access .* before initialization/.test(s)) errors.push(s.slice(0, 400))
    origError(...a)
  }
  process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + ((e && e.stack) || e)))

  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://social-scheduler-one-sandy.vercel.app/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  global.window = window
  global.document = window.document
  Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true })
  global.location = window.location
  global.history = window.history
  global.localStorage = window.localStorage
  global.sessionStorage = window.sessionStorage
  global.HTMLElement = window.HTMLElement
  global.HTMLInputElement = window.HTMLInputElement
  global.Element = window.Element
  global.Node = window.Node
  global.Event = window.Event
  global.CustomEvent = window.CustomEvent
  global.MouseEvent = window.MouseEvent
  global.KeyboardEvent = window.KeyboardEvent
  global.getComputedStyle = window.getComputedStyle.bind(window)
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16)
  global.cancelAnimationFrame = (id) => clearTimeout(id)
  global.MutationObserver = window.MutationObserver
  global.DOMParser = window.DOMParser
  global.XMLSerializer = window.XMLSerializer
  global.FileReader = window.FileReader
  global.File = window.File
  global.Blob = window.Blob
  global.FormData = window.FormData
  window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  global.matchMedia = window.matchMedia
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
  global.IntersectionObserver = window.IntersectionObserver
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  global.ResizeObserver = window.ResizeObserver
  window.scrollTo = () => {}
  window.open = () => null
  window.URL.createObjectURL = () => 'blob:stub'
  window.URL.revokeObjectURL = () => {}

  const now = Date.now()
  const iso = (ms) => new Date(ms).toISOString()
  const post = (id, caption, status, t, extra = {}) => ({
    id, caption, status, scheduleTime: iso(t), createdAt: iso(t - 86400000),
    platform: 'Instagram', format: 'REELS', mediaType: 'video', mediaUrl: '', posterUrl: '',
    hashtags: '', cta: '', ...extra,
  })
  const seeded = [
    post('p-sch-late', 'SCH LATE', 'scheduled', now + 3 * 86400000),
    post('p-pub', 'PUB OLD', 'published', now - 86400000, { liveUrl: 'https://instagram.com/p/smoke' }),
    post('p-sch-soon', 'SCH SOON', 'scheduled', now + 3600000),
    post('p-fail', 'FAIL NEW', 'failed', now - 7200000),
  ]
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const ownBuildId = process.env.SMOKE_BUILD_ID || ''
  global.fetch = async (url) => {
    const p = new URL(String(url), 'https://smoke.local').pathname
    if (scenario === 'A') return json(401, { error: 'Not signed in' })
    switch (p) {
      case '/build-id.json': return json(200, { buildId: scenario === 'C' ? 'a-different-build-id' : ownBuildId })
      case '/api/version': return json(200, { ok: true, buildId: scenario === 'C' ? 'a-different-build-id' : ownBuildId })
      case '/api/auth/me': return json(200, { user: { id: 'u-smoke', email: 'smoke@test.local', name: 'Smoke' } })
      case '/api/posts': return json(200, seeded)
      case '/api/media': return json(200, [])
      case '/api/templates': return json(200, [])
      case '/api/settings': return json(200, { instagramAccounts: [], defaultIgUserId: '', checklistDismissed: true, setupDone: true })
      case '/api/stats': return json(200, { scheduled: 2, published: 1, failed: 1, drafts: 0, mediaCount: 0 })
      case '/api/db-status': return json(200, { ok: true, db: 'mongodb', instagram: { connected: false } })
      case '/api/notifications': return json(200, { notifications: [], unread: 0 })
      case '/api/hashtag-groups': return json(200, [])
      default: return json(200, {})
    }
  }

  const fail = (msg) => { console.log(`render-smoke scenario ${scenario}: FAIL - ${msg}`); process.exit(1) }
  const waitFor = async (fn, what, timeout = 20000) => {
    const start = Date.now()
    for (;;) {
      const v = fn()
      if (v) return v
      if (errors.length) fail('render error: ' + errors[0])
      if (Date.now() - start > timeout) fail('timeout waiting for ' + what)
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  try {
    await import('file://' + entry)
  } catch (e) {
    fail('bundle import threw: ' + ((e && e.stack) || e))
  }

  const root = window.document.getElementById('root')
  if (scenario === 'A') {
    await waitFor(
      () => root.innerHTML.length > 0 && window.document.querySelector('input[type="password"]'),
      'login form to render'
    )
    console.log('render-smoke scenario A: PASS (login form renders, #root ' + root.innerHTML.length + ' bytes)')
  } else if (scenario === 'B') {
    await waitFor(() => root.innerHTML.length > 0, 'app shell to render')
    // A fresh account lands on the setup wizard first; skip through to the
    // dashboard like a real user would.
    const skip = [...window.document.querySelectorAll('button, a')].find((el) => el.textContent.trim() === 'Skip setup')
    if (skip) skip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(
      () => root.textContent.includes('Scheduled'),
      'dashboard to render'
    )
    // Navigate to Queue (lazy chunk) and check ordering.
    const navBtn = await waitFor(() => {
      const els = [...window.document.querySelectorAll('button, a')]
      return els.find((el) => el.textContent.trim() === 'Queue')
    }, 'Queue nav control')
    navBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    // Wait for the Queue section itself (its header copy) plus a seeded
    // caption: the dashboard also contains the captions, so a caption-only
    // check can pass on the pre-click dashboard and measure the wrong page.
    await waitFor(
      () => root.textContent.includes("Everything you've planned") && root.textContent.includes('SCH SOON'),
      'queue list to render'
    )
    await new Promise((r) => setTimeout(r, 300))
    const text = root.textContent
    const idx = (s) => text.indexOf(s)
    if (!(idx('SCH SOON') > -1 && idx('SCH SOON') < idx('SCH LATE'))) fail('scheduled posts not soonest-first in Queue')
    if (!(idx('SCH LATE') < idx('FAIL NEW'))) fail('non-scheduled posts not below scheduled in Queue')
    if (!(idx('FAIL NEW') < idx('PUB OLD'))) fail('non-scheduled group not newest-first in Queue')
    // Visit the other pack-2-touched lazy views too: a render crash in any
    // of them unmounts the whole app (there is no error boundary).
    for (const [tab, marker] of [['Calendar', 'posts in total'], ['Media', 'Media Library']]) {
      const btn = await waitFor(() => {
        const els = [...window.document.querySelectorAll('button, a')]
        return els.find((el) => el.textContent.trim() === tab)
      }, tab + ' nav control')
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
      await waitFor(() => root.textContent.includes(marker), tab + ' view to render')
    }
    console.log('render-smoke scenario B: PASS (dashboard + queue + calendar + media render, scheduled-first order holds)')
  } else if (scenario === 'C') {
    await waitFor(() => root.innerHTML.length > 0, 'app shell to render')
    const skip = [...window.document.querySelectorAll('button, a')].find((el) => el.textContent.trim() === 'Skip setup')
    if (skip) skip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(
      () => root.textContent.includes('new version of KiluaAI is available'),
      'update guard banner to render on build-id mismatch'
    )
    console.log('render-smoke scenario C: PASS (update guard banner renders when the deployment build differs)')
  }
  if (errors.length) fail('render errors captured: ' + errors[0])
  process.exit(0)
}

// ------------------------------------------------------------------- parent
if (process.argv[2] === '--run') {
  runScenario(process.argv[3], path.resolve(process.argv[4])).catch((e) => {
    console.log('render-smoke: FAIL - harness error: ' + ((e && e.stack) || e))
    process.exit(1)
  })
} else {
  const bundleDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO, 'frontend', 'dist')
  if (!fs.existsSync(path.join(bundleDir, 'index.html'))) {
    console.error('render-smoke: no build found at ' + bundleDir + ' — run: npm --prefix frontend run build')
    process.exit(2)
  }
  // The bundle's own build id (written next to it by the build) is what
  // scenarios A/B report back as "current", so the update guard stays
  // quiet there; scenario C overrides it with a different id.
  let smokeBuildId = ''
  try { smokeBuildId = JSON.parse(fs.readFileSync(path.join(bundleDir, 'build-id.json'), 'utf8')).buildId || '' } catch { /* older bundle: guard stays quiet via the empty id */ }
  let failed = false
  for (const s of ['A', 'B', 'C']) {
    const r = spawnSync(process.execPath, [__filename, '--run', s, bundleDir], { stdio: 'inherit', env: { ...process.env, SMOKE_BUILD_ID: smokeBuildId } })
    if (r.status !== 0) failed = true
  }
  console.log(failed ? 'render-smoke: FAIL' : 'render-smoke: PASS')
  process.exit(failed ? 1 : 0)
}
