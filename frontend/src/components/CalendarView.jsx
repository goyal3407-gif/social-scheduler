import { useMemo, useState } from 'react'
import { fmtDateTime } from '../api.js'
import { PostRow, Skeleton, Empty, MediaVisual } from './shared.jsx'

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function CalendarView({ posts, loading, onEdit, onDelete, onPublish, publishingId, onGoQueue, onCreate, onReconnect, onReschedule }) {
  const today = new Date()
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [selected, setSelected] = useState(today.toDateString())
  const [dragOverDay, setDragOverDay] = useState('')

  // D4: drag a scheduled post's chip onto another day to move it
  // (same time of day). Click-to-select-day is untouched; only
  // scheduled posts are draggable.
  const onChipDragStart = (e, p) => {
    try { e.dataTransfer.setData('text/kiluaai-post', p.id); e.dataTransfer.effectAllowed = 'move' } catch { /* drag unavailable */ }
  }
  const onDayDrop = (e, dayDate) => {
    e.preventDefault()
    setDragOverDay('')
    let id = ''
    try { id = e.dataTransfer.getData('text/kiluaai-post') } catch { /* no payload */ }
    if (!id || !onReschedule) return
    const post = (posts || []).find((p) => p.id === id)
    if (!post || post.status !== 'scheduled' || !post.scheduleTime) return
    const t = new Date(post.scheduleTime)
    const next = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), t.getHours(), t.getMinutes(), 0, 0)
    if (next.toDateString() === t.toDateString()) return
    onReschedule(post, { scheduleTime: next.toISOString() })
  }

  const cells = useMemo(() => {
    const y = cursor.getFullYear()
    const m = cursor.getMonth()
    const first = new Date(y, m, 1)
    // Monday-first grid
    const offset = (first.getDay() + 6) % 7
    const start = new Date(y, m, 1 - offset)
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  }, [cursor])

  const byDay = useMemo(() => {
    const map = {}
    for (const p of posts || []) {
      if (!p.scheduleTime) continue
      const k = new Date(p.scheduleTime).toDateString()
      if (!map[k]) map[k] = []
      map[k].push(p)
    }
    for (const k of Object.keys(map)) map[k].sort((a, b) => new Date(a.scheduleTime) - new Date(b.scheduleTime))
    return map
  }, [posts])

  const selectedPosts = byDay[selected] || []
  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const shift = (n) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1))

  return (
    <div>
      <h2 className="section-title">Calendar</h2>
      <p className="section-sub">Month view of everything scheduled. Tap a day to see its posts — on desktop you can also drag a scheduled post to another day.</p>
      <div className="card">
        <div className="card-head">
          <div><h2>{monthLabel}</h2><p>{(posts || []).length} posts in total</p></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn ghost small" onClick={() => shift(-1)}>← Prev</button>
            <button type="button" className="btn ghost small" onClick={() => { setCursor(new Date(today.getFullYear(), today.getMonth(), 1)); setSelected(today.toDateString()) }}>Today</button>
            <button type="button" className="btn ghost small" onClick={() => shift(1)}>Next →</button>
          </div>
        </div>
        {loading ? <Skeleton variant="calendar" /> : (
          <>
            <div className="cal-head">{DOW.map((d) => <span key={d}>{d}</span>)}</div>
            <div className="cal-grid">
              {cells.map((d) => {
                const k = d.toDateString()
                const dayPosts = byDay[k] || []
                const isToday = k === today.toDateString()
                const isOther = d.getMonth() !== cursor.getMonth()
                const nSched = dayPosts.filter((p) => p.status === 'scheduled' || p.status === 'draft').length
                const nPub = dayPosts.filter((p) => p.status === 'published').length
                const nFail = dayPosts.filter((p) => p.status === 'failed').length
                return (
                  <button key={k + d.getDate()} type="button" className={`cal-day ${isOther ? 'other' : ''} ${isToday ? 'today' : ''} ${dayPosts.length ? 'has' : ''}`} onClick={() => setSelected(k)} aria-label={`${d.toDateString()}, ${dayPosts.length} posts`}
                    onDragOver={(e) => { e.preventDefault(); if (dragOverDay !== k) setDragOverDay(k) }}
                    onDragLeave={() => { if (dragOverDay === k) setDragOverDay('') }}
                    onDrop={(e) => onDayDrop(e, d)}
                    style={dragOverDay === k ? { outline: '2px solid var(--gold, #e8c268)', outlineOffset: -2 } : undefined}>
                    <b>{d.getDate()}</b>
                    {dayPosts.length > 0 && (
                      <span className="cal-thumbs" aria-hidden="true">
                        {dayPosts.slice(0, 3).map((p) => (
                          <MediaVisual key={p.id} url={p.mediaUrl} kind={p.mediaType} posterUrl={p.posterUrl} />
                        ))}
                      </span>
                    )}
                    {dayPosts.length > 0 && (
                      <span className="cal-count">{dayPosts.length} post{dayPosts.length === 1 ? '' : 's'}{nSched ? ` · ${nSched} to go` : ''}{nPub ? ` · ${nPub} live` : ''}{nFail ? ` · ${nFail} failed` : ''}</span>
                    )}
                    {dayPosts.slice(0, 2).map((p) => (
                      <span key={p.id} className={`cal-chip ${p.status}`}
                        draggable={p.status === 'scheduled' && Boolean(onReschedule)}
                        onDragStart={p.status === 'scheduled' ? (e) => onChipDragStart(e, p) : undefined}
                        title={p.status === 'scheduled' ? 'Drag to another day to reschedule' : undefined}
                        style={p.status === 'scheduled' && onReschedule ? { cursor: 'grab' } : undefined}>{new Date(p.scheduleTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · {(p.caption || 'Post').slice(0, 18)}</span>
                    ))}
                    {dayPosts.length > 2 && <span className="cal-chip">+{dayPosts.length - 2} more</span>}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      <section className="card section">
        <div className="card-head">
          <div><h2>{new Date(selected).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2><p>{selectedPosts.length} post{selectedPosts.length === 1 ? '' : 's'}</p></div>
          {onGoQueue && <button type="button" className="btn ghost small" onClick={onGoQueue}>Open in Queue →</button>}
        </div>
        {selectedPosts.length === 0 ? (
          <Empty title="Nothing scheduled yet" body="No posts on this day. Schedule one and it will show up here and in your queue." action={onCreate ? <button type="button" className="btn primary small" onClick={onCreate}>Schedule a post</button> : undefined} />
        ) : selectedPosts.map((p) => (
          <PostRow key={p.id} post={p} onEdit={onEdit} onDelete={onDelete} onPublish={onPublish} publishing={publishingId === p.id} onReconnect={onReconnect} />
        ))}
        <p className="muted mt">Times shown in your local timezone. {fmtDateTime(selectedPosts[0]?.scheduleTime)}</p>
      </section>
    </div>
  )
}
