import { useMemo, useState } from 'react'
import { fmtDateTime } from '../api.js'
import { PostRow, Skeleton, Empty } from './shared.jsx'

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function CalendarView({ posts, loading, onEdit, onDelete, onPublish, publishingId }) {
  const today = new Date()
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [selected, setSelected] = useState(today.toDateString())

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
      <p className="section-sub">Month view of everything scheduled. Tap a day to see its posts.</p>
      <div className="card">
        <div className="card-head">
          <div><h2>{monthLabel}</h2><p>{(posts || []).length} posts in total</p></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn ghost small" onClick={() => shift(-1)}>← Prev</button>
            <button type="button" className="btn ghost small" onClick={() => { setCursor(new Date(today.getFullYear(), today.getMonth(), 1)); setSelected(today.toDateString()) }}>Today</button>
            <button type="button" className="btn ghost small" onClick={() => shift(1)}>Next →</button>
          </div>
        </div>
        {loading ? <Skeleton rows={4} /> : (
          <>
            <div className="cal-head">{DOW.map((d) => <span key={d}>{d}</span>)}</div>
            <div className="cal-grid">
              {cells.map((d) => {
                const k = d.toDateString()
                const dayPosts = byDay[k] || []
                const isToday = k === today.toDateString()
                const isOther = d.getMonth() !== cursor.getMonth()
                return (
                  <button key={k + d.getDate()} type="button" className={`cal-day ${isOther ? 'other' : ''} ${isToday ? 'today' : ''} ${dayPosts.length ? 'has' : ''}`} onClick={() => setSelected(k)} aria-label={`${d.toDateString()}, ${dayPosts.length} posts`}>
                    <b>{d.getDate()}</b>
                    {dayPosts.slice(0, 2).map((p) => (
                      <span key={p.id} className={`cal-chip ${p.status}`}>{new Date(p.scheduleTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · {(p.caption || 'Post').slice(0, 18)}</span>
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
        <div className="card-head"><div><h2>{new Date(selected).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2><p>{selectedPosts.length} post{selectedPosts.length === 1 ? '' : 's'}</p></div></div>
        {selectedPosts.length === 0 ? (
          <Empty title="Nothing on this day" body="Pick another day, or schedule a post for this one from Studio." />
        ) : selectedPosts.map((p) => (
          <PostRow key={p.id} post={p} onEdit={onEdit} onDelete={onDelete} onPublish={onPublish} publishing={publishingId === p.id} />
        ))}
        <p className="muted mt">Times shown in your local timezone. {fmtDateTime(selectedPosts[0]?.scheduleTime)}</p>
      </section>
    </div>
  )
}
