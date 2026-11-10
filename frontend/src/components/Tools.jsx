import { Fragment, useMemo, useState } from 'react'
import { fmtDateTime } from '../api.js'

const HASHTAG_VAULT = [
  { tag: '#contentcreator', reach: 'High', cat: 'Growth' },
  { tag: '#reelsinstagram', reach: 'High', cat: 'Growth' },
  { tag: '#socialmediatips', reach: 'Medium', cat: 'Tips' },
  { tag: '#creatorlife', reach: 'Medium', cat: 'Lifestyle' },
  { tag: '#smallbusiness', reach: 'High', cat: 'Business' },
  { tag: '#digitalmarketing', reach: 'High', cat: 'Business' },
  { tag: '#behindthescenes', reach: 'Medium', cat: 'Lifestyle' },
  { tag: '#learnontiktok', reach: 'Medium', cat: 'Tips' },
  { tag: '#viralreels', reach: 'High', cat: 'Growth' },
  { tag: '#motivationdaily', reach: 'Medium', cat: 'Lifestyle' },
  { tag: '#workfromanywhere', reach: 'Medium', cat: 'Lifestyle' },
  { tag: '#marketingtips', reach: 'Medium', cat: 'Tips' }
]
const HOOKS = [
  'Stop scrolling — this changes everything about…',
  'Nobody talks about this, but…',
  'I wish someone told me this sooner…',
  '3 mistakes you are making with… (and how to fix them)',
  'POV: you finally figured out…',
  'The truth about… that no one will tell you',
  'Save this — you will need it later.',
  'Watch until the end, the last one is the best.',
  'If you are struggling with…, this is for you.',
  'Day 1 of… — follow along.'
]
const CONTENT_BANK = [
  { title: 'Tip of the day', text: 'One small thing you can do today to move closer to your goal. Keep it simple, keep it doable.' },
  { title: 'Myth vs reality', text: 'A common myth in your niche, then the reality — with one example that proves it.' },
  { title: 'Before / after', text: 'Where you started vs where you are now. People love progress stories.' },
  { title: 'Ask the audience', text: 'A question your followers actually want to answer. Reply to every comment.' },
  { title: 'Behind the scenes', text: 'Show the messy middle — the setup, the outtakes, the real work.' },
  { title: 'Quick tutorial', text: 'Teach one thing in under 60 seconds. End with “save this for later”.' }
]
// Illustrative best-times guide — shown ONLY when the user has too few
// of their own timed posts to build a real pattern from.
const GUIDE_HEATMAP = [
  // rows: Mon..Sun, cols: 6a 9a 12p 3p 5p 7p 9p  (0-4 strength)
  [1, 2, 2, 1, 2, 4, 3], [1, 2, 3, 2, 2, 4, 3], [2, 2, 2, 1, 3, 4, 4],
  [1, 3, 2, 2, 2, 3, 4], [2, 2, 3, 2, 3, 4, 3], [2, 3, 3, 3, 3, 3, 2],
  [2, 2, 3, 2, 2, 3, 2]
]
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const HOURS = ['6am', '9am', '12pm', '3pm', '5pm', '7pm', '9pm']

function copyText(text, setCopied) {
  const done = () => { setCopied(text); setTimeout(() => setCopied(''), 1600) }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
  else fallbackCopy(text, done)
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea')
  ta.value = text; document.body.appendChild(ta); ta.select()
  try { document.execCommand('copy'); done() } catch { /* clipboard unavailable */ }
  document.body.removeChild(ta)
}

