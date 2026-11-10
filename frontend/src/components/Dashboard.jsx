import { useEffect, useMemo, useState } from 'react'
import { fmtDateTime, formatCountdown } from '../api.js'
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

export default function Dashboard({ posts, stats, loading, error, onRetry, onCreate, onGoQueue, onEdit, onDelete, onPublish, publishingId, settings }) {
  const upcoming = useMemo(() => {
    const now = Date.now()
    return [...(posts || [])]
      .filter((p) => p.status === 'scheduled' && p.scheduleTime && new Date(p.scheduleTime).getTime() >= now - 60000)
      .sort((a, b) => new Date(a.scheduleTime) - new Date(b.scheduleTime))
  }, [posts])
  const next = upcoming[0]
  const cd = useCountdown(next?.scheduleTime)
  const recent = useMemo(() => [...(posts || [])].sort((a, b) => new Date(b.createdAt || b.scheduleTime || 0) - new Date(a.createdAt || a.scheduleTime || 0)).slice(0, 5), [posts])
  const s = stats || {}
  const weekCount = useMemo(() => {
    const now = Date.now()
    return (posts || []).filter((p) => p.scheduleTime && new Date(p.scheduleTime).getTime() >= now && new Date(p.scheduleTime).getTime() < now + 7 * 86400000).length
  }, [posts])

  return (
    <div>
      <section className="hero" aria-label="Next scheduled post">
        <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', opacity: .85 }}>Next up</p>
        {loading ? (
          <div style={{ marginTop: 14 }}><div className="skel" style={{ height: 34, width: '60%', background: 'rgba(255,255,255,.25)' }} /><div className="skel" style={{ height: 16, width: '45%', marginTop: 10, background: 'rgba(255,255,255,.22)' }} /></div>
        ) : next ? (
          <>
            <h1>{next.caption ? (next.caption.length > 90 ? `${next.caption.slice(0, 90)}…` : next.caption) : 'Untitled post'}</h1>
            <p>{next.platform || 'Instagram'} · {next.format || 'REELS'} · {fmtDateTime(next.scheduleTime)}{next.hashtags ? ` · ${next.hashtags}` : ''}</p>
            <div className="hero-row">
              <div className="countdown" aria-label={`Publishes in ${cd.label}`}>
                <div className="cd"><b>{cd.parts?.d ?? 0}</b><span>days</span></div>
                <div className="cd"><b>{cd.parts?.h ?? 0}</b><span>hours</span></div>
                <div className="cd"><b>{cd.parts?.m ?? 0}</b><span>mins</span></div>
              </div>
              <div className="hero-cta">
                <button type="button" className="btn light" onClick={() => onPublish && onPublish(next)} disabled={publishingId === next.id}>Publish now</button>
                <button type="button" className="btn outline-light" onClick={onGoQueue}>View queue</button>
              </div>
            </div>
          </>
        ) : (
          <>
            <h1>Nothing scheduled yet — let&apos;s fix that.</h1>
            <p>Create your first post in Studio, or import a whole week at once with Bulk scheduling. It&apos;s free, forever.</p>
            <div className="hero-row">
              <div className="hero-cta"><button type="button" className="btn light" onClick={onCreate}>Create your first post</button></div>
            </div>
          </>
        )}
      </section>

      {error && <ErrorBox error={error} onRetry={onRetry} />}

      <div className="stats" aria-label="Overview">
        {loading ? Array.from({ length: 5 }).map((_, i) => <div key={i} className="skel" style={{ height: 92 }} />) : (
          <>
            <div className="stat"><b>{s.scheduled ?? upcoming.length}</b><span>Scheduled</span><small>{weekCount} in the next 7 days</small></div>
            <div className="stat"><b>{s.published ?? 0}</b><span>Published</span><small>All time</small></div>
            <div className="stat"><b>{s.drafts ?? 0}</b><span>Drafts</span><small>Waiting for a time</small></div>
            <div className="stat"><b>{s.failed ?? 0}</b><span>Failed</span><small>Needs a retry</small></div>
            <div className="stat"><b>{s.mediaCount ?? 0}</b><span>Media files</span><small>In your library</small></div>
          </>
        )}
      </div>

      <div className="two-col section">
        <section className="card">
          <div className="card-head">
            <div><h2>Coming up</h2><p>Your next scheduled posts, in order.</p></div>
            <button type="button" className="btn ghost small" onClick={onGoQueue}>Queue →</button>
          </div>
          {loading ? <Skeleton rows={3} /> : upcoming.length === 0 ? (
            <Empty title="Queue is clear" body="No posts are scheduled. Schedule one from Studio or Bulk and it will show up here with a countdown." action={<button type="button" className="btn primary small" onClick={onCreate}>Create a post</button>} />
          ) : upcoming.slice(0, 4).map((p) => (
            <PostRow key={p.id} post={p} onEdit={onEdit} onDelete={onDelete} onPublish={onPublish} publishing={publishingId === p.id} />
          ))}
        </section>

        <section className="card">
          <div className="card-head"><div><h2>Recent activity</h2><p>Latest posts you created or edited.</p></div></div>
          {loading ? <Skeleton rows={3} /> : recent.length === 0 ? (
            <Empty title="No posts yet" body="Your recent posts will appear here once you create one." />
          ) : recent.map((p) => (
            <PostRow key={p.id} post={p} onEdit={onEdit} onDelete={onDelete} onPublish={onPublish} publishing={publishingId === p.id} />
          ))}
          <div className="warn blue" style={{ marginTop: 14 }}>
            <IconClock size={17} />
            <div><b>Instagram status: </b>{settings?.instagramConnected ? `Connected${settings.instagramHandle ? ` as @${settings.instagramHandle}` : ''}. Publishing is ready.` : 'Not connected yet — add your access token in Settings to publish live.'}</div>
          </div>
          {settings?.instagramConnected && (
            <p className="muted mt">Token is stored on the server only — it is never shown in this app.</p>
          )}
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
