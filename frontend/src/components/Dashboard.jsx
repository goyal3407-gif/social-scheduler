import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { api, dailyPlan, fmtDateTime, formatCountdown, openInstagramDirectConnect } from '../api.js'
import { PostRow, Skeleton, ErrorBox, Empty } from './shared.jsx'
import { IconClock, IconPlay } from './icons.jsx'

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

const PlanCard = lazy(() => import('./PlanCard.jsx'))

export default function Dashboard({ posts, media, user, stats, loading, error, onRetry, onCreate, onGoQueue, onNavigate, onEdit, onDelete, onPublish, publishingId, settings, onDuplicate, onPostAgain, onReschedule, onRescheduleNextBest, onDismissChecklist, overdue, onPublishDue, notifications, onReconnect, tr, onSearch }) {
  const t = tr || ((k) => k)
  // Home search pill (D3 refinement): routes into the same global
  // search as the top nav — Queue filtered by caption, Media by name.
  const [homeQ, setHomeQ] = useState('')
  // Publishing streak (real data only): consecutive days with at least one
  // published post, ending today or yesterday.
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
  // steps are done.
  const checklist = useMemo(() => [
    { done: Boolean(settings?.instagramConnected), label: 'Connect Instagram', hint: 'So your posts can publish live', tab: 'settings', cta: 'Connect' },
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
  // D1: posts per day for the last 14 days (published + scheduled by
  // their scheduleTime) — a tiny theme-aware bar chart, no libraries.
  const chart14 = useMemo(() => {
    const days = []
    const now = new Date()
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i)
      days.push({ key: d.toDateString(), label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), count: 0, today: i === 0 })
    }
    const byKey = new Map(days.map((d) => [d.key, d]))
    for (const p of posts || []) {
      if (!p.scheduleTime || (p.status !== 'published' && p.status !== 'scheduled')) continue
      const slot = byKey.get(new Date(p.scheduleTime).toDateString())
      if (slot) slot.count++
    }
    const max = Math.max(1, ...days.map((d) => d.count))
    return { days, max }
  }, [posts])
  const postedThisWeek = useMemo(() => {
    const now = Date.now()
    return (posts || []).filter((p) => p.status === 'published' && p.scheduleTime && new Date(p.scheduleTime).getTime() <= now && new Date(p.scheduleTime).getTime() >= now - 7 * 86400000).length
  }, [posts])
  const upcoming = useMemo(() => {
    const now = Date.now()
    return [...(posts || [])]
      .filter((p) => p.status === 'scheduled' && p.scheduleTime && new Date(p.scheduleTime).getTime() >= now - 60000)
      .sort((a, b) => new Date(a.scheduleTime) - new Date(b.scheduleTime))
  }, [posts])
  const next = upcoming[0]
  const cd = useCountdown(next?.scheduleTime)
  const plan = useMemo(() => dailyPlan(posts, 8), [posts])
  const recent = useMemo(() => [...(posts || [])].sort((a, b) => new Date(b.createdAt || b.scheduleTime || 0) - new Date(a.createdAt || a.scheduleTime || 0)).slice(0, 5), [posts])
  const s = stats || {}
  const weekCount = useMemo(() => {
    const now = Date.now()
    return (posts || []).filter((p) => p.scheduleTime && new Date(p.scheduleTime).getTime() >= now && new Date(p.scheduleTime).getTime() < now + 7 * 86400000).length
  }, [posts])
  const failedPosts = useMemo(() => [...(posts || [])]
    .filter((p) => p.status === 'failed')
    .sort((a, b) => new Date(b.failedAt || b.scheduleTime || 0) - new Date(a.failedAt || a.scheduleTime || 0)), [posts])
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
  const [reconnectBusy, setReconnectBusy] = useState(false)
  const startReconnect = async () => {
    setReconnectBusy(true)
    try { await openInstagramDirectConnect() } finally { setReconnectBusy(false) }
  }
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
    const t = new Date(); t.setDate(t.getDate() + 1)
    const key = t.toDateString()
    return (posts || []).some((p) => p.status === 'scheduled' && p.scheduleTime && new Date(p.scheduleTime).toDateString() === key)
  }, [posts])

  return (
    <div>
      <Suspense fallback={null}><PlanCard /></Suspense>
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

      <div className="stats stats-3" aria-label="Overview">
        {loading ? Array.from({ length: 3 }).map((_, i) => <div key={i} className="skel" style={{ height: 92 }} />) : (
          <>
            <div className="stat"><b>{s.scheduled ?? upcoming.length}</b><span>{t('scheduled')}</span><small>{weekCount} in the next 7 days</small></div>
            <div className="stat"><b>{s.published ?? (posts || []).filter((p) => p.status === 'published').length}</b><span>{t('published')}</span><small>{postedThisWeek} this week{streak > 0 ? ` · ${streak}-day streak` : ''}</small></div>
            <div className="stat"><b>{s.total ?? (posts || []).length}</b><span>{t('totalPosts')}</span><small>{s.mediaCount ?? (media || []).length} media in library</small></div>
          </>
        )}
      </div>

      {!loading && (
        <div className="card" style={{ padding: '14px 16px', marginTop: 12 }} aria-label="Posts per day, last 14 days">
          <p className="small" style={{ margin: '0 0 10px' }}><b>Last 14 days</b> <span className="muted">— posts per day (published + scheduled)</span></p>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 64 }} role="img" aria-label={chart14.days.map((d) => `${d.label}: ${d.count}`).join(', ')}>
            {chart14.days.map((d) => (
              <div key={d.key} title={`${d.label}: ${d.count} post${d.count === 1 ? '' : 's'}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
                <div style={{ width: '100%', maxWidth: 26, height: `${Math.max(4, Math.round((d.count / chart14.max) * 44))}px`, borderRadius: '4px 4px 0 0', background: d.today ? 'var(--gold, #e8c268)' : 'var(--accent, #7c8cff)', opacity: d.count ? 1 : 0.25 }} />
                <span className="muted" style={{ fontSize: 9 }}>{d.label.split(' ')[0]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && (
        <div className="ig-row" role="status">
          <span className={`dot ${settings ? (brokenIg.length > 0 || !settings.instagramConnected ? 'off' : '') : 'amber'}`} aria-hidden="true" />
          <div className="grow">
            <b>Instagram: </b>
            {!settings ? 'Checking connection…' : brokenIg.length > 0 ? <>Connection broken{brokenIg[0] ? ` for @${brokenIg[0]}` : ''} — reconnect so your scheduled posts can publish.</> : settings.instagramConnected ? <>Connected{settings.instagramHandle ? ` as @${settings.instagramHandle}` : ''} — publishing is ready.</> : 'Not connected yet — connect Instagram to publish live.'}
            {settings?.instagramConnected && brokenIg.length === 0 && <span className="muted small" style={{ display: 'block' }}>Token is stored on the server only — it is never shown in this app.</span>}
          </div>
          {settings && brokenIg.length > 0 && <button type="button" className="btn primary small" disabled={reconnectBusy} onClick={startReconnect}>{reconnectBusy ? 'Opening…' : 'Reconnect'}</button>}
          {settings && !settings.instagramConnected && brokenIg.length === 0 && <button type="button" className="btn ghost small" onClick={() => onNavigate && onNavigate('settings')}>Open Settings</button>}
        </div>
      )}

      {error && <ErrorBox error={error} onRetry={onRetry} />}

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
            {notifications.slice(0, 8).map((n) => (
              <p key={n.id} className="small" style={{ padding: '6px 0', color: n.read ? 'var(--muted)' : 'var(--ink)' }}>
                {n.type === 'publish-success' ? '✅ ' : '⚠️ '}<b>{n.type === 'publish-success' ? 'Published' : 'Publish problem'}</b>
                <span className="muted"> · {fmtDateTime(n.createdAt)}</span>
                <br /><span>{String(n.message || '').replace(/^Publish (failed|ed)[^:]*: /, '')}</span>
              </p>
            ))}
          </div>
        </section>
      )}

      {!loading && !checklistDismissed && !checklistDone && (
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

      <section className="card section" aria-label="Daily plan">
        <div className="card-head">
          <div><h2>Daily plan — today + next 7 days</h2><p>Scheduled posts per day, from your saved posts. {next ? `Next post due ${fmtDateTime(next.scheduleTime)}.` : 'No post due yet.'}</p></div>
          <button type="button" className="btn ghost small" onClick={onGoQueue}>Queue →</button>
        </div>
        {loading ? <Skeleton rows={3} /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Day</th><th>Scheduled posts</th><th>Next post due</th></tr></thead>
              <tbody>
                {plan.map((d, i) => {
                  const dayPosts = [...(posts || [])]
                    .filter((p) => p.status === 'scheduled' && p.scheduleTime && new Date(p.scheduleTime).toDateString() === d.date.toDateString())
                    .sort((a, b) => new Date(a.scheduleTime) - new Date(b.scheduleTime))
                  return (
                    <tr key={d.date.toDateString()} style={i === 0 ? { background: 'var(--surface-2)' } : undefined}>
                      <td><b>{d.label}</b></td>
                      <td>{d.count === 0 ? '—' : `${d.count} post${d.count === 1 ? '' : 's'}`}</td>
                      <td>{dayPosts[0] ? fmtDateTime(dayPosts[0].scheduleTime) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="two-col section">
        <section className="card">
          <div className="card-head">
            <div><h2>{t('upNext')}</h2><p>Your next scheduled posts, in order.</p></div>
            <button type="button" className="btn ghost small" onClick={onGoQueue}>Queue →</button>
          </div>
          {loading ? <Skeleton variant="posts" rows={3} /> : upcoming.length === 0 ? (
            <Empty title="Nothing scheduled yet" body="No posts are scheduled. Schedule one from Studio or Bulk and it will show up here, soonest first." action={<button type="button" className="btn primary small" onClick={onCreate}>Create a post</button>} />
          ) : upcoming.slice(0, 4).map((p) => (
            <PostRow key={p.id} post={p} onEdit={onEdit} onDelete={onDelete} onPublish={onPublish} publishing={publishingId === p.id} onDuplicate={onDuplicate} onPostAgain={onPostAgain} onReschedule={onReschedule} onRescheduleNextBest={onRescheduleNextBest} onReconnect={onReconnect} />
          ))}
        </section>

        <section className="card">
          <div className="card-head"><div><h2>Recent activity</h2><p>Latest posts you created or edited.</p></div></div>
          {loading ? <Skeleton variant="posts" rows={3} /> : recent.length === 0 ? (
            <Empty title="No posts yet" body="Your recent posts will appear here once you create one." />
          ) : recent.map((p) => (
            <PostRow key={p.id} post={p} onEdit={onEdit} onDelete={onDelete} onPublish={onPublish} publishing={publishingId === p.id} onPostAgain={onPostAgain} onReconnect={onReconnect} />
          ))}
        </section>
      </div>

      <section className="card section">
        <div className="card-head"><div><h2>How it works</h2><p>Three steps, no learning curve.</p></div></div>
        <div className="three-col">
          <div><b>1 · Add media</b><p className="muted mt" style={{ marginTop: 6 }}>Upload a video or image, or paste a link. Your library keeps everything organised by folder and tag.</p></div>
          <div><b>2 · Write &amp; schedule</b><p className="muted" style={{ marginTop: 6 }}>Studio scores your caption, checks your hashtags and warns you before a vertical video goes out as a Feed post.</p></div>
          <div><b>3 · Publish or queue</b><p className="muted" style={{ marginTop: 6 }}>Publish now, or let the queue handle it at the time you picked — 7pm, 9pm, whenever your audience is online.</p></div>
        </div>
        <p className="muted mt"><IconPlay size={14} /> Free forever. No trial, no card, no locked features.</p>
      </section>
    </div>
  )
}