export default function Tools({ posts, stats, templates, onCreateTemplate, onUseTemplate }) {
  const [tool, setTool] = useState('analytics')
  const [copied, setCopied] = useState('')
  const [vaultCat, setVaultCat] = useState('All')
  const [vaultQ, setVaultQ] = useState('')
  const [tplName, setTplName] = useState('')
  const [tplText, setTplText] = useState('')
  const [tplMsg, setTplMsg] = useState('')
  const [replyTone, setReplyTone] = useState('Friendly')
  const [replyComment, setReplyComment] = useState('')
  const [replyDraft, setReplyDraft] = useState('')

  const s = stats || {}
  const byPlatform = useMemo(() => {
    const m = {}
    for (const p of posts || []) { const k = p.platform || 'Instagram'; m[k] = (m[k] || 0) + 1 }
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [posts])
  const byStatus = useMemo(() => {
    const m = { scheduled: 0, published: 0, draft: 0, failed: 0 }
    for (const p of posts || []) if (m[p.status] != null) m[p.status]++
    return m
  }, [posts])
  const total = Math.max(1, (posts || []).length)
  const maxPlatform = Math.max(1, ...byPlatform.map(([, v]) => v))
  const weekAhead = useMemo(() => {
    const now = Date.now()
    const days = Array.from({ length: 7 }, (_, i) => ({ date: new Date(now + i * 86400000), count: 0 }))
    for (const p of posts || []) {
      if (!p.scheduleTime) continue
      const d = new Date(p.scheduleTime)
      const idx = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 86400000)
      if (idx >= 0 && idx < 7) days[idx].count++
    }
    return days
  }, [posts])
  const maxWeek = Math.max(1, ...weekAhead.map((d) => d.count))

  const vault = HASHTAG_VAULT.filter((h) => (vaultCat === 'All' || h.cat === vaultCat) && h.tag.toLowerCase().includes(vaultQ.toLowerCase()))

  // Best-time heatmap from the user's OWN posts (real data): counts of
  // scheduled/published posts by weekday × hour bucket, scaled 0–4. With
  // fewer than 10 timed posts the pattern is noise, so the general guide
  // is shown instead — labelled as a guide.
  const HOUR_BUCKETS = [6, 9, 12, 15, 17, 19, 21]
  const heatmap = useMemo(() => {
    const timed = (posts || []).filter((p) => p.scheduleTime && (p.status === 'scheduled' || p.status === 'published'))
    if (timed.length < 10) return { grid: GUIDE_HEATMAP, real: false, count: timed.length }
    const counts = Array.from({ length: 7 }, () => Array(7).fill(0))
    for (const p of timed) {
      const d = new Date(p.scheduleTime)
      if (Number.isNaN(d.getTime())) continue
      const row = (d.getDay() + 6) % 7 // Monday-first
      const h = d.getHours()
      let col = 0
      for (let i = 0; i < HOUR_BUCKETS.length; i++) if (h >= HOUR_BUCKETS[i]) col = i
      counts[row][col]++
    }
    const max = Math.max(1, ...counts.flat())
    return { grid: counts.map((row) => row.map((v) => Math.round((v / max) * 4))), real: true, count: timed.length }
  }, [posts])

  // Why did publishes fail? Grouped from the stored lastPublishError.
  const failureReasons = useMemo(() => {
    const m = {}
    for (const p of posts || []) {
      if (p.status !== 'failed' || !p.lastPublishError) continue
      const e = p.lastPublishError
      const key = /token|expired|invalid/i.test(e) ? 'Instagram token invalid or expired'
        : /format|process|MP4|JPG/i.test(e) ? 'Media format / processing'
        : /reach|connection|network/i.test(e) ? 'Could not reach Instagram'
        : 'Other Instagram error'
      m[key] = (m[key] || 0) + 1
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [posts])

  const makeReply = () => {
    const c = replyComment.trim()
    if (!c) { setReplyDraft(''); return }
    const openers = {
      Friendly: 'Thank you so much — really appreciate you watching!',
      Professional: 'Thanks for your comment — glad this was helpful.',
      Playful: 'You get it! This one was fun to make.',
      Grateful: 'Thank you — comments like this keep me going.'
    }
    setReplyDraft(`${openers[replyTone] || openers.Friendly} ${c.length > 60 ? 'Great point — I will cover that in a future video.' : 'Let me know what you would like to see next!'}`)
  }

  const saveTemplate = async (e) => {
    e.preventDefault()
    if (!tplName.trim() || !tplText.trim()) return
    await onCreateTemplate({ name: tplName.trim(), text: tplText.trim() })
    setTplMsg('Template saved — find it in Studio too.')
    setTplName(''); setTplText('')
    setTimeout(() => setTplMsg(''), 3000)
  }

  const tabs = [
    ['analytics', 'Analytics'], ['hashtags', 'Hashtag vault'], ['hooks', 'Hooks'],
    ['bank', 'Content bank'], ['besttime', 'Best time'], ['replies', 'Reply helper'], ['templates', 'Templates']
  ]

  return (
    <div>
      <h2 className="section-title">Tools</h2>
      <p className="section-sub">Everything around scheduling — numbers, ideas and words that save you time.</p>
      <div className="tabs mb" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" className={`tab ${tool === id ? 'active' : ''}`} onClick={() => setTool(id)}>{label}</button>
        ))}
      </div>
      {copied && <div className="alert success">Copied: {copied}</div>}

      {tool === 'analytics' && (
        <div className="two-col" style={{ alignItems: 'start' }}>
          <section className="card">
            <h2>Your schedule at a glance</h2>
            <p className="muted small mb">Counts from your posts — no guessing.</p>
            <div className="bar-row"><span>Scheduled</span><div className="bar-track"><div className="bar-fill" style={{ width: `${(byStatus.scheduled / total) * 100}%` }} /></div><b>{byStatus.scheduled}</b></div>
            <div className="bar-row"><span>Published</span><div className="bar-track"><div className="bar-fill" style={{ width: `${(byStatus.published / total) * 100}%` }} /></div><b>{byStatus.published}</b></div>
            <div className="bar-row"><span>Drafts</span><div className="bar-track"><div className="bar-fill" style={{ width: `${(byStatus.draft / total) * 100}%` }} /></div><b>{byStatus.draft}</b></div>
            <div className="bar-row"><span>Failed</span><div className="bar-track"><div className="bar-fill" style={{ width: `${(byStatus.failed / total) * 100}%` }} /></div><b>{byStatus.failed}</b></div>
            <p className="muted small mt">Total posts: {posts?.length || 0} · Media files: {s.mediaCount ?? '—'}</p>
            {failureReasons.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <h3>Why publishes failed</h3>
                {failureReasons.map(([reason, n]) => (
                  <div key={reason} className="bar-row"><span>{reason}</span><div className="bar-track"><div className="bar-fill" style={{ width: `${(n / Math.max(1, byStatus.failed)) * 100}%` }} /></div><b>{n}</b></div>
                ))}
                <p className="muted small mt">Token errors: reconnect in Settings. Media errors: use a standard MP4 (H.264) or JPG, and Reels format for vertical video.</p>
              </div>
            )}
            <h3 style={{ marginTop: 20 }}>Posts per platform</h3>
            {byPlatform.length === 0 ? <p className="muted small mt">No posts yet.</p> : byPlatform.map(([name, v]) => (
              <div key={name} className="bar-row"><span>{name}</span><div className="bar-track"><div className="bar-fill" style={{ width: `${(v / maxPlatform) * 100}%` }} /></div><b>{v}</b></div>
            ))}
          </section>
          <section className="card">
            <h2>Next 7 days</h2>
            <p className="muted small mb">Scheduled posts per day.</p>
            {weekAhead.map((d) => (
              <div key={d.date.toDateString()} className="bar-row">
                <span>{d.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${(d.count / maxWeek) * 100}%` }} /></div>
                <b>{d.count}</b>
              </div>
            ))}
            <p className="muted small mt">Quiet day? That is a good day to batch-record. Aim for consistency over volume.</p>
          </section>
        </div>
      )}

      {tool === 'hashtags' && (
        <section className="card">
          <h2>Hashtag vault</h2>
          <p className="muted small mb">Tap to copy. Mix 2–3 big tags with smaller, specific ones — and stay under 30 per post.</p>
          <div className="toolbar">
            <input type="search" placeholder="Search hashtags…" value={vaultQ} onChange={(e) => setVaultQ(e.target.value)} aria-label="Search hashtags" />
            <select value={vaultCat} onChange={(e) => setVaultCat(e.target.value)} aria-label="Filter by category">
              {['All', 'Growth', 'Tips', 'Business', 'Lifestyle'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button type="button" className="btn ghost small" onClick={() => copyText(vault.map((h) => h.tag).join(' '), setCopied)}>Copy all shown</button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {vault.map((h) => (
              <button key={h.tag} type="button" className="chip" style={{ padding: '8px 13px', fontSize: 13 }} onClick={() => copyText(h.tag, setCopied)} title={`${h.cat} · ${h.reach} reach`}>
                {h.tag} <span className="muted">· {h.reach}</span>
              </button>
            ))}
            {vault.length === 0 && <p className="muted">No hashtags match that search.</p>}
          </div>
        </section>
      )}

      {tool === 'hooks' && (
        <section className="card">
          <h2>Hooks library</h2>
          <p className="muted small mb">First 3 seconds decide everything. Tap any hook to copy it, then finish it in your own words.</p>
          {HOOKS.map((h) => (
            <div key={h} className="hook-item"><div className="row"><span>“{h}”</span><button type="button" className="copy-btn" onClick={() => copyText(h, setCopied)}>Copy</button></div></div>
          ))}
        </section>
      )}

      {tool === 'bank' && (
        <section className="card">
          <h2>Content bank</h2>
          <p className="muted small mb">Six post ideas you can reuse every week. Tap “Use” to start a post from one in Studio.</p>
          {CONTENT_BANK.map((item) => (
            <div key={item.title} className="bank-item">
              <div className="row"><div><b>{item.title}</b><p className="muted small" style={{ marginTop: 4 }}>{item.text}</p></div><button type="button" className="copy-btn" onClick={() => onUseTemplate && onUseTemplate({ text: item.text })}>Use</button></div>
            </div>
          ))}
        </section>
      )}

      {tool === 'besttime' && (
        <section className="card">
          <h2>Best-time heatmap</h2>
          <p className="muted small mb">{heatmap.real
            ? `Built from your own ${heatmap.count} scheduled/published posts — darker cells are the times you actually post most. It shows your pattern, not measured audience reach (Instagram does not share that with this app).`
            : 'A general guide for when audiences are usually online — evenings, especially 7–9pm, tend to be strongest. Schedule 10+ posts and this heatmap switches to your own posting pattern.'}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr', gap: 6, alignItems: 'start' }}>
            <div />
            <div className="heatmap" style={{ marginBottom: 5 }}>{HOURS.map((h) => <span key={h} style={{ fontSize: 10.5, textAlign: 'center', color: 'var(--muted)', fontWeight: 700 }}>{h}</span>)}</div>
            {heatmap.grid.map((row, i) => (
              <Fragment key={DAYS[i]}>
                <span style={{ fontSize: 12, fontWeight: 700, paddingTop: 6 }}>{DAYS[i]}</span>
                <div className="heatmap">{row.map((v, j) => <div key={j} className={`heat heat-${v}`} title={`${DAYS[i]} ${HOURS[j]} — strength ${v}/4`}>{v >= 3 ? '●' : ''}</div>)}</div>
              </Fragment>
            ))}
          </div>
          <p className="muted small mt">{heatmap.real ? 'Your posting pattern — darker = you post there more often.' : 'Darker = usually busier. This is a guide, not measured data from your account.'}</p>
        </section>
      )}

      {tool === 'replies' && (
        <section className="card">
          <h2>Reply helper</h2>
          <p className="muted small mb">Paste a comment, pick a tone, get a warm reply draft. Edit it in your own voice before sending — never auto-reply.</p>
          <label htmlFor="replyComment">Their comment</label>
          <textarea id="replyComment" rows={3} placeholder="e.g. This helped me so much, thank you!" value={replyComment} onChange={(e) => setReplyComment(e.target.value)} />
          <label htmlFor="replyTone" style={{ marginTop: 12 }}>Tone</label>
          <select id="replyTone" value={replyTone} onChange={(e) => setReplyTone(e.target.value)}>
            {['Friendly', 'Professional', 'Playful', 'Grateful'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="button" className="btn primary mt" onClick={makeReply}>Draft a reply</button>
          {replyDraft && (
            <div className="mt">
              <label>Your draft reply</label>
              <div className="hook-item">{replyDraft}</div>
              <button type="button" className="copy-btn" onClick={() => copyText(replyDraft, setCopied)}>Copy reply</button>
            </div>
          )}
        </section>
      )}

      {tool === 'templates' && (
        <div className="two-col" style={{ alignItems: 'start' }}>
          <form className="card" onSubmit={saveTemplate}>
            <h2>New template</h2>
            <p className="muted small mb">Save a caption you reuse often.</p>
            <label htmlFor="tplName">Name</label>
            <input id="tplName" placeholder="e.g. Weekly tip" value={tplName} onChange={(e) => setTplName(e.target.value)} />
            <label htmlFor="tplText" style={{ marginTop: 12 }}>Text</label>
            <textarea id="tplText" rows={5} placeholder="Your reusable caption…" value={tplText} onChange={(e) => setTplText(e.target.value)} />
            {tplMsg && <div className="alert success">{tplMsg}</div>}
            <button type="submit" className="btn primary mt" disabled={!tplName.trim() || !tplText.trim()}>Save template</button>
          </form>
          <section className="card">
            <h2>Your templates</h2>
            <p className="muted small mb">{(templates || []).length} saved.</p>
            {(!templates || templates.length === 0) ? <p className="muted">No templates yet — save one on the left.</p> : templates.map((t) => (
              <div key={t.id} className="bank-item">
                <div className="row"><div><b>{t.name}</b><p className="muted small" style={{ marginTop: 4 }}>{t.text}</p></div><button type="button" className="copy-btn" onClick={() => onUseTemplate && onUseTemplate(t)}>Use</button></div>
              </div>
            ))}
          </section>
        </div>
      )}
      <p className="muted small mt">Analytics here count your scheduled and published posts. Platform reach, likes and follower stats are not available until the server reports real insights — the numbers above never invent them.</p>
    </div>
  )
}
