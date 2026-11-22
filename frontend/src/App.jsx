import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { api, nextBestTime, getWorkspaceId, setWorkspaceId } from './api.js'
import { trFor, loadDict, dictSync } from './i18n.js'
import { closeTopOverlay } from './overlayRegistry.js'
import { isNativeShell, openExternalUrl } from './openExternal.js'

import { IconHome, IconCal, IconQueue, IconPlus, IconMedia, IconBulk, IconTools, IconSpark, IconSettings, IconSun, IconMoon, IconMenu, IconX, IconBell, IconLink, IconSearch, IconTag, IconInstagram, IconYouTube, IconCrown, IconChevronRight, IconComment } from './components/icons.jsx'
import { Skeleton, isOwnMediaUrl, Logo } from './components/shared.jsx'
// The build id baked in at build time (vite define). The update guard
// below compares it with the id the server/static file reports for
// the CURRENT deployment.
// eslint-disable-next-line no-undef
const MY_BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : ''
// Heavy tabs load on demand so the first paint is only Dashboard + shell.
// A lazy import that fails because a deploy replaced the chunks gets
// ONE automatic reload (session-guarded) instead of a white page; a
// successful load clears the guard so a later, separate failure can
// reload again.
function lazyRetry(factory) {
  return lazy(async () => {
    try {
      const mod = await factory()
      try { sessionStorage.removeItem('ss-chunk-reload') } catch { /* ignore */ }
      return mod
    } catch (e) {
      let guarded = false
      try {
        guarded = !!sessionStorage.getItem('ss-chunk-reload')
        if (!guarded) sessionStorage.setItem('ss-chunk-reload', '1')
      } catch { /* storage unavailable — fall through to the error */ }
      if (!guarded) {
        window.location.reload()
        return new Promise(() => { /* page is reloading */ })
      }
      throw e
    }
  })
}
// Dashboard lazy-loads like the heavy tabs since batch 3: the main
// chunk budget (220 KB smoke guard) no longer fits the shell +
// Dashboard + the batch-3 workspace/guide code eagerly. The home tab
// shows the same skeleton fallback every other tab uses.
// The auth screens (login form + reset page, with the Google
// button) are only ever needed while logged out — they lazy-load
// so the signed-in shell's main bundle never pays for them.
const Auth = lazyRetry(() => import('./components/Auth.jsx'))
const ResetPassword = lazyRetry(() => import('./components/Auth.jsx').then((m) => ({ default: m.ResetPassword })))
const Dashboard = lazyRetry(() => import('./components/Dashboard.jsx'))
const SetupWizard = lazyRetry(() => import('./components/SetupWizard.jsx'))
const CalendarView = lazyRetry(() => import('./components/CalendarView.jsx'))
const Queue = lazyRetry(() => import('./components/Queue.jsx'))
const Studio = lazyRetry(() => import('./components/Studio.jsx'))
const Bulk = lazyRetry(() => import('./components/Bulk.jsx'))
const MediaLibrary = lazyRetry(() => import('./components/MediaLibrary.jsx'))
const Tools = lazyRetry(() => import('./components/Tools.jsx'))
const AIStudio = lazyRetry(() => import('./components/AIStudio.jsx'))
const Settings = lazyRetry(() => import('./components/Settings.jsx'))
const Connections = lazyRetry(() => import('./components/Connections.jsx'))
const Pricing = lazyRetry(() => import('./components/Pricing.jsx'))
// The public landing page is only ever shown to logged-out visitors,
// so it lazy-loads like the heavy tabs — the signed-in shell (and the
// main-chunk budget) never pays for it.
const Landing = lazyRetry(() => import('./components/Landing.jsx'))

function TabFallback() {
  return <div className="section"><div className="card" aria-busy="true"><Skeleton rows={4} /></div></div>
}

// The branded boot state (auth check, landing chunk, dictionary) —
// one component so the three gates can never drift apart.
function BootLoad({ label }) {
  return (
    <div className="boot-load" role="status">
      <Logo size={52} />
      <span className="boot-spinner" aria-hidden="true" />
      <span className="muted small">{label}</span>
    </div>
  )
}

const scrollTop = () => { try { window.scrollTo({ top: 0 }) } catch { /* no window */ } }

// The plan pill's inner content (crown icon + plan name) for the
// top-bar button (Round 3 B3: pills keep icon + text at every width).
function PlanPillInner({ user, tr }) {
  return (
    <>
      <IconCrown size={14} />
      {tr('planBadge').replace('{name}', user.planName || 'Free')}
    </>
  )
}

// The header connection chip (Round 3 B3): ONE labelled chip for
// BOTH platforms — icon(s) + text at every width, never colour-only
// or icon-only. Under ~520px CSS swaps the full label for the short
// form ("2/2" / "IG" / "YT" / "0/2") beside the same icons. Tapping
// it opens Connections. YouTube state comes from the same status
// endpoint Dashboard/Connections use (settings carries Instagram).
function ConnectionChip({ settings, ytStatus, igBroken, tr, onOpen }) {
  const ig = Boolean(settings && settings.instagramConnected)
  const yt = Boolean(ytStatus && ytStatus.connected)
  let label
  let short
  let icons
  if (!settings || ytStatus === null) {
    label = tr('checkingWord'); short = '…'; icons = <IconLink size={14} />
  } else if (igBroken) {
    label = tr('igBrokenShort'); short = 'IG'; icons = <IconInstagram size={14} />
  } else if (ig && yt) {
    label = tr('connBoth'); short = '2/2'; icons = <><IconInstagram size={14} /><IconYouTube size={14} /></>
  } else if (ig) {
    label = tr('connIgOnly'); short = 'IG'; icons = <IconInstagram size={14} />
  } else if (yt) {
    label = tr('connYtOnly'); short = 'YT'; icons = <IconYouTube size={14} />
  } else {
    label = tr('connNone'); short = '0/2'; icons = <IconLink size={14} />
  }
  return (
    <button type="button" className="pill conn-chip-btn" title={label} aria-label={label} onClick={onOpen}>
      <span className="conn-icons">{icons}</span>
      <span className="conn-full">{label}</span>
      <span className="conn-short" aria-hidden="true">{short}</span>
    </button>
  )
}

// Labels come from the dictionary (CORE carries every id; the AI
// tab's key is aiStudio) — NAV carries only ids + icons.
const NAV = [
  { id: 'home', Icon: IconHome },
  { id: 'calendar', Icon: IconCal },
  { id: 'queue', Icon: IconQueue },
  { id: 'media', Icon: IconMedia },
  { id: 'bulk', Icon: IconBulk },
  { id: 'tools', Icon: IconTools },
  { id: 'ai', Icon: IconSpark },
  { id: 'connections', Icon: IconLink },
  { id: 'pricing', Icon: IconTag },
  { id: 'settings', Icon: IconSettings }
]

// Round 3 (B3): the More drawer carries ONLY the overflow
// destinations, grouped — Home/Queue/Media/Create live in the
// bottom nav / topnav, and account actions live in the avatar menu.
// Icons resolve through NAV above so the two can never drift.
const DRAWER_GROUPS = [
  { headingKey: 'drawerGroupPlan', ids: ['calendar', 'bulk', 'ai', 'tools'] },
  { headingKey: 'drawerGroupAccount', ids: ['connections', 'pricing', 'settings'] }
]
// Owner-only destinations that make no sense inside a team workspace.
const WS_DRAWER_HIDDEN = ['tools', 'connections', 'pricing', 'settings']

