import { useEffect, useMemo, useState } from 'react'
import { captionScore, countHashtags, fromLocalInputValue, nextBestTime, toLocalInputValue } from '../api.js'
import { IconWarn, IconCheck } from './icons.jsx'

const PLATFORMS = ['Instagram', 'YouTube', 'Facebook', 'TikTok']
const FORMATS = ['REELS', 'FEED', 'STORY']
const EMPTY = { mediaUrl: '', mediaType: 'video', caption: '', hashtags: '', cta: '', platform: 'Instagram', scheduleTime: '', status: 'scheduled', format: 'REELS' }

export default function Studio({ editing, seed, media, templates, onSave, onCancel, saving, posts }) {
  const [form, setForm] = useState(EMPTY)
  const [step, setStep] = useState(1)
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [error, setError] = useState('')
  const [savedNote, setSavedNote] = useState('')

  useEffect(() => {
    if (editing?.id) {
      setForm({ ...EMPTY, ...editing, scheduleTime: editing.scheduleTime || '' })
    } else if (seed) {
      setForm({ ...EMPTY, ...seed, scheduleTime: seed.scheduleTime || '' })
    } else {
      setForm(EMPTY)
    }
    setStep(1); setError(''); setSavedNote('')
  }, [editing, seed])

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const nTags = countHashtags(form.hashtags)
  const score = captionScore(form.caption, form.hashtags, form.cta)
  const ratio = width && height ? (Number(width) / Number(height)) : null
  const isVertical = ratio !== null && Math.abs(ratio - 0.56) < 0.03
  const reelSafe = form.format === 'REELS' && isVertical
  const feedVerticalWarn = form.format === 'FEED' && isVertical

  const canSave = useMemo(() => {
    if (!form.mediaUrl.trim()) return false
    if (!form.scheduleTime) return false
    return true
  }, [form])
  // Drafts are plans: they save with media alone, no time needed (the
  // server allows timeless drafts — the old UI blocked them).
  const canSaveDraft = useMemo(() => Boolean(form.mediaUrl.trim()), [form])

  // Warn when this media is already scheduled, and when another post sits
  // within 30 minutes of the chosen time.
  const duplicateOf = useMemo(() => {
    if (!form.mediaUrl.trim()) return null
    return (posts || []).find((p) => p.id !== editing?.id && p.mediaUrl && p.mediaUrl === form.mediaUrl.trim() && p.status !== 'published')
  }, [posts, form.mediaUrl, editing?.id])
  const collision = useMemo(() => {
    if (!form.scheduleTime) return null
    const t = new Date(form.scheduleTime).getTime()
    if (Number.isNaN(t)) return null
    return (posts || []).find((p) => p.id !== editing?.id && p.status === 'scheduled' && p.scheduleTime && Math.abs(new Date(p.scheduleTime).getTime() - t) < 30 * 60000)
  }, [posts, form.scheduleTime, editing?.id])

  // Auto-probe the media's real dimensions (no more hand-typed width/
  // height): the browser already knows them once the file loads.
  useEffect(() => {
    const url = form.mediaUrl.trim()
    if (!url || /^data:/i.test(url)) return undefined
    let alive = true
    if (form.mediaType === 'image') {
      const img = new Image()
      img.onload = () => { if (alive && img.naturalWidth) { setWidth(String(img.naturalWidth)); setHeight(String(img.naturalHeight)) } }
      img.src = url
    } else {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.onloadedmetadata = () => { if (alive && v.videoWidth) { setWidth(String(v.videoWidth)); setHeight(String(v.videoHeight)) } }
      v.src = url
    }
    return () => { alive = false }
  }, [form.mediaUrl, form.mediaType])

  // Suggestion from the user's own schedule: next free 7:00 PM slot.
  // Excludes the post being edited so it doesn't block its own slot.
  const suggestion = useMemo(() => {
    const others = (posts || []).filter((p) => p.id !== editing?.id)
    return nextBestTime(others)
  }, [posts, editing?.id])
  const suggestionLabel = suggestion
    ? new Date(suggestion).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : null

  const submit = async (statusOverride) => {
    setError('')
    const status = statusOverride || form.status || 'scheduled'
    if (!form.mediaUrl.trim()) { setError('Add a media URL or pick one from your library first (Step 1).'); setStep(1); return }
    // Drafts need no time; scheduled posts do.
    if (status !== 'draft' && !form.scheduleTime) { setError('Pick a date and time to schedule (Step 3).'); setStep(3); return }
    const payload = {
      ...form,
      mediaUrl: form.mediaUrl.trim(),
      caption: form.caption.trim(),
      hashtags: form.hashtags.trim(),
      cta: form.cta.trim(),
      scheduleTime: form.scheduleTime ? (form.scheduleTime.includes('T') && !form.scheduleTime.endsWith('Z') && form.scheduleTime.length <= 16 ? fromLocalInputValue(form.scheduleTime) : form.scheduleTime) : '',
      status
    }
    try {
      await onSave(payload, Boolean(editing?.id))
      setSavedNote(statusOverride === 'draft' ? 'Saved as draft.' : 'Scheduled — it is now in your queue.')
    } catch (e) {
      setError(e.message || 'Could not save this post.')
    }
  }

  const applyTemplate = (tpl) => {
    if (!tpl) return
    setForm((f) => ({ ...f, caption: tpl.text || tpl.caption || '' }))
    setStep(2)
  }

  const pickMedia = (m) => {
    setForm((f) => ({ ...f, mediaUrl: m.url, mediaType: m.kind === 'image' ? 'image' : 'video', title: m.title }))
  }

  return (
    <div>
      <h2 className="section-title">{editing ? 'Edit post' : 'Studio — create a post'}</h2>
      <p className="section-sub">Three steps: media, caption, schedule. The phone on the right updates live as you type.</p>

      <div className="steps" aria-label="Composer steps">
        {['Media', 'Caption & hashtags', 'Schedule & publish'].map((label, i) => (
          <button key={label} type="button" className={`step ${step === i + 1 ? 'active' : ''}`} onClick={() => setStep(i + 1)}>
            <b><span className="step-num">{i + 1}</span>{label}</b>
            <span className="muted small">{['Video or image link', 'Score, hashtags, CTA', 'Format, time, status'][i]}</span>
          </button>
        ))}
      </div>

      <div className="two-col" style={{ alignItems: 'start' }}>
        <div className="card">
          {step === 1 && (
            <div>
              <h2>Step 1 — Media</h2>
              <p className="muted small mb">Paste a direct media link, or pick from your library.</p>
              <label htmlFor="mediaUrl">Media URL</label>
              <input id="mediaUrl" type="url" placeholder="https://…/video.mp4 or image.jpg" value={form.mediaUrl} onChange={(e) => set({ mediaUrl: e.target.value, mediaType: /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(e.target.value) ? 'image' : 'video' })} />
              <div className="two-col mt">
                <div>
                  <label htmlFor="mediaType">Media type</label>
                  <select id="mediaType" value={form.mediaType} onChange={(e) => set({ mediaType: e.target.value })}>
                    <option value="video">Video</option>
                    <option value="image">Image</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="platform">Platform</label>
                  <select id="platform" value={form.platform} onChange={(e) => set({ platform: e.target.value })}>
                    {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>

              <div className="mt2">
                <label>Reel-safety check <span className="muted">(auto-detected when the media loads — or enter manually)</span></label>
                <div className="two-col">
                  <input type="number" placeholder="Width, e.g. 1080" value={width} onChange={(e) => setWidth(e.target.value)} aria-label="Video width in pixels" />
                  <input type="number" placeholder="Height, e.g. 1920" value={height} onChange={(e) => setHeight(e.target.value)} aria-label="Video height in pixels" />
                </div>
                {ratio !== null && (
                  <div className={`warn ${reelSafe ? 'green' : feedVerticalWarn ? 'red' : 'blue'}`}>
                    {reelSafe ? <IconCheck size={17} /> : <IconWarn size={17} />}
                    <div>Ratio <b>{ratio.toFixed(2)}</b>{isVertical ? ' — 1080×1920 vertical. Safe for Reels.' : ' — not vertical 9:16.'}{feedVerticalWarn && ' Warning: a vertical video as a FEED post may be cropped or rejected — switch format to REELS.'}</div>
                  </div>
                )}
                {form.format === 'FEED' && form.mediaType === 'video' && !width && (
                  <div className="warn amber"><IconWarn size={17} /><div>Vertical video + FEED format is the most common publish failure. If this is 1080×1920, choose REELS in Step 3.</div></div>
                )}
              </div>

              <div className="mt2">
                <label>From your library</label>
                {(!media || media.length === 0) ? <p className="muted small">No media yet — upload some in Media Library first.</p> : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', maxHeight: 180, overflow: 'auto' }}>
                    {media.slice(0, 12).map((m) => (
                      <button key={m.id} type="button" onClick={() => pickMedia(m)} style={{ border: form.mediaUrl === m.url ? '2px solid var(--brand)' : '1px solid var(--line)', borderRadius: 10, padding: 0, overflow: 'hidden', width: 72, height: 96, background: 'var(--surface-2)' }} title={m.title || m.url}>
                        {m.kind === 'image' ? <img src={m.url} alt={m.title || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <video src={m.url} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button type="button" className="btn primary mt" onClick={() => setStep(2)}>Continue to caption →</button>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2>Step 2 — Caption &amp; hashtags</h2>
              <p className="muted small mb">Write like you talk. The score updates live.</p>
              {templates && templates.length > 0 && (
                <div className="mb">
                  <label htmlFor="tpl">Start from a template</label>
                  <select id="tpl" value="" onChange={(e) => { const t = templates.find((x) => String(x.id) === e.target.value); if (t) applyTemplate(t) }}>
                    <option value="">Choose a template…</option>
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              )}
              <label htmlFor="caption">Caption</label>
              <textarea id="caption" rows={5} placeholder="Write your caption…" value={form.caption} onChange={(e) => set({ caption: e.target.value })} />
              <p className="muted small" style={{ textAlign: 'right' }}>{form.caption.length} characters</p>
              <label htmlFor="hashtags">Hashtags <span className="muted">(space or comma separated)</span></label>
              <input id="hashtags" placeholder="#social #creator #reels" value={form.hashtags} onChange={(e) => set({ hashtags: e.target.value })} />
              <p className="small mt" style={{ color: nTags > 30 ? 'var(--red)' : 'var(--muted)' }}>{nTags} / 30 hashtags{nTags > 30 ? ' — over the Instagram limit of 30. Remove some before publishing.' : ''}</p>
              {nTags > 30 && <div className="warn red"><IconWarn size={17} /><div><b>30-hashtag limit:</b> Instagram allows at most 30 hashtags per post. This post has {nTags}.</div></div>}
              <label htmlFor="cta" style={{ marginTop: 14 }}>Call to action</label>
              <input id="cta" placeholder="e.g. Comment GUIDE and I'll send it" value={form.cta} onChange={(e) => set({ cta: e.target.value })} />
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button type="button" className="btn ghost" onClick={() => setStep(1)}>← Back</button>
                <button type="button" className="btn primary" onClick={() => setStep(3)}>Continue to schedule →</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2>Step 3 — Schedule &amp; publish</h2>
              <p className="muted small mb">Pick a format and a time. Save as a draft if you&apos;re not ready.</p>
              <div className="two-col">
                <div>
                  <label htmlFor="format">Format</label>
                  <select id="format" value={form.format} onChange={(e) => set({ format: e.target.value })}>
                    {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="status">Status</label>
                  <select id="status" value={form.status} onChange={(e) => set({ status: e.target.value })}>
                    <option value="scheduled">Scheduled</option>
                    <option value="draft">Draft</option>
                  </select>
                </div>
              </div>
              <label htmlFor="scheduleTime" style={{ marginTop: 14 }}>Schedule time</label>
              <input id="scheduleTime" type="datetime-local" value={form.scheduleTime && form.scheduleTime.length > 16 ? toLocalInputValue(form.scheduleTime) : form.scheduleTime} onChange={(e) => set({ scheduleTime: e.target.value })} />
              {suggestion && (
                <div className="warn blue">
                  <IconCheck size={17} />
                  <div>
                    <b>Suggested time: {suggestionLabel}.</b> This is the next free 7:00 PM slot in your own schedule — no post is scheduled then. It is a suggestion from your saved posts, not audience data.
                    <div style={{ marginTop: 8 }}>
                      <button type="button" className="btn ghost small" onClick={() => set({ scheduleTime: toLocalInputValue(suggestion) })}>Use {suggestionLabel}</button>
                    </div>
                  </div>
                </div>
              )}
              <p className="muted small mt">Best times are usually 7–9pm in your audience&apos;s timezone — check the heatmap in Tools.</p>
              {duplicateOf && <div className="warn amber"><IconWarn size={17} /><div>This same media is already in your queue ({duplicateOf.status}, {duplicateOf.scheduleTime ? new Date(duplicateOf.scheduleTime).toLocaleString() : 'no time'}). Scheduling it again will post the same video twice.</div></div>}
              {collision && <div className="warn amber"><IconWarn size={17} /><div>Another post is scheduled within 30 minutes of this time ({collision.caption ? collision.caption.slice(0, 60) : 'untitled'}). Consider spacing posts at least an hour apart.</div></div>}
              {feedVerticalWarn && <div className="warn red"><IconWarn size={17} /><div>Vertical video (ratio {ratio?.toFixed(2)}) with FEED format — this is likely to fail or crop. Switch to REELS above.</div></div>}
              {error && <div className="alert error">{error}</div>}
              {savedNote && <div className="alert success">{savedNote}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                <button type="button" className="btn ghost" onClick={() => setStep(2)}>← Back</button>
                <button type="button" className="btn ghost" disabled={!canSaveDraft || saving} onClick={() => submit('draft')}>Save draft</button>
                <button type="button" className="btn primary" disabled={!canSave || saving} onClick={() => submit('scheduled')}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Schedule post'}</button>
              </div>
              {!canSave && <p className="muted small mt">{canSaveDraft ? 'Add a schedule time to schedule this post — or save it as a draft for now.' : 'Add a media URL (Step 1) and a schedule time to enable saving.'}</p>}
            </div>
          )}
        </div>

        <div>
          <div className="card preview-card">
            <div className="card-head"><div><h2>Live preview</h2><p>How it will look on a phone.</p></div><span className="badge brand">{form.platform}</span></div>
            <div className="phone" aria-label="Phone preview">
              <div className="phone-head"><span>Social Scheduler</span><span>{form.format}</span></div>
              <div className="phone-media">
                {form.mediaUrl ? (form.mediaType === 'image' ? <img src={form.mediaUrl} alt="Preview" /> : <video src={form.mediaUrl} muted playsInline controls preload="metadata" />) : <span style={{ color: '#888', fontSize: 13, padding: 20, textAlign: 'center' }}>Add media in Step 1 to see it here</span>}
                <div className="phone-overlay">
                  <p>{form.caption || 'Your caption will appear here…'}</p>
                  {form.hashtags && <div className="tags">{form.hashtags}</div>}
                  {form.cta && <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700 }}>{form.cta}</div>}
                </div>
              </div>
            </div>
            <div className="score-wrap mt">
              <div className="score-ring" style={{ '--p': `${score}%` }}><i>{score}</i></div>
              <div>
                <b>Caption score</b>
                <p className="muted small">{score >= 80 ? 'Strong — ready to post.' : score >= 50 ? 'Good — add a hook, question or CTA to lift it.' : 'Needs work — add a hook, a CTA and a few hashtags.'}</p>
              </div>
            </div>
            <p className="muted small mt">{nTags} hashtags · {form.caption.length} chars · {form.format}{reelSafe ? ' · Reel-safe ✓' : ''}</p>
          </div>
        </div>
      </div>

      <div className="sticky-bar">
        <div><b>{editing ? 'Editing post' : 'New post'}</b> <span className="muted small">· {form.platform} · {form.format} · Score {score}/100</span></div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {onCancel && <button type="button" className="btn ghost small" onClick={onCancel}>Cancel</button>}
          <button type="button" className="btn ghost small" disabled={!canSaveDraft || saving} onClick={() => submit('draft')}>Save draft</button>
          <button type="button" className="btn primary small" disabled={!canSave || saving} onClick={() => submit('scheduled')}>{saving ? 'Saving…' : 'Schedule post'}</button>
        </div>
      </div>
    </div>
  )
}
