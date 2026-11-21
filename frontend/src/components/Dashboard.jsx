import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { api, fmtDateTime, formatCountdown, openInstagramDirectConnect } from '../api.js'
import { ErrorBox } from './shared.jsx'
import { IconClock } from './icons.jsx'

function useCountdown(targetIso) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!targetIso) return undefined
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [targetIso])
  if (!targetIso) return { label: '—', parts: null }
  const diff = Math.max(0, new Date(targetIso).getTime() - now)
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  return { label: formatCountdown(targetIso), parts: { d, h, m } }
}

const GuideWizard = lazy(() => import('./GuideWizard.jsx'))

// Dashboard (batch 4): ONE job — status at a glance, short enough to
// read in five seconds. Greeting + next post + one big New Post
// button, the problem alerts (never hidden — the satisfaction rule),
// and a "Today at a glance" card: published today, up next, problems,
// plus the Instagram/YouTube connection strip. Everything else moved
// to its own tab: the plan lives on Pricing, the post lists live in
// Queue, the day-by-day table lives in Calendar, totals live in
// Pricing's "Your numbers".
export default function Dashboard({ posts, media, user, loading, error, onRetry, onCreate, onGoQueue, onNavigate, onPublish, publishingId, settings, onDismissChecklist, overdue, onPublishDue, notifications, tr, onSearch, onDismissGuide, inWorkspace }) {
  const t = tr || ((k) => k)
  // Home search pill: routes into the same global search as the top
  // nav — Queue filtered by caption, Media by name. Kept on Home
  // because on phones the header search collapses to an icon; this
  // pill is the visible search entry here.
  const [homeQ, setHomeQ] = useState('')
  // Publishing streak (real data only): consecutive days with at
  // least one published post, ending today or yesterday.
  const streak = useMemo(() => {
    const days = new Set((posts || []).filter((p) => p.status === 'published' && p.scheduleTime).map((p) => new Date(p.scheduleTime).toDateString()))
    if (!days.size) return 0
    let n = 0
    const d = new Date()
    if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1) // streak may end yesterday
    while (days.has(d.toDateString())) { n++; d.setDate(d.getDate() - 1) }
    return n
  }, [posts])
  // Getting started: three steps, each done-state derived from the
  // user's real data. Dismissal is stored server-side (settings), so
  // it follows the account; the card hides for good once all three
  // steps are done. Step 1 goes straight to the Connections tab —
  // that is where accounts live now (batch 4 de-duplication; the old
  // card sent users to Settings, which itself pointed onward).
  const checklist = useMemo(() => [
    { done: Boolean(settings?.instagramConnected), label: 'Connect Instagram', hint: 'So your posts can publish live', tab: 'connections', cta: 'Connect' },
    { done: (media || []).length > 0, label: 'Add your first media', hint: 'Upload a video or image, or add one by link', tab: 'media', cta: 'Add media' },
    { done: (posts || []).length > 0, label: 'Schedule your first post', hint: 'Pick a time in the Studio', tab: 'studio', cta: 'Create a post' },
  ], [settings, media, posts])
  const checklistDone = checklist.every((c) => c.done)
  const checklistDismissed = settings?.checklistDismissed === true
  const greeting = useMemo(() => {
    const h = new Date().getHours()
    const word = h < 12 ? t('goodMorning') : h < 17 ? t('goodAfternoon') : t('goodEvening')
    const first = user?.name ? String(user.name).trim().split(/\s+/)[0] : ''
    return first ? `${word}, ${first}` : word
  }, [user, t])
  const postedThisWeek = useMemo(() => {
    const now = Date.now()
    return (posts || []).filter((p) => p.status === 'published' && p.scheduleTime && new Date(p.scheduleTime).getTime() <= now && new Date(p.scheduleTime).getTime() >= now - 7 * 86400000).length
  }, [posts])
  // Today at a glance — all from the user's real posts.
  const publishedToday = useMemo(() => {
    const key = new Date().toDateString()
    return (posts || []).filter((p) => p.status === 'published' && new Date(p.publishedAt || p.scheduleTime || 0).toDateString() === key).length
  }, [posts])
  const upcoming = useMemo(() => {
    const now = Date.now()
    return [...(posts || [])]
      .filter((p) => p.status === 'scheduled' && p.scheduleTime && new Date(p.scheduleTime).getTime() >= now - 60000)
      .sort((a, b) => new Date(a.scheduleTime) - new Date(b.scheduleTime))
  }, [posts])
  const next = upcoming[0]
  const cd = useCountdown(next?.scheduleTime)
  const failedPosts = useMemo(() => [...(posts || [])]
    .filter((p) => p.status === 'failed')
    .sort((a, b) => new Date(b.failedAt || b.scheduleTime || 0) - new Date(a.failedAt || a.scheduleTime || 0)), [posts])
  const partialCount = useMemo(() => (posts || []).filter((p) => p.status === 'partial').length, [posts])
  // Broken Instagram connections (keeper verdict: Meta revoked the
  // token, auto-renewal cannot save it). Usernames of every connected
  // account in that state — the default account's health plus every
  // account row's own health. Drives the persistent alert below: a
  // broken connection must be impossible to miss, because scheduled
  // posts for it cannot publish (the Byvano lesson).
  const brokenIg = useMemo(() => {
    const out = []
    const seen = new Set()
    const push = (u) => { const name = u || ''; if (!seen.has(name)) { seen.add(name); out.push(name) } }
    if (settings?.instagramHealth?.needsReconnect) push(settings.instagramUsername || settings.instagramHandle || '')
    for (const a of settings?.instagramAccounts || []) if (a?.health?.needsReconnect) push(a.username || '')
    return out
  }, [settings])
  const overdueCount = (overdue || []).length
  const problemCount = failedPosts.length + partialCount + overdueCount + brokenIg.length
  const problemBits = [
    failedPosts.length + partialCount > 0 ? `${failedPosts.length + partialCount} ${t('probPosts')}` : '',
    overdueCount > 0 ? `${overdueCount} ${t('probOverdue')}` : '',
    brokenIg.length > 0 ? `${brokenIg.length} ${t('probConnection')}` : '',
  ].filter(Boolean).join(' · ')
  const [reconnectBusy, setReconnectBusy] = useState(false)
  const startReconnect = async () => {
    setReconnectBusy(true)
    try { await openInstagramDirectConnect() } finally { setReconnectBusy(false) }
  }
  // YouTube half of the connection strip (the Instagram half reads
  // from settings, which App already loads). One small status call,
  // the same endpoint the Connections card uses.
  const [yt, setYt] = useState(null)
  useEffect(() => {
    let live = true
    api.youtubeStatus().then((d) => { if (live) setYt(d) }).catch(() => { if (live) setYt({ connected: false }) })
    return () => { live = false }
  }, [])
  // Tomorrow nudge: shown when nothing is scheduled for tomorrow.
  // Dismissing hides it for the rest of today (localStorage by date).
  const [nudgeDismissed, setNudgeDismissed] = useState(() => {
    try { return localStorage.getItem('ss-nudge-day') === new Date().toDateString() } catch { return false }
  })
  const dismissNudge = () => {
    setNudgeDismissed(true)
    try { localStorage.setItem('ss-nudge-day', new Date().toDateString()) } catch { /* stays hidden this session */ }
  }
  const hasTomorrow = useMemo(() => {
    const tm = new Date(); tm.setDate(tm.getDate() + 1)
    const key = tm.toDateString()
    return (posts || []).some((p) => p.status === 'scheduled' && p.scheduleTime && new Date(p.scheduleTime).toDateString() === key)
  }, [posts])

  // First-run guide (batch 3): the wizard form of the checklist
  // below, for brand-new users only (no posts yet, guide not
  // dismissed, steps not all done). In a team workspace the guide
  // never appears — the workspace is not yours to set up.
  const guideSteps = checklist.map((c) => ({ done: c.done, title: c.label, body: c.hint, tab: c.tab, cta: c.cta }))
  const showGuide = !loading && !inWorkspace && settings && settings.guideDismissed !== true && !checklistDone && (posts || []).length === 0
  return (
    <div>
      {showGuide && (
        <Suspense fallback={null}>
          <GuideWizard steps={guideSteps} tr={t} onNavigate={onNavigate} onDismiss={onDismissGuide} />
        </Suspense>
      )}
      <section className="home-head" aria-label="Next scheduled post">
        <h1>{greeting}</h1>
        {onSearch && (
          <form className="home-search" role="search" onSubmit={(e) => { e.preventDefault(); onSearch(homeQ) }}>
            <img src="/icon-192.png" alt="" width="26" height="26" aria-hidden="true" />
            <input type="search" value={homeQ} onChange={(e) => setHomeQ(e.target.value)} placeholder={t('homeSearchPlaceholder')} aria-label="Search posts and media" />
            <button type="submit" className="btn small">Search</button>
          </form>
        )}
        {loading ? (
          <div style={{ marginTop: 14 }}><div className="skel" style={{ height: 20, width: '55%' }} /><div className="skel" style={{ height: 16, width: '40%', marginTop: 10 }} /></div>
        ) : next ? (
          <>
            <p className="muted" style={{ marginTop: 6 }}>Next up: <b style={{ color: 'var(--ink)' }}>{next.caption ? (next.caption.length > 90 ? `${next.caption.slice(0, 90)}…` : next.caption) : 'Untitled post'}</b></p>
            <p className="muted small" style={{ marginTop: 4 }}>{next.platform || 'Instagram'} · {next.format || 'REELS'} · {fmtDateTime(next.scheduleTime)} · in {cd.label}{next.hashtags ? ` · ${next.hashtags}` : ''}</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={onCreate}>Create Post</button>
              <button type="button" className="btn ghost" onClick={() => onPublish && onPublish(next)} disabled={publishingId === next.id}>Publish next now</button>
              <button type="button" className="btn ghost" onClick={onGoQueue}>View queue</button>
            </div>
          </>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 6 }}>Nothing scheduled yet — create your first post, or import a whole week at once with Bulk scheduling. It&apos;s free, forever.</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={onCreate}>Create Post</button>
              <button type="button" className="btn ghost" onClick={onGoQueue}>View queue</button>
            </div>
          </>
        )}
      </section>

      {error && <ErrorBox error={error} onRetry={onRetry} />}

      {!loading && brokenIg.length > 0 && (
        <div className="alert error" role="alert" style={{ marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <b>Instagram connection broken{brokenIg.length === 1 && brokenIg[0] ? ` for @${brokenIg[0]}` : ''}</b> — Meta ended {brokenIg.length === 1 ? 'this connection' : 'these connections'} (for example a password change, or access removed in your Meta settings). Scheduled posts for {brokenIg.length === 1 ? 'that account' : 'those accounts'} cannot publish until you reconnect — it takes one tap.
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn primary small" disabled={reconnectBusy} onClick={startReconnect}>{reconnectBusy ? 'Opening Instagram login…' : 'Reconnect Instagram'}</button>
              <button type="button" className="btn ghost small" onClick={() => onNavigate && onNavigate('connections')}>Open Connections</button>
            </div>
          </div>
        </div>
      )}

      {!loading && (
        <section className="card" style={{ padding: '14px 16px', marginTop: 16 }} aria-label={t('todayGlance')}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{t('todayGlance')}</h2>
          <div className="stats stats-3" style={{ marginTop: 12 }}>
            <div className="stat"><b>{publishedToday}</b><span>{t('publishedToday')}</span><small>{postedThisWeek} this week{streak > 0 ? ` · ${streak}-day streak` : ''}</small></div>
            <div className="stat"><b>{upcoming.length}</b><span>{t('scheduled')}</span><small>{next ? `${new Date(next.scheduleTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${new Date(next.scheduleTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · in ${cd.label}` : t('nothingScheduled')}</small></div>
            <div className="stat"><b style={problemCount > 0 ? { color: 'var(--red)' } : undefined}>{problemCount}</b><span>{t('problems')}</span><small>{problemCount > 0 ? problemBits : t('allGood')}</small></div>
          </div>
          <div className="conn-strip">
            <span className="conn-chip">
              <span className={`dot ${!settings ? 'amber' : brokenIg.length > 0 || !settings.instagramConnected ? 'off' : ''}`} aria-hidden="true" />
              Instagram · {!settings ? '…' : brokenIg.length > 0 ? t('connectionBroken') : settings.instagramConnected ? `${t('connected')}${settings.instagramHandle ? ` · @${settings.instagramHandle}` : ''}` : t('notConnected')}
              {!inWorkspace && settings && brokenIg.length > 0 && <button type="button" className="btn primary small" disabled={reconnectBusy} onClick={startReconnect}>{reconnectBusy ? '…' : t('reconnect')}</button>}
              {!inWorkspace && settings && brokenIg.length === 0 && !settings.instagramConnected && <button type="button" className="btn ghost small" onClick={() => onNavigate && onNavigate('connections')}>{t('openConnections')}</button>}
            </span>
            <span className="conn-chip">
              <span className={`dot ${yt == null ? 'amber' : yt.connected ? '' : 'off'}`} aria-hidden="true" />
              YouTube · {yt == null ? '…' : yt.connected ? `${t('connected')}${yt.channelTitle ? ` · ${yt.channelTitle}` : ''}` : t('notConnected')}
              {!inWorkspace && yt && !yt.connected && <button type="button" className="btn ghost small" onClick={() => onNavigate && onNavigate('connections')}>{t('openConnections')}</button>}
            </span>
            {problemCount > 0 && (
              <button type="button" className="btn small" onClick={onGoQueue} style={{ marginLeft: 'auto' }}>{t('reviewInQueue')}</button>
            )}
          </div>
        </section>
      )}

      {!loading && overdue && overdue.length > 0 && (
        <div className="alert error" role="alert" style={{ marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <b>{overdue.length} post{overdue.length === 1 ? '' : 's'} overdue</b> — scheduled time passed without publishing.
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn primary small" disabled={publishingId === 'due'} onClick={onPublishDue}>{publishingId === 'due' ? 'Publishing…' : `Publish due (${overdue.length})`}</button>
              <button type="button" className="btn ghost small" onClick={onGoQueue}>Review in Queue</button>
            </div>
          </div>
        </div>
      )}

      {!loading && failedPosts.length > 0 && (
        <div className="alert error" role="alert" style={{ marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <b>{failedPosts.length} post{failedPosts.length === 1 ? '' : 's'} failed to publish</b>
            {failedPosts[0].retryPending ? ' — the newest one will be retried automatically in about 15 minutes.' : ' — the automatic retry has been used.'}
            {failedPosts[0].lastPublishError && <div className="small" style={{ marginTop: 4 }}>Latest reason: {failedPosts[0].lastPublishError}</div>}
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn ghost small" onClick={onGoQueue}>Review in Queue</button>
            </div>
          </div>
        </div>
      )}

      {!loading && notifications && notifications.length > 0 && (
        <section className="card section" aria-label="Notifications">
          <div className="card-head"><div><h2>Notifications</h2><p>Publish results — successes and failures with their reasons.</p></div></div>
          <div>
            {notifications.slice(0, 5).map((n) => (
              <p key={n.id} className="small" style={{ padding: '6px 0', color: n.read ? 'var(--muted)' : 'var(--ink)' }}>
                {n.type === 'publish-success' ? '✅ ' : '⚠️ '}<b>{n.type === 'publish-success' ? 'Published' : 'Publish problem'}</b>
                <span className="muted"> · {fmtDateTime(n.createdAt)}</span>
                <br /><span>{String(n.message || '').replace(/^Publish (failed|ed)[^:]*: /, '')}</span>
              </p>
            ))}
          </div>
        </section>
      )}

      {!loading && !inWorkspace && !checklistDismissed && !checklistDone && (
        <section className="card section" aria-label="Getting started checklist">
          <div className="card-head">
            <div><h2>Getting started</h2><p>{checklist.filter((c) => c.done).length} of {checklist.length} done</p></div>
            <button type="button" className="btn ghost small" onClick={onDismissChecklist}>Dismiss</button>
          </div>
          <div className="pbar" style={{ marginBottom: 12 }} aria-hidden="true"><span style={{ width: `${(checklist.filter((c) => c.done).length / checklist.length) * 100}%`, background: 'var(--gold)' }} /></div>
          <div>
            {checklist.map((c, i) => (
              <div key={c.label} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: i ? '1px solid var(--line-2)' : 'none' }}>
                <span aria-hidden="true" style={{ flex: 'none', width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, background: c.done ? 'var(--green-soft)' : 'var(--surface-2)', color: c.done ? 'var(--green)' : 'var(--muted)', border: '1px solid var(--line)' }}>{c.done ? '✓' : i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ color: c.done ? 'var(--muted)' : 'var(--ink)', textDecoration: c.done ? 'line-through' : 'none' }}>{c.label}</b>
                  {!c.done && <span className="muted small" style={{ display: 'block' }}>{c.hint}</span>}
                </div>
                {!c.done && (
                  c.tab === 'studio'
                    ? <button type="button" className="btn small" onClick={onCreate}>{c.cta}</button>
                    : <button type="button" className="btn ghost small" onClick={() => onNavigate && onNavigate(c.tab)}>{c.cta}</button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {!loading && !hasTomorrow && !nudgeDismissed && (
        <div className="warn amber nudge" role="status">
          <IconClock size={17} />
          <div style={{ flex: 1 }}><b>Nothing scheduled for tomorrow</b><br />Schedule a post now and it will publish itself right on time.</div>
          <button type="button" className="btn small" onClick={onCreate}>Schedule a post</button>
          <button type="button" className="nudge-close" aria-label="Dismiss for today" onClick={dismissNudge}>✕</button>
        </div>
      )}
    </div>
  )
}