// Phase 3 (Batch B): tabs are URL-backed. The tab lives in the hash
// (#/queue, #/studio, …) so refresh, share, deep-links and the
// browser/Android back button all work off one history stack. The
// admin console (a separate page) and /reset keep their own routing.
const TAB_IDS = ['home', 'studio', 'queue', 'calendar', 'media', 'ai', 'bulk', 'tools', 'connections', 'pricing', 'settings']
function tabFromHash() {
  try {
    const id = window.location.hash.replace(/^#\/?/, '')
    return TAB_IDS.includes(id) ? id : null
  } catch { return null }
}
// Focus trap helper (M-06): keep Tab cycling inside an open overlay.
function trapTabKey(e, container) {
  if (e.key !== 'Tab' || !container) return
  const f = Array.from(container.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter((el) => el.offsetParent !== null || el === document.activeElement)
  if (!f.length) return
  const first = f[0]
  const last = f[f.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

export default function App() {
  // Returning from the Meta "Connect Instagram" login lands on
  // /?ig_oauth=... — open Settings directly so its result banner shows.
  // The same applies to /open-app, the verified Android App Link the
  // connect result pages point at: it means "I just connected", so land
  // on Settings (and clean the path so a refresh doesn't repeat it).
  // Otherwise a #/<tab> deep link wins over the Home default.
  const [tab, setTab] = useState(() => {
    try {
      if (window.location.pathname.startsWith('/open-app')) return 'settings'
      if (new URLSearchParams(window.location.search).has('ig_oauth')) return 'settings'
      return tabFromHash() || 'home'
    } catch { return 'home' }
  })
  // Tab-history stack for the hardware/browser back model: mirrors
  // the entries this session pushed (the popstate handler trims it).
  const tabStackRef = useRef(null)
  if (tabStackRef.current === null) tabStackRef.current = [tab]
  const poppingRef = useRef(false)
  const hashInitRef = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('ss-theme') || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') } catch { return 'light' }
  })
  const [user, setUser] = useState(null)
  // Login split (Prompt-4): logged-out visitors land on the public
  // landing page; the form lives on its own screen, reached from the
  // landing's Log in / Create account buttons (null = landing).
  const [authScreen, setAuthScreen] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  // Phase 3 (Batch C): the auth check failed while offline — the
  // user gets the offline screen (with Retry), never the login page.
  const [authBlocked, setAuthBlocked] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [posts, setPosts] = useState([])
  const [media, setMedia] = useState([])
  const [templates, setTemplates] = useState([])
  const [drafts, setDrafts] = useState([])
  const [settings, setSettings] = useState(null)
  // YouTube half of the header connection chip (B3): settings carries
  // Instagram only, so the chip's YT state comes from the same status
  // endpoint Dashboard and Connections already use. null = checking.
  const [ytStatus, setYtStatus] = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null) // { id, message, kind, actionLabel, onAction }
  const [pendingDeleteIds, setPendingDeleteIds] = useState(new Set())
  // Posts with a pending (Undo-able) delete hidden. Declared here, before
  // any handler that reads it: referencing a const above its declaration
  // throws a TDZ ReferenceError on every render and blanks the whole app.
  const visiblePosts = useMemo(
    () => (pendingDeleteIds.size ? posts.filter((p) => !pendingDeleteIds.has(p.id)) : posts),
    [posts, pendingDeleteIds]
  )
  const [editing, setEditing] = useState(null)
  const [studioKey, setStudioKey] = useState(0)
  const [saving, setSaving] = useState(false)
  const [publishingId, setPublishingId] = useState(null)
  const [retryingId, setRetryingId] = useState(null)
  // Team workspaces (batch 3): memberships this user holds in other
  // people's workspaces + the workspace currently open ('' = own).
  const [memberships, setMemberships] = useState([])
  const [wsId, setWsId] = useState(() => getWorkspaceId())
  const wsIdRef = useRef(wsId)
  const [notifications, setNotifications] = useState([])
  // Public app status (batch 6): maintenance mode set by the owner in
  // the console. Fetched once; fails silent (no banner) if it cannot load.
  const [appStatus, setAppStatus] = useState(null)
  useEffect(() => {
    let live = true
    api.getAppStatus().then((s) => { if (live) setAppStatus(s) }).catch(() => {})
    return () => { live = false }
  }, [])
  const [unread, setUnread] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(null) // {type:'post'|'media'|'posts', item|items}
  const [templateSeed, setTemplateSeed] = useState(null)
  const [hashtagGroups, setHashtagGroups] = useState([])
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)
  // Phase D: UI language (D10), offline state (D2), global search (D3).
  const [lang, setLangState] = useState(() => { try { return localStorage.getItem('ss-lang') || 'en' } catch { return 'en' } })
  // Batch 5: the full dictionary is a lazy chunk (i18n-dict.js) so the
  // main bundle stays small; until it lands, tr() serves the CORE set
  // from i18n.js and the signed-in shell waits on the gate below.
  const [dict, setDict] = useState(() => dictSync())
  useEffect(() => { let on = true; loadDict().then((d) => { if (on) setDict(d) }); return () => { on = false } }, [])
  const tr = trFor(lang, dict)
  // Stable translator for callbacks/toasts (they must speak the
  // language current at call time, not at definition time).
  const trRef = useRef(tr); trRef.current = tr
  const tt = useCallback((k) => trRef.current(k), [])
  // Avatar-menu items all close the menu first, then act.
  const menuAct = (fn) => () => { setAvatarMenuOpen(false); if (fn) fn() }
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false)
  const [globalQ, setGlobalQ] = useState('')
  const [searchNonce, setSearchNonce] = useState(0)
  // Mobile header search: collapsed to an icon button; tapping it
  // expands a slim search row under the header (the always-visible
  // pill was too wide — it truncated and overlapped the logo).
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const toastTimer = useRef(null)
  const toastSeq = useRef(0)
  const pendingDeleteTimers = useRef(new Map())
  const refreshSettingsRef = useRef(null)
  const exchangeAppCodeRef = useRef(null)

  // Per-tab document title (screen readers + history) — Round 2
  // (R2-L7): the label follows the UI language like everything else.
  useEffect(() => {
    const key = tab === 'studio' ? 'create' : tab === 'ai' ? 'aiStudio' : tab
    document.title = tab === 'home' ? 'KiluaAI' : `${tt(key)} · KiluaAI`
  }, [tab, tt, lang, dict])

  // --- Phase 3 (Batch B): tab ⇄ hash synchronisation. Tab changes
  // push a history entry; popstate (browser back/forward, Android
  // back via the handler below) moves the tab without pushing.
  useEffect(() => {
    const want = `#/${tab}`
    if (poppingRef.current) {
      poppingRef.current = false
      const stack = tabStackRef.current
      while (stack.length > 1 && stack[stack.length - 1] !== tab) stack.pop()
      if (stack[stack.length - 1] !== tab) tabStackRef.current = [tab]
      return
    }
    if (window.location.hash === want) { hashInitRef.current = true; return }
    if (!hashInitRef.current) {
      // First sync: normalise the URL to the opening tab without
      // adding a history entry of our own.
      hashInitRef.current = true
      try { window.history.replaceState({ ssTab: tab }, '', want) } catch { /* hash stays unset */ }
      return
    }
    try { window.history.pushState({ ssTab: tab }, '', want) } catch { /* history unavailable */ }
    if (tabStackRef.current[tabStackRef.current.length - 1] !== tab) tabStackRef.current.push(tab)
  }, [tab])
  useEffect(() => {
    const onPop = () => {
      const id = tabFromHash()
      if (!id) return
      if (id === shellStateRef.current.tab) { tabStackRef.current = [id]; return }
      poppingRef.current = true
      setTab(id)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // M-07: the document language follows the UI language.
  useEffect(() => {
    try { document.documentElement.lang = lang === 'hi' ? 'hi' : 'en' } catch { /* no document */ }
  }, [lang])

  // App mode marker for CSS (bottom nav at any width, app-only rules).
  useEffect(() => {
    try { if (isNativeShell()) document.documentElement.classList.add('is-native') } catch { /* web */ }
  }, [])

  // Keyboard-open detection (visualViewport): the bottom nav hides
  // while the keyboard is up so it never covers the form (§6.2).
  const [kbOpen, setKbOpen] = useState(false)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return undefined
    const onResize = () => setKbOpen(window.innerHeight - vv.height > 150)
    vv.addEventListener('resize', onResize)
    onResize()
    return () => vv.removeEventListener('resize', onResize)
  }, [])

  // M-06: overlays return focus to whatever opened them.
  const overlayReturnFocusRef = useRef(null)
  const anyOverlayOpen = menuOpen || !!confirmDelete || avatarMenuOpen
  useEffect(() => {
    if (anyOverlayOpen) {
      if (!overlayReturnFocusRef.current && document.activeElement && document.activeElement !== document.body) {
        overlayReturnFocusRef.current = document.activeElement
      }
    } else if (overlayReturnFocusRef.current) {
      const el = overlayReturnFocusRef.current
      overlayReturnFocusRef.current = null
      try { if (el.isConnected) el.focus() } catch { /* element gone */ }
    }
  }, [anyOverlayOpen])

  // Avatar menu: Escape closes it too (it was backdrop-only).
  useEffect(() => {
    if (!avatarMenuOpen) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setAvatarMenuOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [avatarMenuOpen])

  // --- Android hardware back (C-01) [device-unverified]: close the
  // topmost overlay first, then walk the tab history, then Home,
  // and exit only from Home — the design system's back order.
  const shellStateRef = useRef({})
  shellStateRef.current = { confirmDelete, menuOpen, avatarMenuOpen, mobileSearchOpen, tab }
  const capAppRef = useRef(null)
  useEffect(() => {
    let remove = null
    let cancelled = false
    try {
      if (!isNativeShell()) return undefined
      import('@capacitor/app').then(({ App: CapApp }) => {
        if (cancelled) return
        capAppRef.current = CapApp
        CapApp.addListener('backButton', () => {
          const s = shellStateRef.current
          if (closeTopOverlay()) return
          if (s.confirmDelete) { setConfirmDelete(null); return }
          if (s.avatarMenuOpen) { setAvatarMenuOpen(false); return }
          if (s.mobileSearchOpen) { setMobileSearchOpen(false); return }
          if (s.menuOpen) { setMenuOpen(false); return }
          if (tabStackRef.current.length > 1) { window.history.back(); return }
          if (s.tab !== 'home') { setTab('home'); scrollTop(); return }
          if (capAppRef.current) capAppRef.current.exitApp()
        }).then((handle) => { if (!cancelled) remove = handle; else if (handle && handle.remove) handle.remove() })
          .catch(() => { /* listener unavailable */ })
      }).catch(() => { /* plugin not bundled in this context */ })
    } catch { /* not running in a native shell */ }
    return () => { cancelled = true; if (remove && remove.remove) remove.remove() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape closes the delete modal.
  useEffect(() => {
    if (!confirmDelete) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setConfirmDelete(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDelete])

  // D10: adopt the language stored on the user's settings when they load.
  useEffect(() => {
    if (settings && (settings.uiLanguage === 'en' || settings.uiLanguage === 'hi')) {
      setLangState((cur) => (cur === settings.uiLanguage ? cur : settings.uiLanguage))
    }
  }, [settings?.uiLanguage])
  const setLang = useCallback((l) => {
    setLangState(l)
    try { localStorage.setItem('ss-lang', l) } catch { /* private mode */ }
    api.saveSettings({ uiLanguage: l }).catch(() => { /* local choice still applies */ })
  }, [])

  // D2: offline banner state.
  useEffect(() => {
    const onOff = () => setOffline(true)
    const onOn = () => { setOffline(false); showToastRef.current && showToastRef.current(trRef.current('backOnline')) }
    window.addEventListener('offline', onOff)
    window.addEventListener('online', onOn)
    return () => { window.removeEventListener('offline', onOff); window.removeEventListener('online', onOn) }
  }, [])
  const showToastRef = useRef(null)

  // D3: run a global search — land on Queue with the query applied
  // (Media picks the same seed up when visited).
  const runGlobalSearch = useCallback((q) => {
    setGlobalQ(q)
    setSearchNonce((n) => n + 1)
    setTab('queue')
    setMenuOpen(false)
    setMobileSearchOpen(false)
  }, [])

  // Side drawer: Escape closes it, and the page behind it must not
  // scroll while it is open (the drawer's own list scrolls instead).
  useEffect(() => {
    if (!menuOpen) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [menuOpen])

  // /open-app arrived as a plain browser visit (not the Android app):
  // normalise the URL to the app home so refreshes and shares behave.
  useEffect(() => {
    try {
      if (window.location.pathname.startsWith('/open-app')) {
        window.history.replaceState({}, '', '/')
      }
    } catch { /* history unavailable — the page still works */ }
  }, [])

  // Android App Link return: when the system browser hands the user
  // back to the APK via https://…/open-app (verified App Link), the
  // native shell fires appUrlOpen — route to Settings and refetch the
  // connection status so "Connected" shows without a manual reload.
  useEffect(() => {
    let remove = null
    let cancelled = false
    try {
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
        import('@capacitor/app').then(({ App: CapApp }) => {
          if (cancelled) return
          CapApp.addListener('appUrlOpen', (data) => {
            try {
              const url = new URL(data && data.url ? data.url : '')
              if (url.pathname.startsWith('/open-app')) {
                setTab('settings')
                refreshSettingsRef.current && refreshSettingsRef.current()
              }
              // In-app Google sign-in return: the claimed return URL
              // carries the one-time code — exchange it for the
              // session right here (the login gate lifts on success).
              const appcode = url.searchParams.get('appcode')
                || (url.pathname.startsWith('/app-return') ? url.searchParams.get('code') : '')
              if (appcode && exchangeAppCodeRef.current) exchangeAppCodeRef.current(appcode)
            } catch { /* not a URL we route */ }
          }).then((handle) => { if (!cancelled) remove = handle; else handle && handle.remove && handle.remove() })
            .catch(() => { /* listener unavailable — focus refetch still covers us */ })
        }).catch(() => { /* plugin not bundled in this context */ })
      }
    } catch { /* not running in a native shell */ }
    return () => { cancelled = true; if (remove && remove.remove) remove.remove() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('ss-theme', theme) } catch { /* storage unavailable */ }
  }, [theme])

  // Update guard: ask what build the deployment is on now (the static
  // build-id.json written by the same build that produced this bundle,
  // falling back to /api/version) and compare with the id baked into
  // this bundle. A mismatch means this tab is running an old build —
  // offer a refresh instead of letting it rot onto missing chunks.
  // Runs on load, on window focus and when the tab becomes visible.
  useEffect(() => {
    if (!MY_BUILD_ID) return undefined
    let alive = true
    const check = async () => {
      try {
        let serverId = ''
        try {
          const r = await fetch(`/build-id.json?_=${Date.now()}`, { cache: 'no-store' })
          if (r && r.ok) { const j = await r.json().catch(() => null); serverId = (j && j.buildId) || '' }
        } catch { /* fall through to the API */ }
        if (!serverId) {
          const v = await api.getVersion().catch(() => null)
          serverId = (v && v.buildId) || ''
        }
        if (alive && serverId && serverId !== MY_BUILD_ID) setUpdateAvailable(true)
      } catch { /* a failed check must never disturb the app */ }
    }
    check()
    const onFocus = () => check()
    const onVis = () => { if (document.visibilityState === 'visible') check() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // Who is logged in? Logged-out visitors see only the Auth screen.
  // A network failure while offline is NOT "logged out" (Batch C):
  // it raises the offline screen instead of the login gate.
  const checkAuth = useCallback(() => {
    api.me()
      .then((res) => { setUser(res.user || null); setAuthBlocked(false) })
      .catch(() => {
        setUser(null)
        setAuthBlocked(typeof navigator !== 'undefined' && navigator.onLine === false)
      })
      .finally(() => setAuthChecked(true))
  }, [])
  // In-app Google sign-in (system-browser flow): the app comes back
  // holding a one-time code — in the boot URL (?appcode=, scrubbed
  // from the address bar immediately) or via appUrlOpen above.
  // Exchanging it sets the normal session cookie; the payload is the
  // same one a password login returns. A stale or already-used code
  // simply falls through to the normal auth check, which then shows
  // the login gate exactly as before.
  const exchangeAppCode = useCallback(async (code) => {
    try {
      const res = await api.appExchange(code)
      if (res && res.user) { setUser(res.user); setAuthBlocked(false); setAuthChecked(true); return true }
    } catch { /* expired or already used — the check below decides */ }
    return false
  }, [])
  exchangeAppCodeRef.current = exchangeAppCode
  useEffect(() => {
    let code = ''
    try { code = new URLSearchParams(window.location.search).get('appcode') || '' } catch { /* no query string */ }
    if (code && isNativeShell()) {
      try { window.history.replaceState(null, '', window.location.pathname + window.location.hash) } catch { /* URL stays — harmless */ }
      exchangeAppCode(code).then((ok) => { if (!ok) checkAuth() })
    } else checkAuth()
  }, [checkAuth, exchangeAppCode])
  // Coming back online while the offline screen is up retries by itself.
  useEffect(() => {
    if (!authBlocked) return undefined
    const onOn = () => { setAuthChecked(false); checkAuth() }
    window.addEventListener('online', onOn)
    return () => window.removeEventListener('online', onOn)
  }, [authBlocked, checkAuth])

  // --- Native splash (H-07) [device-unverified]: the Android shell
  // holds its splash (launchAutoHide=false) until the app says it is
  // ready. Hide it once the auth state settles — the first real paint
  // — and keep a hard 4 s backstop timer so the splash can never hang.
  // Complete no-op on the web: the isNativeShell() guard runs first
  // and the whole path is try/caught, exactly like the back handler.
  const splashHiddenRef = useRef(false)
  const hideSplash = useCallback(() => {
    if (splashHiddenRef.current) return
    try {
      if (!isNativeShell()) return
      splashHiddenRef.current = true
      import('@capacitor/splash-screen')
        .then(({ SplashScreen }) => { if (SplashScreen && SplashScreen.hide) SplashScreen.hide().catch(() => { /* already hidden */ }) })
        .catch(() => { /* plugin not bundled in this context */ })
    } catch { /* not running in a native shell */ }
  }, [])
  useEffect(() => { if (authChecked) hideSplash() }, [authChecked, hideSplash])
  useEffect(() => {
    const t = setTimeout(hideSplash, 4000)
    return () => clearTimeout(t)
  }, [hideSplash])

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      // allSettled + explicit 401 handling: previously a 401 (expired
      // session) was swallowed by the per-call .catch(() => []) and the
      // app showed an empty dashboard instead of the login screen.
      const results = await Promise.allSettled([
        api.getPosts(),
        api.getMedia(),
        api.getTemplates(),
        api.getSettings(),
        api.getStats(),
        api.dbStatus().catch(() => null),
        api.getNotifications().catch(() => null),
        api.getHashtagGroups().catch(() => []),
        api.getDrafts().catch(() => [])
      ])
      for (const r of results) {
        if (r.status === 'rejected' && r.reason && r.reason.status === 401) { setUser(null); return }
      }
      const value = (i, fallback) => (results[i].status === 'fulfilled' ? results[i].value : fallback)
      // In a team workspace, owner-only endpoints (settings) answer
      // 403 by design — that is the role gate working, not an app
      // error, so it never surfaces as one.
      const firstError = results.find((r) => r.status === 'rejected' && !(wsIdRef.current && r.reason && r.reason.status === 403))
      setPosts(value(0, [])); setMedia(value(1, [])); setTemplates(value(2, [])); setSettings(value(3, null)); setStats(value(4, null)); setDbStatus(value(5, null))
      const notif = value(6, null)
      if (notif) { setNotifications(notif.notifications || []); setUnread(notif.unread || 0) }
      setHashtagGroups(value(7, []))
      setDrafts(value(8, []))
      if (firstError) setError(firstError.reason)
    } catch (e) {
      if (e && e.status === 401) { setUser(null); return }
      setError(e)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { if (user) loadAll() }, [user, loadAll])

  // Header chip (B3): fetch the YouTube connection state once per
  // signed-in session (refreshSettings re-fetches after changes).
  useEffect(() => {
    if (!user) { setYtStatus(null); return undefined }
    let live = true
    api.youtubeStatus().then((d) => { if (live) setYtStatus(d) }).catch(() => { if (live) setYtStatus({ connected: false }) })
    return () => { live = false }
  }, [user])

  // Team workspaces (batch 3): load the workspaces this user belongs
  // to; a saved workspace that is no longer offered (removed by its
  // owner) falls back to the user's own workspace.
  useEffect(() => {
    if (!user) { setMemberships([]); return undefined }
    let alive = true
    api.getMemberships().then((d) => {
      if (!alive) return
      const list = (d && d.memberships) || []
      setMemberships(list)
      if (wsIdRef.current && !list.some((m) => m.ownerId === wsIdRef.current)) {
        setWorkspaceId(''); wsIdRef.current = ''; setWsId('')
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [user])

  const switchWorkspace = useCallback((id) => {
    setWorkspaceId(id); wsIdRef.current = id; setWsId(id); setTab('home')
  }, [])
  // Switching workspace re-scopes every list — refetch as the new scope.
  const wsFirstRun = useRef(true)
  useEffect(() => {
    if (wsFirstRun.current) { wsFirstRun.current = false; return }
    if (user) loadAll()
  }, [wsId]) // eslint-disable-line react-hooks/exhaustive-deps
  // Owner-only tabs make no sense inside someone else's workspace.
  useEffect(() => {
    if (wsId && (tab === 'settings' || tab === 'connections' || tab === 'tools' || tab === 'pricing')) setTab('home')
  }, [wsId, tab])

  // Auto-bridge: schedule requests made from the on-device library
  // while offline wait in a local pending list; this runner finishes
  // them (upload the bridge copy + create the server post) whenever the
  // app opens, resumes, comes back online, or every minute while open.
  // Dynamically imported so the device-storage plugin stays out of the
  // main bundle; in a plain browser the pending list is always empty
  // and every call is a cheap no-op.
  useEffect(() => {
    if (!user) return undefined
    let alive = true
    let remove = null
    let cancelled = false
    const run = async () => {
      try {
        const { processPendingSchedules } = await import('./autoBridge.js')
        const res = await processPendingSchedules()
        if (alive && res && res.ran && (res.results || []).some((r) => r.outcome === 'scheduled' || r.outcome === 'posted-late')) {
          showToast(tt('toastWaitingScheduled'))
          loadAll()
        }
        if (alive && res && res.ran && (res.results || []).some((r) => r.outcome === 'failed')) {
          showToast(tt('toastWaitingFailed'), 'error')
        }
      } catch { /* device storage unavailable in this context — nothing waiting */ }
    }
    run()
    const timer = setInterval(run, 60000)
    const onOnline = () => run()
    const onVis = () => { if (document.visibilityState === 'visible') run() }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVis)
    try {
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
        import('@capacitor/app').then(({ App: CapApp }) => {
          if (cancelled) return
          CapApp.addListener('appStateChange', ({ isActive }) => { if (isActive) run() })
            .then((handle) => { if (!cancelled) remove = handle; else if (handle && handle.remove) handle.remove() })
            .catch(() => { /* listener unavailable — interval/online still cover us */ })
        }).catch(() => { /* plugin not bundled in this context */ })
      }
    } catch { /* not running in a native shell */ }
    return () => {
      alive = false; cancelled = true
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVis)
      if (remove && remove.remove) remove.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const pushToast = useCallback(({ message, kind, actionLabel, onAction, duration = 6000 }) => {
    const id = ++toastSeq.current
    setToast({ id, message, kind, actionLabel, onAction })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast((cur) => (cur && cur.id === id ? null : cur)), duration)
  }, [])
  const showToast = useCallback((msg, kind) => pushToast({ message: msg, kind }), [pushToast])
  useEffect(() => { showToastRef.current = showToast }, [showToast])
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  const refreshStats = useCallback(async () => {
    try { setStats(await api.getStats()) } catch { /* keep last stats */ }
  }, [])

  const refreshSettings = useCallback(async () => {
    // Light refresh: settings + stats only. The old version called
    // loadAll(), which flashed skeletons across the whole app after every
    // settings save.
    try { setSettings(await api.getSettings()) } catch { /* keep last settings */ }
    // The header chip's YouTube half refreshes alongside (B3).
    api.youtubeStatus().then((d) => setYtStatus(d)).catch(() => { /* keep last YT state */ })
    refreshStats()
  }, [refreshStats])
  refreshSettingsRef.current = refreshSettings

  // Full reload (used after the setup wizard, when posts/media may have
  // been imported).
  const refreshAll = useCallback(async () => { await loadAll() }, [loadAll])

  // Pull-to-refresh (Phase 3 Batch C — audit M-03, spec §6.2)
  // [device-unverified]: a passive touch tracker — it never blocks
  // scrolling; a vertical pull starting at the very top of Home /
  // Queue / Library arms the indicator, releasing past the threshold
  // reloads. Row swipes are horizontal and unaffected.
  const [ptrPull, setPtrPull] = useState(0)
  const [ptrBusy, setPtrBusy] = useState(false)
  const ptrPullRef = useRef(0)
  useEffect(() => {
    if (typeof window === 'undefined' || !('ontouchstart' in window)) return undefined
    let startY = 0; let startX = 0; let tracking = false
    const eligible = () => {
      const s = shellStateRef.current
      return !!s.user && !s.menuOpen && !s.confirmDelete && (s.tab === 'home' || s.tab === 'queue' || s.tab === 'media') && window.scrollY <= 0
    }
    const setPull = (v) => { ptrPullRef.current = v; setPtrPull(v) }
    const onStart = (e) => {
      tracking = e.touches.length === 1 && eligible()
      if (tracking) { startY = e.touches[0].clientY; startX = e.touches[0].clientX }
    }
    const onMove = (e) => {
      if (!tracking) return
      const dy = e.touches[0].clientY - startY
      const dx = e.touches[0].clientX - startX
      if (dy > 10 && Math.abs(dy) > Math.abs(dx) * 1.5) setPull(Math.min(80, (dy - 10) * 0.55))
      else if (dy <= 0 && ptrPullRef.current) setPull(0)
    }
    const onEnd = () => {
      if (!tracking) return
      tracking = false
      if (ptrPullRef.current >= 64) { setPtrBusy(true); loadAll() }
      setPull(0)
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: true })
    document.addEventListener('touchend', onEnd)
    document.addEventListener('touchcancel', onEnd)
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
    }
  }, [loadAll])
  useEffect(() => { if (!loading) setPtrBusy(false) }, [loading])

  // Keyboard overlap (Batch C — audit H-04, web-side half)
  // [device-unverified]: on coarse pointers / in the app, a focused
  // field is scrolled to centre after the keyboard has had a moment
  // to open. The native half (windowSoftInputMode) ships with the APK.
  useEffect(() => {
    let coarse = false
    try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) } catch { /* older engines */ }
    if (!coarse && !isNativeShell()) return undefined
    const onFocusIn = (e) => {
      const el = e.target
      if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '')) return
      if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') return
      window.setTimeout(() => {
        try {
          const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
          el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
        } catch { /* scrollIntoView options unsupported — ignore */ }
      }, 350)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])

  const handleLogout = useCallback(async () => {
    try { await api.logout() } catch { /* cookie cleared server-side anyway */ }
    setWorkspaceId(''); wsIdRef.current = ''; setWsId(''); setMemberships([])
    setUser(null); setPosts([]); setMedia([]); setTemplates([]); setHashtagGroups([]); setDrafts([]); setSettings(null); setStats(null); setTab('home')
  }, [])

  const goStudio = (post = null) => {
    setEditing(post)
    setTemplateSeed(null)
    setStudioKey((k) => k + 1)
    setTab('studio')
    scrollTop()
  }

  const handleSavePost = useCallback(async (payload, isEdit) => {
    setSaving(true)
    try {
      if (isEdit && editing?.id) {
        const updated = await api.updatePost(editing.id, payload)
        setPosts((prev) => prev.map((p) => (p.id === editing.id ? { ...p, ...(updated || payload) } : p)))
        showToast(tt('toastPostUpdated'))
      } else {
        const created = await api.createPost(payload)
        setPosts((prev) => [created || { ...payload, id: `local-${Date.now()}` }, ...prev])
        showToast(payload.status === 'draft' ? tt('toastDraftSaved') : tt('toastPostScheduled'))
      }
      setEditing(null)
      refreshStats()
      setTab('queue')
    } finally { setSaving(false) }
  }, [editing, refreshStats])

  const handleDuplicate = useCallback(async (post) => {
    try {
      const res = await api.duplicatePost(post.id)
      const copy = res?.post || res
      if (copy && copy.id) setPosts((prev) => [copy, ...prev])
      else { const fresh = await api.getPosts().catch(() => null); if (fresh) setPosts(fresh) }
      showToast(tt('toastDuplicated'))
      refreshStats()
    } catch (e) { setError(e) }
  }, [refreshStats])

  const handleReschedule = useCallback(async (post, patch) => {
    try {
      const res = await api.reschedulePost(post.id, patch)
      const updated = res?.post || res
      if (updated && updated.id) setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, ...updated } : p)))
      showToast(tt('toastRescheduled'))
      refreshStats()
    } catch (e) { setError(e) }
  }, [refreshStats])

  const handleRescheduleNextBest = useCallback(async (post) => {
    const slot = nextBestTime(visiblePosts.filter((p) => p.id !== post.id))
    if (!slot) { showToast(tt('toastNoSlot')); return }
    await handleReschedule(post, { scheduleTime: slot })
  }, [visiblePosts, handleReschedule])

  const handlePublish = useCallback(async (post) => {
    setPublishingId(post.id)
    try {
      const res = await api.publishPost(post.id)
      if (res && res.ok === false) throw new Error(res.error || 'Publish failed.')
      const liveUrl = res?.liveUrl || res?.live_url
      if (res?.partial) {
        // Live on some ticked accounts, failed on others: refetch so
        // the row shows the real per-account state, and say so.
        try { const fresh = await api.posts(); if (fresh?.posts) setPosts(fresh.posts) } catch { /* the toast still explains */ }
        showToast(tt('toastPublishedSome'))
        refreshStats()
        return
      }
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, status: 'published', ...(liveUrl ? { liveUrl } : {}) } : p)))
      if (liveUrl) pushToast({ message: tt('toastPublishedLive'), actionLabel: tt('toastViewOnInstagram'), onAction: () => { if (!openExternalUrl(liveUrl)) window.open(liveUrl, '_blank', 'noopener') } })
      else showToast(tt('toastPublished'))
      refreshStats()
    } catch (e) {
      showToast(e.message || 'Publish failed.')
      // Surface the server's message plainly so the user knows what to fix
      // (e.g. "Instagram not connected — connect Instagram in Settings").
      setError(e)
      if (/no longer connected|not connected/i.test(e.message || '')) setTab('settings')
    } finally { setPublishingId(null) }
  }, [refreshStats, pushToast])

  // One-tap retry (batch 3): the server re-checks connection, media
  // and plan before re-arming, so a blocked retry explains exactly
  // what to fix (the error carries the check list); a successful one
  // publishes through the normal machinery and we refetch the truth.
  const handleRetry = useCallback(async (post) => {
    setRetryingId(post.id)
    try {
      const res = await api.retryPost(post.id)
      if (res && res.ok === false) throw new Error(res.error || 'Retry failed.')
      showToast(res?.partial ? tt('toastRetriedSome') : tt('toastRetried'))
      refreshStats()
    } catch (e) {
      showToast(e.message || 'Retry failed.')
      setError(e)
    } finally {
      setRetryingId(null)
      try { const fresh = await api.getPosts(); if (Array.isArray(fresh)) setPosts(fresh) } catch { /* the toast already explained */ }
    }
  }, [refreshStats])

  const doDelete = useCallback(async () => {
    if (!confirmDelete) return
    const { type, item, items } = confirmDelete
    setConfirmDelete(null)
    try {
      if (type === 'post') { await api.deletePost(item.id); setPosts((prev) => prev.filter((p) => p.id !== item.id)) }
      else if (type === 'posts') {
        for (const p of items || []) { try { await api.deletePost(p.id) } catch { /* keep going */ } }
        const ids = new Set((items || []).map((p) => p.id))
        setPosts((prev) => prev.filter((p) => !ids.has(p.id)))
      }
      else { await api.deleteMedia(item.id); setMedia((prev) => prev.filter((m) => m.id !== item.id)) }
      showToast(tt('toastDeleted'))
      refreshStats()
    } catch (e) { setError(e) }
  }, [confirmDelete, refreshStats])

  // Single-post delete is optimistic: the row hides at once and the
  // real DELETE is only sent when the Undo toast expires (~6s). The
  // post stays in `posts` until then, so Undo (or a failed DELETE)
  // restores it by simply un-hiding. Pending deletes are tracked per
  // post id, so a second delete never disturbs the first one's timer.
  const flushDeletePost = useCallback(async (id) => {
    pendingDeleteTimers.current.delete(id)
    setPendingDeleteIds((prev) => { const n = new Set(prev); n.delete(id); return n })
    try {
      await api.deletePost(id)
      setPosts((prev) => prev.filter((p) => p.id !== id))
      refreshStats()
    } catch (e) { setError(e) }
  }, [refreshStats])

  const requestDeletePost = useCallback((post) => {
    if (!post || !post.id || pendingDeleteTimers.current.has(post.id)) return
    setPendingDeleteIds((prev) => new Set(prev).add(post.id))
    pendingDeleteTimers.current.set(post.id, setTimeout(() => flushDeletePost(post.id), 6000))
    pushToast({
      message: tt('toastPostDeleted'),
      actionLabel: tt('toastUndo'),
      duration: 6000,
      onAction: () => {
        const t = pendingDeleteTimers.current.get(post.id)
        if (t) clearTimeout(t)
        pendingDeleteTimers.current.delete(post.id)
        setPendingDeleteIds((prev) => { const n = new Set(prev); n.delete(post.id); return n })
      }
    })
  }, [flushDeletePost, pushToast])

  // Unmount with deletes still pending: send them immediately rather
  // than losing them (the rows are already hidden, so the user's
  // intent is clear).
  useEffect(() => () => {
    for (const [id, t] of pendingDeleteTimers.current) { clearTimeout(t); api.deletePost(id).catch(() => {}) }
  }, [])

  // Posts whose scheduled time has passed without publishing.
  const overdue = useMemo(() => {
    const now = Date.now()
    return (visiblePosts || []).filter((p) => p.status === 'scheduled' && p.scheduleTime && new Date(p.scheduleTime).getTime() <= now)
  }, [visiblePosts])

  // Publish everything that is due, right now.
  const handlePublishDue = useCallback(async () => {
    setPublishingId('due')
    try {
      const res = await api.publishDue()
      const n = res?.published?.length || 0
      const f = res?.failed?.length || 0
      const r = res?.retrying?.length || 0
      if (n === 0 && f === 0 && r === 0) showToast(tt('toastNothingDue'))
      else showToast(`${tt('toastDuePublished').replace('{n}', n)}${f ? tt('toastDueFailed').replace('{n}', f) : ''}${r ? tt('toastDueRetrying').replace('{n}', r) : ''}.`)
      const fresh = await api.getPosts().catch(() => null)
      if (fresh) setPosts(fresh)
      refreshStats()
    } catch (e) {
      showToast(e.message || 'Could not publish due posts.')
      setError(e)
    } finally { setPublishingId(null) }
  }, [refreshStats])

  // AI Studio: save one draft, or many at once (Weekly Plan). Drafts are
  // created with status 'draft' and no media yet — the user adds the video
  // in Studio before anything is scheduled or published.
  const handleSaveDraft = useCallback(async (post) => {
    const created = await api.createPost({ ...post, status: 'draft' })
    if (created && created.id) setPosts((prev) => [created, ...prev])
    else { const fresh = await api.getPosts().catch(() => null); if (fresh) setPosts(fresh) }
    showToast(tt('toastDraftInQueue'))
    refreshStats()
    return created
  }, [refreshStats])

  const handleSaveDrafts = useCallback(async (postsToSave) => {
    const res = await api.createPostsBulk(postsToSave.map((p) => ({ ...p, status: 'draft' })))
    const fresh = await api.getPosts().catch(() => null)
    if (fresh) setPosts(fresh)
    refreshStats()
    showToast(tt((res?.imported ?? postsToSave.length) === 1 ? 'toastDraftsAddedOne' : 'toastDraftsAddedMany').replace('{n}', res?.imported ?? postsToSave.length))
    return res
  }, [refreshStats])

  const handleBulkImport = useCallback(async (rows) => {    // One bulk request per 500 rows (server endpoint) instead of one
    // request per row; falls back to one-by-one if the server is old.
    try {
      let imported = 0
      let failed = 0
      const errors = []
      for (let i = 0; i < rows.length; i += 500) {
        const res = await api.createPostsBulk(rows.slice(i, i + 500))
        imported += res.imported || 0
        failed += res.failed || 0
        if (res.errors) errors.push(...res.errors)
      }
      const fresh = await api.getPosts().catch(() => null)
      if (fresh) setPosts(fresh)
      refreshStats()
      return { imported, failed, errors }
    } catch (e) {
      let imported = 0
      const errors = []
      for (const row of rows) {
        try { await api.createPost(row); imported++ } catch (err) { errors.push(err.message || 'Failed row') }
      }
      const fresh = await api.getPosts().catch(() => null)
      if (fresh) setPosts(fresh)
      refreshStats()
      return { imported, failed: rows.length - imported, errors }
    }
  }, [refreshStats])

  const handleUpload = useCallback(async (file, extra, onProgress) => {
    const created = await api.uploadMedia(file, extra, onProgress)
    const item = created?.media || created
    if (item && item.id) setMedia((prev) => [item, ...prev])
    else { const fresh = await api.getMedia().catch(() => null); if (fresh) setMedia(fresh) }
    refreshStats()
    return item && item.id ? item : null
  }, [refreshStats])

  // Bell: jump to the Dashboard (where notifications live) and mark
  // everything read, locally and on the server.
  const openNotifications = useCallback(async () => {
    setTab('home')
    scrollTop()
    setUnread(0)
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
    try { await api.markNotificationsRead() } catch { /* badge already cleared locally */ }
  }, [])

  const handleAddLink = useCallback(async (data) => {
    const created = await api.createMedia({ ...data, kind: /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(data.url) ? 'image' : 'video', tags: data.tags || [] })
    const item = created?.media || created
    if (item && item.id) setMedia((prev) => [item, ...prev])
    else { const fresh = await api.getMedia().catch(() => null); if (fresh) setMedia(fresh) }
    refreshStats()
  }, [refreshStats])

  const handleCreateTemplate = useCallback(async (tpl) => {
    const created = await api.createTemplate(tpl)
    const item = created?.template || created
    if (item && item.id) setTemplates((prev) => [...prev, item])
    else { const fresh = await api.getTemplates().catch(() => null); if (fresh) setTemplates(fresh) }
    return item
  }, [])

  const handleDeleteTemplate = useCallback(async (tpl) => {
    try {
      await api.deleteTemplate(tpl.id)
      setTemplates((prev) => prev.filter((t) => t.id !== tpl.id))
      showToast(tt('toastTemplateDeleted'))
    } catch (e) { setError(e) }
  }, [])

  const handleCreateHashtagGroup = useCallback(async (group) => {
    const item = await api.createHashtagGroup(group)
    if (item && item.id) setHashtagGroups((prev) => [...prev, item])
    else { const fresh = await api.getHashtagGroups().catch(() => null); if (fresh) setHashtagGroups(fresh) }
    return item
  }, [])

  const handleDeleteHashtagGroup = useCallback(async (group) => {
    try {
      await api.deleteHashtagGroup(group.id)
      setHashtagGroups((prev) => prev.filter((g) => g.id !== group.id))
      showToast(tt('toastHashtagGroupDeleted'))
    } catch (e) { setError(e) }
  }, [])

  // Drafts library (Phase C3): named composer snapshots, loaded back
  // into the Studio — never auto-scheduled.
  const handleCreateDraft = useCallback(async (d) => {
    const created = await api.createDraft(d)
    const item = created?.draft || created
    if (item && item.id) setDrafts((prev) => [...prev, item])
    else { const fresh = await api.getDrafts().catch(() => null); if (fresh) setDrafts(fresh) }
    return item
  }, [])

  const handleDeleteDraft = useCallback(async (d) => {
    try {
      await api.deleteDraft(d.id)
      setDrafts((prev) => prev.filter((x) => x.id !== d.id))
      showToast(tt('toastDraftDeleted'))
    } catch (e) { setError(e) }
  }, [])

  // Plain-language failure fix action (Phase C5): a token/connection
  // failure's fix is reconnecting — that lives on the Connections page.
  const handleReconnect = useCallback(() => setTab('connections'), [])
  // Any connected account whose token Meta has revoked (the keeper's
  // verdict): header pills must not claim "connected" for it.
  const igBroken = Boolean(settings && ((settings.instagramHealth && settings.instagramHealth.needsReconnect)
    || (settings.instagramAccounts || []).some((a) => a && a.health && a.health.needsReconnect)))

  // "Post again": reopen the composer with the original post's content
  // so the user picks a fresh time — nothing is scheduled or published
  // automatically. If the original's media was a server copy that has
  // been removed since (auto-deleted after publish, or deleted from
  // the library), open the composer without media and say why — in the
  // app the phone original is where it can be picked again.
  const handlePostAgain = useCallback((post) => {
    let mediaGone = false
    if (post.mediaUrl) {
      const item = (media || []).find((m) => m.url === post.mediaUrl)
      if (item && item.serverCopyRemoved) mediaGone = true
      else if (!item && isOwnMediaUrl(post.mediaUrl)) mediaGone = true
    }
    setEditing(null)
    setTemplateSeed({
      mediaUrl: mediaGone ? '' : (post.mediaUrl || ''),
      mediaType: post.mediaType || 'video',
      posterUrl: mediaGone ? '' : (post.posterUrl || ''),
      caption: post.caption || '', hashtags: post.hashtags || '', cta: post.cta || '',
      platform: post.platform || 'Instagram', format: post.format || 'REELS',
      igTargets: Array.isArray(post.igTargets) && post.igTargets.length
        ? post.igTargets.map((t) => String(typeof t === 'string' ? t : (t?.igUserId || ''))).filter(Boolean)
        : (post.igAccountId ? [String(post.igAccountId)] : []),
      youtube: post.youtube || null,
      igEnabled: post.igEnabled,
      firstComment: post.firstComment || '', repeat: post.repeat || '',
      scheduleTime: ''
    })
    setStudioKey((k) => k + 1)
    setTab('studio')
    scrollTop()
    if (mediaGone) showToast(tt('toastMediaGone'))
  }, [media])

  // Getting-started checklist dismissal lives in the user's settings
  // on the server, so it follows the account across devices.
  const handleDismissChecklist = useCallback(async () => {
    setSettings((prev) => (prev ? { ...prev, checklistDismissed: true } : prev))
    try { await api.saveSettings({ checklistDismissed: true }) } catch { /* hidden locally either way */ }
  }, [])

  const useInStudio = useCallback((seed) => {
    // Seed is {text} (content bank) or a full template {name,text}.
    setTemplateSeed(seed)
    setEditing(null)
    setStudioKey((k) => k + 1)
    setTab('studio')
    scrollTop()
  }, [])

  const statsFallback = useMemo(() => stats || {
    scheduled: visiblePosts.filter((p) => p.status === 'scheduled').length,
    published: visiblePosts.filter((p) => p.status === 'published').length,
    failed: visiblePosts.filter((p) => p.status === 'failed').length,
    drafts: visiblePosts.filter((p) => p.status === 'draft').length,
    mediaCount: media.length
  }, [stats, visiblePosts, media])

  // --- Password reset: the emailed link lands on /reset?token=… and
  // that screen stands alone, signed in or not.
  let isResetRoute = false
  try { isResetRoute = window.location.pathname.startsWith('/reset') } catch { /* no window in this context */ }
  if (isResetRoute) {
    return (
      <div className="app">
        <Suspense fallback={<BootLoad label={tr('loading')} />}>
          <ResetPassword />
        </Suspense>
      </div>
    )
  }

  // --- Login gate: nothing but the Auth screen until the server says who this is.
  if (!authChecked) {
    return <div className="app"><BootLoad label={tr('loading')} /></div>
  }
  if (!user && authBlocked) {
    // Offline cold start (Batch C, C-02): the auth check could not
    // reach the server — show the offline screen, not the login gate.
    return (
      <div className="app">
        <div className="offline-screen">
          <Logo size={52} />
          <h1>{tr('offlineTitle')}</h1>
          <p>{tr('offlineBody')}</p>
          <button type="button" className="btn primary" onClick={() => { setAuthChecked(false); checkAuth() }}>{tr('retry')}</button>
        </div>
      </div>
    )
  }
  if (!user) {
    // Logged-out root (login split, Prompt-4): the public landing
    // page carries the marketing; the login/sign-up form lives on
    // its own clean screen behind the landing's buttons. Signed-in
    // users never see either.
    return (
      <div className="app">
        <Suspense fallback={<BootLoad label={tr('loading')} />}>
          {authScreen ? (
            <Auth initialMode={authScreen} onBack={() => setAuthScreen(null)} onAuth={(u) => { setAuthScreen(null); setUser(u); setTab('home') }} />
          ) : (
            <Landing onShowAuth={(m) => setAuthScreen(m)} />
          )}
        </Suspense>
      </div>
    )
  }

  // --- Dictionary gate: the signed-in shell waits for the lazy
  // dictionary chunk so no screen can flash untranslated strings.
  if (dict === null) {
    return <div className="app"><BootLoad label={tr('loading')} /></div>
  }

  // --- Setup wizard: first login only, until it is finished or skipped.
  if (settings && settings.setupDone !== true) {
    return (
      <div className="app">
        <Suspense fallback={<TabFallback />}>
          <SetupWizard settings={settings} onDone={refreshAll} onInstagramChanged={refreshAll} tr={tr} onCreateFirst={() => goStudio(null)} />
        </Suspense>
      </div>
    )
  }

  return (
    <div className="app with-bottomnav">
      <a className="skip-link" href="#main">Skip to content</a>
      {(offline || updateAvailable) && (
        // Phase 3 (Batch C): ONE status bar (design system §4.11) —
        // offline outranks the update notice, carries a Retry action,
        // and uses tokens (the old offline bar hardcoded #3a3f52).
        <div className={`update-bar${offline ? ' is-offline' : ''}`} role="status">
          {offline ? (
            <>
              <span>{tr('offlineMsg')}</span>
              <button type="button" className="update-refresh" onClick={() => loadAll()}>{tr('retry')}</button>
            </>
          ) : (
            <>
              <span>{tr('updateAvailable')}</span>
              <button type="button" className="update-refresh" onClick={() => window.location.reload()}>{tr('refreshWord')}</button>
              <button type="button" className="update-close" aria-label={tr('dismiss')} onClick={() => setUpdateAvailable(false)}>✕</button>
            </>
          )}
        </div>
      )}
      <div
        className="ptr-indicator"
        aria-hidden="true"
        style={{ transform: `translate(-50%, ${ptrBusy ? 4 : ptrPull - 72}px)`, opacity: ptrBusy || ptrPull > 0 ? 1 : 0 }}
      >
        <span className="ptr-spinner" />
      </div>
      <header className="topbar">
        <div className="topbar-in">
          <button type="button" className="icon-btn burger-btn" onClick={() => setMenuOpen(true)} aria-label={tr('ariaOpenMenu')} aria-expanded={menuOpen}>
            <IconMenu size={20} />
          </button>
          <div className="logo">
            <Logo size={40} />
            <div>
              <b>KiluaAI</b>
              <span>{tr('freeForever')}</span>
            </div>
          </div>
          <nav className="topnav" aria-label={tr('ariaMainNav')}>
            <button type="button" className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>{tr('home')}</button>
            <button type="button" onClick={() => goStudio(null)}>{tr('create')}</button>
            <button type="button" className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>{tr('queue')}</button>
            <button type="button" className={tab === 'calendar' ? 'active' : ''} onClick={() => setTab('calendar')}>{tr('calendar')}</button>
            <button type="button" className={tab === 'media' ? 'active' : ''} onClick={() => setTab('media')}>{tr('media')}</button>
            <button type="button" className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>{tr('aiStudio')}</button>
            <button type="button" className={tab === 'bulk' ? 'active' : ''} onClick={() => setTab('bulk')}>{tr('bulk')}</button>
            {!wsId && <button type="button" className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>{tr('tools')}</button>}
            {!wsId && <button type="button" className={tab === 'connections' ? 'active' : ''} onClick={() => setTab('connections')}>{tr('connections')}</button>}
            {!wsId && <button type="button" className={tab === 'pricing' ? 'active' : ''} onClick={() => setTab('pricing')}>{tr('pricing')}</button>}
          </nav>
          <div className="top-actions">
            <button type="button" className="icon-btn search-toggle-btn" onClick={() => setMobileSearchOpen((o) => !o)} aria-label={tr('ariaSearch')} aria-expanded={mobileSearchOpen}>
              <IconSearch size={18} />
            </button>
            {!wsId && <ConnectionChip settings={settings} ytStatus={ytStatus} igBroken={igBroken} tr={tr} onOpen={() => setTab('connections')} />}
            {!wsId && (
              <button type="button" className="pill plan-pill" title={user.comp ? tr('planTitleComp') : tr('planTitle')} onClick={() => setTab('pricing')}>
                <PlanPillInner user={user} tr={tr} />
              </button>
            )}
            <button type="button" className="icon-btn bell-btn" onClick={openNotifications} aria-label={unread ? `${tr('notificationsTitle')} — ${unread}${tr('ariaUnreadSuffix')}` : tr('notificationsTitle')}>
              <IconBell size={18} />
              {unread > 0 && <span className="bell-badge">{unread > 9 ? '9+' : unread}</span>}
            </button>
            <div className="avatar-wrap">
              <button type="button" className="avatar-btn" onClick={() => setAvatarMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={avatarMenuOpen} aria-label={tr('ariaAccountMenu')} title={user.email || ''}>
                {(user.name || user.email || 'K').trim().charAt(0).toUpperCase()}
              </button>
              {avatarMenuOpen && (
                <>
                  <div className="avatar-backdrop" onClick={() => setAvatarMenuOpen(false)} />
                  <div className="avatar-menu" role="menu">
                    <p className="avatar-email">{user.name || user.email}</p>
                    {user.name && <p className="muted small" style={{ padding: '0 10px 6px' }}>{user.email}</p>}
                    {memberships.length > 0 && (
                      <>
                        <p className="muted small" style={{ padding: '6px 10px 2px' }}>{tr('workspace')}</p>
                        <button type="button" role="menuitem" onClick={menuAct(() => switchWorkspace(''))}>{!wsId ? '✓ ' : ''}{tr('myWorkspace')}</button>
                        {memberships.map((m) => (
                          <button key={m.ownerId} type="button" role="menuitem" onClick={menuAct(() => switchWorkspace(m.ownerId))}>{wsId === m.ownerId ? '✓ ' : ''}{m.ownerEmail} · {m.role === 'viewer' ? tr('roleViewerShort') : tr('roleSchedulerShort')}</button>
                        ))}
                      </>
                    )}
                    {!wsId && <button type="button" role="menuitem" onClick={menuAct(() => setTab('settings'))}>{tr('settings')}</button>}
                    <button type="button" role="menuitem" onClick={menuAct(() => setTheme(theme === 'dark' ? 'light' : 'dark'))}>{theme === 'dark' ? tr('lightTheme') : tr('darkTheme')}</button>
                    <button type="button" role="menuitem" onClick={menuAct(() => setLang(lang === 'hi' ? 'en' : 'hi'))}>{tr('language')}: {lang === 'hi' ? 'Hinglish' : 'English'} · {tr('switchWord')}</button>
                    {user.isOwner && user.adminUrl && (
                      <a role="menuitem" href={user.adminUrl} onClick={() => setAvatarMenuOpen(false)}>{tr('switchToAdmin')}</a>
                    )}
                    <button type="button" role="menuitem" onClick={menuAct(handleLogout)}>{tr('logout')}</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        {mobileSearchOpen && (
          <form className="mobile-search-row" role="search" onSubmit={(e) => { e.preventDefault(); runGlobalSearch(globalQ) }}>
            <input type="search" autoFocus value={globalQ} onChange={(e) => setGlobalQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setMobileSearchOpen(false) }}
              placeholder={tr('searchPlaceholder')} aria-label={tr('ariaSearchPosts')} />
            <button type="button" className="icon-btn mobile-search-close" onClick={() => { setGlobalQ(''); setMobileSearchOpen(false) }} aria-label={tr('ariaCloseSearch')}>
              <IconX size={16} />
            </button>
          </form>
        )}
      </header>

      {menuOpen && (
        <div className="drawer-bg" onClick={() => setMenuOpen(false)} onKeyDown={(e) => trapTabKey(e, e.currentTarget.querySelector('.drawer'))}>
          <aside className="drawer" role="dialog" aria-modal="true" aria-label={tr('ariaMenu')} onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div className="logo">
                <Logo size={40} />
                <div>
                  <b>KiluaAI</b>
                  <span>{tr('freeForever')}</span>
                </div>
              </div>
              <button type="button" className="icon-btn" onClick={() => setMenuOpen(false)} aria-label={tr('ariaCloseMenu')} autoFocus>
                <IconX size={18} />
              </button>
            </div>
            <nav className="drawer-nav" aria-label={tr('ariaMenuNav')}>
              {wsId ? (
                <div className="drawer-plan-row">
                  <IconCrown size={20} /><span className="drawer-plan-name">{tr('planBadge').replace('{name}', user.planName || 'Free')}</span>
                </div>
              ) : (
                <button type="button" className="drawer-plan-row" title={user.comp ? tr('planTitleComp') : tr('planTitle')} onClick={() => { setTab('pricing'); setMenuOpen(false); scrollTop() }}>
                  <IconCrown size={20} /><span className="drawer-plan-name">{tr('planBadge').replace('{name}', user.planName || 'Free')}</span><span className="drawer-plan-chevron"><IconChevronRight size={18} /></span>
                </button>
              )}
              {DRAWER_GROUPS.map((group) => {
                const items = group.ids.filter((id) => !wsId || !WS_DRAWER_HIDDEN.includes(id))
                if (!items.length) return null
                return (
                  <div key={group.headingKey}>
                    <p className="drawer-group-label">{tr(group.headingKey)}</p>
                    {items.map((id) => {
                      const entry = NAV.find((n) => n.id === id)
                      const Icon = entry ? entry.Icon : IconTools
                      return (
                        <button key={id} type="button" className={`drawer-item ${tab === id ? 'active' : ''}`} aria-current={tab === id ? 'page' : undefined}
                          onClick={() => { setTab(id); setMenuOpen(false); scrollTop() }}>
                          <Icon size={20} /><span>{tr(id === 'ai' ? 'aiStudio' : id)}</span>
                        </button>
                      )
                    })}
                  </div>
                )
              })}
              <div>
                <p className="drawer-group-label">{tr('drawerGroupHelp')}</p>
                <a className="drawer-item" href="/contact.html" onClick={(e) => { setMenuOpen(false); if (openExternalUrl(new URL('/contact.html', window.location.origin).href)) e.preventDefault() }}>
                  <IconComment size={20} /><span>{tr('contact')}</span>
                </a>
              </div>
            </nav>
          </aside>
        </div>
      )}

      {appStatus && appStatus.maintenance && user && user.role !== 'owner' && (
        <div className="wrap" style={{ paddingBottom: 0 }}>
          <div className="warn amber nudge" role="status">
            <div style={{ flex: 1 }}>{appStatus.maintenanceMessage || tr('maintenanceDefault')}</div>
          </div>
        </div>
      )}

      {wsId && (() => {
        const m = memberships.find((x) => x.ownerId === wsId)
        if (!m) return null
        return (
          <div className="wrap" style={{ paddingBottom: 0 }}>
            <div className="warn amber nudge" role="status">
              <div style={{ flex: 1 }}>
                <b>{tr('wsBannerTitle').replace('{email}', m.ownerEmail)}</b> — {m.role === 'viewer' ? tr('wsViewerNote') : tr('wsSchedulerNote')} {tr('wsSafeNote')}
              </div>
              <button type="button" className="btn small" onClick={() => switchWorkspace('')}>{tr('backToMyWorkspace')}</button>
            </div>
          </div>
        )
      })()}

      <main className="wrap" id="main">
        {error && tab !== 'home' && (
          <div className="alert error" role="alert" style={{ marginTop: 16 }}>
            <div style={{ flex: 1 }}>{String(error.message || error)}</div>
            <button type="button" className="btn ghost small" onClick={() => { setError(null); loadAll() }}>{tr('retry')}</button>
            <button type="button" className="btn ghost small" onClick={() => setError(null)}>{tr('dismiss')}</button>
          </div>
        )}

        {tab === 'home' && (
          <Suspense fallback={<TabFallback />}>
          <Dashboard tr={tr} posts={visiblePosts} media={media} user={user} stats={statsFallback} loading={loading} error={error} onRetry={loadAll}
            onCreate={() => goStudio(null)} onGoQueue={() => setTab('queue')} onNavigate={setTab}
            onEdit={goStudio} onDelete={requestDeletePost}
            onPublish={handlePublish} publishingId={publishingId} settings={settings}
            onDuplicate={handleDuplicate} onPostAgain={handlePostAgain} onReschedule={handleReschedule} onRescheduleNextBest={handleRescheduleNextBest}
            onReconnect={handleReconnect}
            onDismissChecklist={handleDismissChecklist}
            onRetryPost={handleRetry} retryingId={retryingId}
            inWorkspace={!!wsId}
            overdue={overdue} onPublishDue={handlePublishDue} notifications={notifications} />
          </Suspense>
        )}
        <Suspense fallback={<TabFallback />}>
        {tab === 'calendar' && (
          <div className="section"><CalendarView posts={visiblePosts} loading={loading} onEdit={goStudio} onDelete={requestDeletePost} onPublish={handlePublish} publishingId={publishingId} onGoQueue={() => setTab('queue')} onCreate={() => goStudio(null)} onReconnect={handleReconnect} onReschedule={handleReschedule} /></div>
        )}
        {tab === 'queue' && (
          <div className="section"><Queue tr={tr} searchSeed={globalQ} searchNonce={searchNonce} posts={visiblePosts} loading={loading} onEdit={goStudio} onDelete={requestDeletePost} onPublish={handlePublish} publishingId={publishingId} onCreate={() => goStudio(null)} onDuplicate={handleDuplicate} onPostAgain={handlePostAgain} onReschedule={handleReschedule} onRescheduleNextBest={handleRescheduleNextBest} overdue={overdue} onPublishDue={handlePublishDue} onDeleteMany={(items) => setConfirmDelete({ type: 'posts', items })} onReconnect={handleReconnect} onRetry={handleRetry} retryingId={retryingId} /></div>
        )}
        {tab === 'studio' && (
          <div className="section">
            <Studio tr={tr} key={`${studioKey}-${editing?.id || 'new'}`} editing={editing} seed={templateSeed ? { caption: templateSeed.text || templateSeed.caption || '', hashtags: templateSeed.hashtags || '', cta: templateSeed.cta || '', mediaUrl: templateSeed.mediaUrl || '', mediaType: templateSeed.mediaType || 'video', posterUrl: templateSeed.posterUrl || '', scheduleTime: templateSeed.scheduleTime || '', platform: templateSeed.platform || 'Instagram', format: templateSeed.format || 'REELS', igTargets: Array.isArray(templateSeed.igTargets) ? templateSeed.igTargets : (templateSeed.igAccountId ? [templateSeed.igAccountId] : []), youtube: templateSeed.youtube || null, igEnabled: templateSeed.igEnabled, firstComment: templateSeed.firstComment || '', repeat: templateSeed.repeat || '' } : null} media={media} templates={templates} hashtagGroups={hashtagGroups} onCreateTemplate={handleCreateTemplate} onDeleteTemplate={handleDeleteTemplate} onCreateHashtagGroup={handleCreateHashtagGroup} onDeleteHashtagGroup={handleDeleteHashtagGroup} drafts={drafts} onSaveLibraryDraft={handleCreateDraft} onDeleteLibraryDraft={handleDeleteDraft} onSave={handleSavePost} onCancel={() => setTab('queue')} saving={saving} posts={visiblePosts} igAccounts={settings?.instagramAccounts || []} defaultIgUserId={settings?.defaultIgUserId || ''} settings={settings} onNavigate={setTab} onUploadFile={handleUpload} />
          </div>
        )}
        {tab === 'bulk' && <div className="section"><Bulk onImport={handleBulkImport} posts={visiblePosts} onUploadFile={handleUpload} igAccounts={settings?.instagramAccounts || []} defaultIgUserId={settings?.defaultIgUserId || ''} hashtagGroups={hashtagGroups} /></div>}
        {tab === 'media' && (
          <div className="section"><MediaLibrary tr={tr} searchSeed={globalQ} searchNonce={searchNonce} media={media} loading={loading} error={error} onRetry={loadAll}
            onAddLink={handleAddLink} onUpload={handleUpload}
            onToggleFav={async (m) => { const u = await api.updateMedia(m.id, { favorite: !m.favorite }); setMedia((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...(u || {}), favorite: !m.favorite } : x))) }}
            onDelete={(m) => setConfirmDelete({ type: 'media', item: m })}
            onUse={(m) => { setEditing(null); setTemplateSeed({ mediaUrl: m.url, mediaType: m.kind === 'image' ? 'image' : 'video', posterUrl: m.posterUrl || '', caption: '', scheduleTime: '' }); setStudioKey((k) => k + 1); setTab('studio'); scrollTop() }} /></div>
        )}
        {tab === 'tools' && (
          <div className="section"><Tools posts={visiblePosts} stats={statsFallback} templates={templates} onCreateTemplate={handleCreateTemplate} onUseTemplate={useInStudio} tr={tr} /></div>
        )}
        {tab === 'ai' && (
          <div className="section"><AIStudio posts={visiblePosts} settings={settings} onSendToStudio={useInStudio} onSaveDraft={handleSaveDraft} onSaveDrafts={handleSaveDrafts} tr={tr} /></div>
        )}
        {tab === 'settings' && (
          <div className="section"><Settings settings={settings} dbStatus={dbStatus} saving={saving} onSave={async (s) => { setSaving(true); try { const u = await api.saveSettings(s); setSettings(u || s) } finally { setSaving(false) } }} onInstagramChanged={refreshSettings} user={user} onAccountDeleted={handleLogout} onNavigate={setTab} lang={lang} onLangChange={setLang} tr={tr} /></div>
        )}
        {tab === 'connections' && (
          <div className="section"><Connections tr={tr} settings={settings} onInstagramChanged={refreshSettings} /></div>
        )}
        {tab === 'pricing' && !wsId && (
          <div className="section"><Pricing tr={tr} /></div>
        )}
        </Suspense>

        <footer className="footer">
          <b>KiluaAI</b> — {tr('footerTag')}<br />
          {tr('footerLine')}<br />
          <span className="muted small">{MY_BUILD_ID ? (MY_BUILD_ID.startsWith('local-') ? 'local build' : `build ${MY_BUILD_ID.slice(0, 7)}`) : ''}{dbStatus?.db ? ` · storage: ${dbStatus.db}` : ''} · <a href="/contact.html" onClick={(e) => { if (openExternalUrl(new URL('/contact.html', window.location.origin).href)) e.preventDefault() }}>{tr('contact')}</a></span>
        </footer>
      </main>

      {/* Phase 3 (Batch B): mobile bottom navigation (design system
          §4.8) — the core loop only; everything else lives in the
          drawer that "More" opens. Hidden while the keyboard, the
          drawer or a modal is up. */}
      <nav className={`bottom-nav${menuOpen || confirmDelete || kbOpen ? ' bn-hidden' : ''}`} aria-label={tr('ariaPrimaryNav')}>
        <button type="button" className={`bn-item${tab === 'home' ? ' active' : ''}`} aria-current={tab === 'home' ? 'page' : undefined} onClick={() => { setTab('home'); scrollTop() }}>
          <IconHome size={22} /><span>{tr('home')}</span>
        </button>
        <button type="button" className={`bn-item${tab === 'queue' ? ' active' : ''}`} aria-current={tab === 'queue' ? 'page' : undefined} onClick={() => { setTab('queue'); scrollTop() }}>
          <IconQueue size={22} /><span>{tr('queue')}</span>
          {(visiblePosts || []).some((p) => p.status === 'failed') && <span className="bn-dot" aria-hidden="true" />}
        </button>
        <button type="button" className={`bn-item bn-create${tab === 'studio' ? ' active' : ''}`} aria-current={tab === 'studio' ? 'page' : undefined} onClick={() => goStudio(null)}>
          <span className="bn-disc"><IconPlus size={24} /></span><span>{tr('create')}</span>
        </button>
        <button type="button" className={`bn-item${tab === 'media' ? ' active' : ''}`} aria-current={tab === 'media' ? 'page' : undefined} onClick={() => { setTab('media'); scrollTop() }}>
          <IconMedia size={22} /><span>{tr('media')}</span>
        </button>
        <button type="button" className="bn-item" onClick={() => setMenuOpen(true)} aria-label={tr('more')}>
          <IconMenu size={22} /><span>{tr('more')}</span>
        </button>
      </nav>

      {toast && (
        <div className={`toast-pill ${toast.kind === 'error' ? 'error' : ''}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          <span>{toast.message}</span>
          {toast.actionLabel && (
            <button type="button" className="toast-action" onClick={() => { const fn = toast.onAction; if (toastTimer.current) clearTimeout(toastTimer.current); setToast(null); if (fn) fn() }}>{toast.actionLabel}</button>
          )}
          <button type="button" className="toast-close" aria-label={tr('dismiss')} onClick={() => setToast(null)}>✕</button>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-bg" role="dialog" aria-modal="true" aria-label={tr('ariaConfirmDelete')} onClick={() => setConfirmDelete(null)} onKeyDown={(e) => trapTabKey(e, e.currentTarget.querySelector('.modal'))}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{confirmDelete.type === 'posts' ? tr('deletePostsTitle').replace('{n}', (confirmDelete.items || []).length) : confirmDelete.type === 'post' ? tr('deletePostTitle') : tr('deleteMediaTitle')}</h2>
            <p className="muted mt">{confirmDelete.type === 'posts' ? tr('deletePostsBody') : confirmDelete.type === 'post' ? (confirmDelete.item.caption || tr('untitledPost')) : (confirmDelete.item.title || confirmDelete.item.url)} — {tr('deleteNoUndo')}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button type="button" className="btn ghost" autoFocus onClick={() => setConfirmDelete(null)}>{tr('cancel')}</button>
              <button type="button" className="btn danger-fill" onClick={doDelete}>{tr('delete')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
