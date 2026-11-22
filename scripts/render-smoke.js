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
//   A logged-out: /api/auth/me -> 401; the public landing page (Phase F)
//                 must render AROUND the login form — hero line, feature
//                 grid and the Privacy/Terms footer links — and the login
//                 form itself must still render and be reachable.
//   B logged-in:  stubbed API with seeded posts; the dashboard must render,
//                 then the Queue tab must render with scheduled posts first
//                 (soonest at top), other statuses below, newest first, and
//                 status trackers naming the platform(s) each post used
//                 (YouTube-only / Instagram-only / both). B also asserts
//                 the Studio YouTube visibility selector pre-filling
//                 from the saved default + Made for Kids defaulting to
//                 No (Phase E), and the header structure (brand block / nav / actions as
//                 separate ordered children; mobile search icon button +
//                 expandable row — the 2026-11-18 overlap fix).
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
    // Platform-wording regression seeds (older than PUB OLD so the
    // newest-first ordering assertions above are untouched): a
    // YouTube-only published post must read "live on YouTube" with no
    // Instagram wording and no "also" side note; a both-platforms post
    // keeps the Instagram main line plus an "also on YouTube" note.
    post('p-both-pub', 'BOTH PUB', 'published', now - 2 * 86400000, {
      liveUrl: 'https://instagram.com/p/both',
      youtube: { enabled: true, title: 'BOTH PUB' }, youtubeVideoId: 'bothVid1', youtubeStatus: 'uploaded',
    }),
    post('p-yt-pub', 'YT ONLY PUB', 'published', now - 3 * 86400000, {
      igEnabled: false,
      liveUrl: 'https://www.youtube.com/watch?v=ytOnlyVid1',
      youtube: { enabled: true, title: 'YT ONLY PUB' }, youtubeVideoId: 'ytOnlyVid1', youtubeStatus: 'uploaded',
    }),
    // Multi-target seed (oldest of all, so the ordering assertions
    // above stay untouched): live on one ticked account, failed on
    // the other with its auto-retry armed — the row must read
    // "Partial" and name both accounts.
    post('p-partial', 'PARTIAL POST', 'partial', now - 4 * 86400000, {
      liveUrl: 'https://instagram.com/p/partial1',
      igTargets: [
        { igUserId: '111', username: 'smokeone', status: 'published', liveUrl: 'https://instagram.com/p/partial1', error: '' },
        { igUserId: '222', username: 'smoketwo', status: 'failed', liveUrl: '', error: 'stub failure', retryPending: true, retryAt: iso(now + 900000) },
      ],
    }),
  ]
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const ownBuildId = process.env.SMOKE_BUILD_ID || ''
  global.fetch = async (url) => {
    const p = new URL(String(url), 'https://smoke.local').pathname
    if (scenario === 'A') return json(401, { error: 'Not signed in' })
    switch (p) {
      case '/build-id.json': return json(200, { buildId: scenario === 'C' ? 'a-different-build-id' : ownBuildId })
      case '/api/version': return json(200, { ok: true, buildId: scenario === 'C' ? 'a-different-build-id' : ownBuildId })
      case '/api/auth/me': return json(200, { user: scenario === 'D'
        ? { id: 'u-smoke', email: 'smoke@test.local', name: 'Smoke', isOwner: true, adminUrl: '/api/smoke-admin/console' }
        : { id: 'u-smoke', email: 'smoke@test.local', name: 'Smoke' } })
      case '/api/posts': return json(200, seeded)
      case '/api/media': return json(200, [])
      case '/api/templates': return json(200, [])
      case '/api/settings': return json(200, { instagramAccounts: [{ igUserId: '111', username: 'smokeone', isDefault: true }, { igUserId: '222', username: 'smoketwo', isDefault: false }], defaultIgUserId: '111', checklistDismissed: true, setupDone: true, ytDefaultVisibility: 'unlisted' })
      case '/api/stats': return json(200, { scheduled: 2, published: 1, failed: 1, drafts: 0, mediaCount: 0 })
      case '/api/db-status': return json(200, { ok: true, db: 'mongodb', instagram: { connected: false } })
      case '/api/notifications': return json(200, { notifications: [], unread: 0 })
      case '/api/hashtag-groups': return json(200, [])
      case '/api/youtube/status': return json(200, { ok: true, configured: true, connected: true, channelId: 'chan-smoke', channelTitle: 'Smoke Channel', channelThumb: '' })
      case '/api/my-stats': return json(200, { ok: true, stats: { published: 3, failed: 1, partial: 0, successRate: 75, publishedThisMonth: 2, scheduled: 2, drafts: 0, total: 6, perAccount: [{ account: '@smokeone', published: 3, failed: 1 }] }, note: 'Basic stats from KiluaAI records.' })
      case '/api/plan/usage': return json(200, { ok: true, plan: { plan: 'free', planName: 'Free', basePlan: 'free', comp: false, planExpiresAt: '', limits: { accounts: 2, igAccounts: 1, postsPerDay: 2, postsPerMonth: 30 } }, ai: { perDay: 5, usedToday: 0, remaining: 5 }, pricing: { current: 'free', currentName: 'Free', currentPriceInr: 0, prices: { free: 0, pro: 249, max: 499, ultra: 999 }, options: [
        { plan: 'free', name: 'Free', priceInr: 0, kind: 'current', chargeInr: 0, limits: { accounts: 2, igAccounts: 1, postsPerDay: 2, postsPerMonth: 30 }, fullBridge: false, aiPerDay: 5 },
        { plan: 'pro', name: 'Pro', priceInr: 249, kind: 'upgrade', chargeInr: 249, limits: { accounts: 3, igAccounts: 3, postsPerDay: null, postsPerMonth: 100 }, fullBridge: false, aiPerDay: 25 },
        { plan: 'max', name: 'Max', priceInr: 499, kind: 'upgrade', chargeInr: 499, limits: { accounts: 10, igAccounts: 10, postsPerDay: null, postsPerMonth: null }, fullBridge: true, aiPerDay: 100 },
        { plan: 'ultra', name: 'Ultra', priceInr: 999, kind: 'upgrade', chargeInr: 999, limits: { accounts: null, igAccounts: null, postsPerDay: null, postsPerMonth: null }, fullBridge: true, aiPerDay: null },
      ] }, usage: { postsToday: 0, postsThisMonth: 0, instagramConnected: 2, youtubeConnected: true, accountsConnected: 3 } })
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
    // Login split (Prompt-4): the logged-out root is the public
    // landing page (marketing only) — Google's OAuth reviewer must
    // be able to read what the app does without an account. Assert
    // the hero line, a feature-grid entry, the How-it-works steps
    // and the footer legal links, then follow the Log in button to
    // the form on its own screen (with the OAuth trust line).
    await waitFor(
      () => root.innerHTML.length > 0 && root.textContent.includes('Instagram scheduler for Reels, Posts and Stories'),
      'landing page to render'
    )
    const txt = root.textContent
    if (!txt.includes('Instagram scheduler for Reels, Posts and Stories')) fail('landing hero line missing on the logged-out page')
    if (!txt.includes('YouTube cross-posting')) fail('landing hero YouTube mention missing')
    if (!txt.includes('Bulk scheduling')) fail('landing feature grid missing (no "Bulk scheduling" card)')
    if (!txt.includes('How it works') || !txt.includes('Connect Instagram')) fail('landing How-it-works steps missing')
    if (!window.document.querySelector('a[href="/privacy.html"]')) fail('landing footer Privacy Policy link missing')
    if (!window.document.querySelector('a[href="/terms.html"]')) fail('landing footer Terms of Service link missing')
    if (!window.document.querySelector('a[href="/contact.html"]')) fail('landing footer Contact link missing')
    if (window.document.querySelector('input[type="password"]')) fail('login form must NOT be embedded in the landing (split)')
    const loginBtn = [...window.document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Log in')
    if (!loginBtn) fail('landing Log in button missing')
    loginBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(
      () => window.document.querySelector('input[type="password"]'),
      'login form to render after the Log in click'
    )
    if (!root.textContent.includes('Secure login via official OAuth')) fail('auth screen OAuth trust line missing')
    console.log('render-smoke scenario A: PASS (landing page renders, Log in opens the form screen, #root ' + root.innerHTML.length + ' bytes)')
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
    // Batch 5 dedupe: the old Home search pill is GONE — search lives
    // only behind the header search icon (one search control total).
    if (window.document.querySelector('.home-search')) {
      throw new Error('duplicate home search pill still renders (batch 5 dedupe)')
    }
    // Exactly ONE "Create Post" button on the dashboard (batch 5).
    const createBtns = [...window.document.querySelectorAll('button')].filter((el) => el.textContent.trim() === 'Create Post')
    if (createBtns.length !== 1) throw new Error('expected exactly 1 Create Post button on Home, found ' + createBtns.length)
    // Header structure (2026-11-18 overlap fix). jsdom does no layout,
    // so overlap is asserted structurally: the brand block, the desktop
    // nav and the actions must be SEPARATE children of .topbar-in, in
    // that order — the old bug was the logo flex item shrinking to
    // min-width:0 so the nav painted over the wordmark (the CSS now
    // pins .logo{flex:none} and lets .topnav scroll). Batch 5: the
    // header carries NO inline search form at any width (search is one
    // icon-toggled row), and the header must carry the compact search
    // ICON button in the actions row — NOT an always-visible wide pill
    // (the old mobile bar rendered the desktop form next to the logo,
    // truncating + overlapping it).
    const topbarIn = window.document.querySelector('.topbar-in')
    if (!topbarIn) fail('topbar row missing')
    const kids = [...topbarIn.children]
    const logoEl = kids.find((el) => el.classList.contains('logo'))
    const navEl = kids.find((el) => el.classList.contains('topnav'))
    const actionsEl = kids.find((el) => el.classList.contains('top-actions'))
    if (!logoEl || !navEl || !actionsEl) fail('header row is missing the brand block, desktop nav or actions')
    if (!(kids.indexOf(logoEl) < kids.indexOf(navEl) && kids.indexOf(navEl) < kids.indexOf(actionsEl))) {
      fail('header order is not brand block, nav, actions')
    }
    if (logoEl.contains(navEl) || navEl.contains(logoEl)) fail('brand block and nav are nested (overlap family)')
    if (topbarIn.querySelector('form.topnav-search')) fail('inline header search form still renders (batch 5 dedupe)')
    const searchToggle = actionsEl.querySelector('.search-toggle-btn')
    if (!searchToggle) fail('mobile search icon button missing from the header actions')
    if (window.document.querySelector('.mobile-search-row')) fail('mobile search row is expanded before the icon is tapped')
    // Expand: a slim row appears under the header with the full
    // placeholder visible; close returns to the icon state.
    searchToggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const mInput = await waitFor(
      () => window.document.querySelector('.mobile-search-row input[type="search"]'),
      'mobile search row to expand'
    )
    if (mInput.getAttribute('placeholder') !== 'Search posts & media…') {
      fail('mobile search row placeholder wrong: ' + mInput.getAttribute('placeholder'))
    }
    const closeBtn = window.document.querySelector('.mobile-search-row .mobile-search-close')
    if (!closeBtn) fail('mobile search row has no close button')
    closeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => !window.document.querySelector('.mobile-search-row'), 'mobile search row to close')
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
    // Status tracker platform wording: the tracker line must name the
    // platform(s) the post actually used (regression: a YouTube-only
    // post used to read "live on Instagram" + "YouTube: also posting").
    const trackerOf = (caption) => {
      const row = [...window.document.querySelectorAll('.post-row')].find((r) => r.textContent.includes(caption))
      return row ? row.querySelector('.post-tracker') : null
    }
    const ytTrk = trackerOf('YT ONLY PUB')
    if (!ytTrk) fail('no status tracker rendered for the YouTube-only post')
    if (!ytTrk.textContent.includes('View on YouTube')) fail('YouTube-only tracker does not say "View on YouTube"')
    if (ytTrk.textContent.includes('Instagram')) fail('YouTube-only tracker still mentions Instagram: ' + ytTrk.textContent)
    if (ytTrk.textContent.includes('also')) fail('YouTube-only tracker still has an "also" side note: ' + ytTrk.textContent)
    if (!String(ytTrk.getAttribute('aria-label') || '').includes('live on YouTube')) fail('YouTube-only tracker aria-label is not "live on YouTube"')
    const ytLink = ytTrk.querySelector('a.trk-live')
    if (!ytLink || !String(ytLink.getAttribute('href') || '').includes('youtube.com/watch')) fail('YouTube-only tracker link does not point at the watch URL')
    const bothTrk = trackerOf('BOTH PUB')
    if (!bothTrk) fail('no status tracker rendered for the both-platforms post')
    if (!bothTrk.textContent.includes('View on Instagram')) fail('both-platforms tracker lost "View on Instagram"')
    if (!bothTrk.textContent.includes('also on YouTube')) fail('both-platforms tracker missing the "also on YouTube" note: ' + bothTrk.textContent)
    const igTrk = trackerOf('PUB OLD')
    if (!igTrk) fail('no status tracker rendered for the Instagram-only post')
    if (!igTrk.textContent.includes('View on Instagram')) fail('Instagram-only tracker lost "View on Instagram"')
    if (igTrk.textContent.includes('YouTube')) fail('Instagram-only tracker mentions YouTube: ' + igTrk.textContent)
    // Multi-target partial row: the badge reads "partial", the
    // tracker names the live and the failed account, and the
    // per-account chips show ✓ / ✗.
    const partRow = [...window.document.querySelectorAll('.post-row')].find((r) => r.textContent.includes('PARTIAL POST'))
    if (!partRow) fail('partial multi-target post row missing')
    // Batch 5: the badge now shows the translated status label
    // ("Partial") instead of the old raw lowercase status string.
    if (!partRow.textContent.includes('Partial')) fail('partial post badge does not read "Partial": ' + partRow.textContent.slice(0, 200))
    const partTrk = partRow.querySelector('.post-tracker')
    if (!partTrk) fail('no status tracker rendered for the partial post')
    if (!partTrk.textContent.includes('Partial')) fail('partial tracker does not say "Partial": ' + partTrk.textContent)
    if (!partTrk.textContent.includes('@smokeone') || !partTrk.textContent.includes('@smoketwo')) fail('partial tracker does not name both accounts: ' + partTrk.textContent)
    if (!partRow.textContent.includes('@smokeone ✓')) fail('partial row missing the live account chip: ' + partRow.textContent.slice(0, 300))
    if (!partRow.textContent.includes('@smoketwo ✗')) fail('partial row missing the failed account chip: ' + partRow.textContent.slice(0, 300))
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
    // Connections page (Phase B addition): Instagram + YouTube cards must
    // render. Round 3 B7b (spec Addendum §4): the disabled Facebook/TikTok
    // "Coming soon" placeholder cards are gone, replaced by the single
    // "More platforms later" line — that line is waited for instead.
    const connBtn = await waitFor(() => {
      const els = [...window.document.querySelectorAll('button, a')]
      return els.find((el) => el.textContent.trim() === 'Connections')
    }, 'Connections nav control')
    connBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(
      () => root.textContent.includes('Link the accounts KiluaAI publishes to') && root.textContent.includes('Smoke Channel') && root.textContent.includes('More platforms later'),
      'connections page to render (Instagram + YouTube + More platforms later line)'
    )
    // Studio (Create): with a YouTube channel connected (stub), Step 3
    // must show the platform picker — Instagram + YouTube ticks.
    // Batch 5: the header's duplicate "Create Post" button is gone —
    // the nav "Create" tab is the one create entry from other tabs.
    const createBtn = await waitFor(() => {
      const els = [...window.document.querySelectorAll('button, a')]
      return els.find((el) => el.textContent.trim() === 'Create')
    }, 'Create nav control')
    createBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => root.textContent.includes('Step 1'), 'studio to render')
    const step3 = [...window.document.querySelectorAll('button')].find((el) => el.textContent.includes('Schedule & publish'))
    if (step3) step3.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => root.textContent.includes('Publish to') && root.textContent.includes('Smoke Channel'), 'studio platform picker to render')
    // Multi-target picker: Step 3 lists every connected Instagram
    // account BY NAME with a tick box (no single-account dropdown),
    // and the default account starts ticked for a new post.
    if (window.document.querySelector('#igAccount')) fail('the old single-account dropdown is still in Studio Step 3')
    const tickRow = (name) => [...window.document.querySelectorAll('label')].find((el) => el.textContent.includes(name) && el.querySelector('input[type="checkbox"]'))
    const rowOne = tickRow('@smokeone')
    const rowTwo = tickRow('@smoketwo')
    if (!rowOne || !rowTwo) fail('Studio Step 3 does not list both connected accounts as tick rows')
    if (!rowOne.querySelector('input[type="checkbox"]').checked) fail('default account is not pre-ticked for a new post')
    if (rowTwo.querySelector('input[type="checkbox"]').checked) fail('non-default account is ticked by default')
    if (!rowOne.textContent.includes('(default)')) fail('default account row is not marked (default)')
    // Phase E: ticking YouTube must reveal the visibility selector
    // PRE-FILLED from the user's saved default (the settings stub
    // returns ytDefaultVisibility 'unlisted'), the Made for Kids
    // Yes/No control defaulting to No, and the honest audit note.
    const ytTick = [...window.document.querySelectorAll('label')].find((el) => el.textContent.includes('YouTube') && el.querySelector('input[type="checkbox"]'))
    if (!ytTick) fail('YouTube platform tick label missing in Studio Step 3')
    ytTick.querySelector('input[type="checkbox"]').click()
    const visSel = await waitFor(() => window.document.querySelector('#ytVisibility'), 'YouTube visibility selector to appear')
    if (visSel.value !== 'unlisted') fail('visibility selector not pre-filled from the saved default (got "' + visSel.value + '", want "unlisted")')
    const kidsRadios = [...window.document.querySelectorAll('input[name="ytMadeForKids"]')]
    if (kidsRadios.length !== 2) fail('Made for Kids Yes/No radios missing')
    if (!kidsRadios[0].checked || kidsRadios[1].checked) fail('Made for Kids does not default to No')
    if (!root.textContent.includes('takes effect automatically once the approval passes')) fail('honest audit note missing next to the visibility selector')
    // Batch 4: back Home — the Dashboard must now be the compact
    // glance (plan card, daily-plan table, 14-day chart, up-next /
    // recent lists and how-it-works all moved out to their own tabs),
    // and Pricing must be its own tab carrying the current plan, the
    // comparison and the usage-based best-for-you marker.
    const homeBtn = await waitFor(() => {
      const els = [...window.document.querySelectorAll('button, a')]
      return els.find((el) => el.textContent.trim() === 'Home')
    }, 'Home nav control')
    homeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => root.textContent.includes('Today at a glance'), 'compact dashboard glance to render')
    const dashTxt = root.textContent
    if (dashTxt.includes('Daily plan — today')) fail('daily-plan table still on the dashboard')
    if (dashTxt.includes('Last 14 days')) fail('14-day chart still on the dashboard')
    if (dashTxt.includes('My Plan —')) fail('My Plan card still on the dashboard')
    if (dashTxt.includes('How it works')) fail('how-it-works section still on the dashboard')
    if (dashTxt.includes('Recent activity')) fail('recent-activity list still on the dashboard')
    if (!dashTxt.includes('Needs attention')) fail('glance problems tile missing on the dashboard')
    if (!dashTxt.includes('YouTube ·')) fail('connection strip YouTube chip missing on the dashboard')
    const pricingBtn = await waitFor(() => {
      const els = [...window.document.querySelectorAll('button, a')]
      return els.find((el) => el.textContent.trim() === 'Pricing')
    }, 'Pricing nav control')
    pricingBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => root.textContent.includes('My plan') && root.textContent.includes('₹499') && root.textContent.includes('Your numbers'), 'pricing tab + stats card to render')
    const priceTxt = root.textContent
    if (!priceTxt.includes('Most popular')) fail('Max is not marked most popular on the Pricing tab')
    if (!priceTxt.includes('Best for you')) fail('best-for-you marker missing on the Pricing tab (seeded usage is over the Free account limit, so a recommendation must show)')
    if (!priceTxt.includes('Your numbers')) fail('stats card missing from the Pricing tab')
    if (!priceTxt.includes('Current plan')) fail('current-plan marker missing on the Pricing tab')
    // Batch 6 (owner's final model): a NON-owner account must never
    // see the "Switch to Admin" entry — no flag on /me, no menu item.
    const avatarBtnB = window.document.querySelector('.avatar-btn')
    if (!avatarBtnB) fail('account (avatar) button missing')
    avatarBtnB.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => window.document.querySelector('.avatar-menu'), 'account menu to open')
    if ([...window.document.querySelectorAll('.avatar-menu a, .avatar-menu button')].some((el) => el.textContent.includes('Switch to Admin'))) fail('Switch to Admin renders for a non-owner account')
    console.log('render-smoke scenario B: PASS (dashboard + queue + calendar + media + connections + studio render, scheduled-first order holds, tracker platform wording correct, YouTube visibility pre-fills from the saved default, compact glance + pricing tab render, no admin entry for a non-owner)')
  } else if (scenario === 'C') {
    await waitFor(() => root.innerHTML.length > 0, 'app shell to render')
    const skip = [...window.document.querySelectorAll('button, a')].find((el) => el.textContent.trim() === 'Skip setup')
    if (skip) skip.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(
      () => root.textContent.includes('new version of KiluaAI is available'),
      'update guard banner to render on build-id mismatch'
    )
    console.log('render-smoke scenario C: PASS (update guard banner renders when the deployment build differs)')
  } else if (scenario === 'D') {
    // Batch 6: the OWNER account (stub /me carries the server-provided
    // owner flag + console URL) gets a "Switch to Admin" entry in the
    // account menu, pointing at exactly the URL /me delivered — the
    // slug itself is never a literal in the bundle.
    await waitFor(() => root.innerHTML.length > 0, 'app shell to render')
    const skipD = [...window.document.querySelectorAll('button, a')].find((el) => el.textContent.trim() === 'Skip setup')
    if (skipD) skipD.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => root.textContent.includes('Scheduled'), 'dashboard to render')
    const avatarBtnD = await waitFor(() => window.document.querySelector('.avatar-btn'), 'account (avatar) button')
    avatarBtnD.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => window.document.querySelector('.avatar-menu'), 'account menu to open')
    const adminLink = [...window.document.querySelectorAll('.avatar-menu a')].find((el) => el.textContent.includes('Switch to Admin'))
    if (!adminLink) fail('Switch to Admin missing from the owner account menu')
    if (adminLink.getAttribute('href') !== '/api/smoke-admin/console') fail('Switch to Admin href is not the /me-provided URL (got "' + adminLink.getAttribute('href') + '")')
    console.log('render-smoke scenario D: PASS (owner account menu carries Switch to Admin with the /me-provided URL)')
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
  for (const s of ['A', 'B', 'C', 'D']) {
    const r = spawnSync(process.execPath, [__filename, '--run', s, bundleDir], { stdio: 'inherit', env: { ...process.env, SMOKE_BUILD_ID: smokeBuildId } })
    if (r.status !== 0) failed = true
  }
  console.log(failed ? 'render-smoke: FAIL' : 'render-smoke: PASS')
  process.exit(failed ? 1 : 0)
}
