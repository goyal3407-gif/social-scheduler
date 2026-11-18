import { useEffect, useMemo, useRef, useState } from 'react'
import { api, captionScore, countHashtags, fromLocalInputValue, nextBestTime, toLocalInputValue } from '../api.js'
import { IconWarn, IconCheck, IconHeart, IconComment, IconSend, IconBookmark } from './icons.jsx'

const PLATFORMS = ['Instagram', 'YouTube', 'Facebook', 'TikTok']
const FORMATS = ['REELS', 'FEED', 'STORY']
const EMPTY = { mediaUrl: '', mediaType: 'video', posterUrl: '', caption: '', hashtags: '', cta: '', platform: 'Instagram', scheduleTime: '', status: 'scheduled', format: 'REELS', igAccountId: '', igAccountUsername: '', youtubeEnabled: false, youtubeTitle: '', firstComment: '', repeatWeekly: false }
// A post's stored YouTube setting is an object ({ enabled, title }) and
// its repeat is a string ('weekly'); the form keeps flat fields and
// submit() folds them back.
const withYouTubeFields = (base) => {
  const y = (base && base.youtube) || {}
  const f = { ...EMPTY, ...base, youtubeEnabled: !!y.enabled, youtubeTitle: y.title || '', repeatWeekly: (base && base.repeat) === 'weekly' }
  delete f.youtube
  delete f.repeat
  return f
}
// Built-in starter templates (server seeds) have ids tpl-1, tpl-2, … —
// they are not stored per-user, so they cannot be deleted.
const isSeedTemplate = (t) => /^tpl-\d+$/.test(String(t?.id || ''))

export default function Studio({ editing, seed, media, templates, hashtagGroups, onCreateTemplate, onDeleteTemplate, onCreateHashtagGroup, onDeleteHashtagGroup, drafts, onSaveLibraryDraft, onDeleteLibraryDraft, onSave, onCancel, saving, posts, igAccounts, defaultIgUserId, settings }) {
  const [form, setForm] = useState(EMPTY)
  const [step, setStep] = useState(1)
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [error, setError] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const [tplName, setTplName] = useState('')
  const [showTplSave, setShowTplSave] = useState(false)
  const [tagName, setTagName] = useState('')
  const [showTagSave, setShowTagSave] = useState(false)
  const [bankMsg, setBankMsg] = useState('')
  const [draftLibName, setDraftLibName] = useState('')
  const [draftLibMsg, setDraftLibMsg] = useState('')
  const [ytStatus, setYtStatus] = useState(null)
  const restoredDraftRef = useRef(false)

  // YouTube cross-post availability (Phase B): the toggle renders only
  // when a channel is connected; a configured-but-unconnected server
  // shows a hint pointing at the Connections page.
  useEffect(() => {
    let alive = true
    api.youtubeStatus().then((s) => { if (alive) setYtStatus(s) }).catch(() => { if (alive) setYtStatus({ configured: false, connected: false }) })
    return () => { alive = false }
  }, [])

  // Caption draft autosave (new posts only): the in-progress composer
  // is kept in localStorage per Instagram account and restored when
  // the user comes back, so a closed tab never loses a half-written
  // caption. Cleared on a successful save.
  const draftKey = (accountId) => `ss-studio-draft:${accountId || 'default'}`
  const clearDrafts = () => {
    try {
      localStorage.removeItem(draftKey(form.igAccountId || defaultIgUserId))
      localStorage.removeItem(draftKey(defaultIgUserId))
    } catch { /* storage unavailable */ }
  }

  useEffect(() => {
    if (editing?.id) {
      setForm(withYouTubeFields({ ...editing, scheduleTime: editing.scheduleTime || '' }))
    } else if (seed) {
      setForm(withYouTubeFields({ ...seed, scheduleTime: seed.scheduleTime || '' }))
    } else {
      // Restore the autosaved draft for the default account, if any.
      let initial = EMPTY
      try {
        const raw = localStorage.getItem(draftKey(defaultIgUserId))
        if (raw) {
          const draft = JSON.parse(raw)
          if (draft && (draft.caption || draft.mediaUrl || draft.hashtags)) initial = { ...EMPTY, ...draft, scheduleTime: draft.scheduleTime || '' }
        }
      } catch { /* no usable draft */ }
      setForm(withYouTubeFields(initial))
    }
    restoredDraftRef.current = true
    setStep(1); setError(''); setSavedNote(''); setBankMsg('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, seed])

  // Persist the draft as the user types (new posts only — edits write
  // to the saved post itself).
  useEffect(() => {
    if (editing?.id || seed || !restoredDraftRef.current) return undefined
    const t = setTimeout(() => {
      try {
        if (form.caption || form.mediaUrl || form.hashtags || form.cta) {
          localStorage.setItem(draftKey(form.igAccountId || defaultIgUserId), JSON.stringify(form))
        }
      } catch { /* storage unavailable */ }
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, editing, seed])

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
      status,
      // Fold the flat YouTube fields back into the stored object. The
      // toggle only counts when a channel is actually connected.
      youtube: { enabled: Boolean(form.youtubeEnabled && ytStatus?.connected), title: (form.youtubeTitle || '').trim() },
      firstComment: (form.firstComment || '').trim(),
      repeat: form.repeatWeekly ? 'weekly' : '',
    }
    delete payload.youtubeEnabled
    delete payload.youtubeTitle
    delete payload.repeatWeekly
    try {
      await onSave(payload, Boolean(editing?.id))
      if (!editing?.id) clearDrafts()
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

  const saveAsTemplate = async () => {
    setBankMsg('')
    if (!form.caption.trim()) { setBankMsg('Write a caption first, then save it as a template.'); return }
    if (!tplName.trim()) { setBankMsg('Give the template a name first.'); return }
    try {
      await onCreateTemplate({ name: tplName.trim(), text: form.caption.trim() })
      setTplName(''); setShowTplSave(false)
      setBankMsg('Template saved — find it in the list above.')
    } catch (e) { setBankMsg(e.message || 'Could not save the template.') }
  }

  const appendHashtagGroup = (g) => {
    if (!g) return
    setForm((f) => ({ ...f, hashtags: [f.hashtags.trim(), String(g.tags || '').trim()].filter(Boolean).join(' ') }))
  }

  const saveAsHashtagGroup = async () => {
    setBankMsg('')
    if (!form.hashtags.trim()) { setBankMsg('Add some hashtags first, then save them as a group.'); return }
    if (!tagName.trim()) { setBankMsg('Give the hashtag group a name first.'); return }
    try {
      await onCreateHashtagGroup({ name: tagName.trim(), tags: form.hashtags.trim() })
      setTagName(''); setShowTagSave(false)
      setBankMsg('Hashtag group saved.')
    } catch (e) { setBankMsg(e.message || 'Could not save the hashtag group.') }
  }

  // First comment from a hashtag group (Phase C2): the group's tags,
  // each guaranteed a leading #, become the comment text.
  const useGroupAsFirstComment = (g) => {
    if (!g) return
    const tags = String(g.tags || '').split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ')
    setForm((f) => ({ ...f, firstComment: tags }))
    setBankMsg(`First comment set from “${g.name}”.`)
  }

  // Drafts library (Phase C3): save the current composer as a named
  // draft; loading one fills the composer — it never schedules.
  const saveToDraftsLibrary = async () => {
    setDraftLibMsg('')
    if (!onSaveLibraryDraft) return
    if (!draftLibName.trim()) { setDraftLibMsg('Give the draft a name first.'); return }
    try {
      await onSaveLibraryDraft({
        name: draftLibName.trim(),
        caption: form.caption, hashtags: form.hashtags, cta: form.cta,
        mediaUrl: form.mediaUrl, mediaType: form.mediaType, posterUrl: form.posterUrl,
        platform: form.platform, format: form.format,
        igAccountId: form.igAccountId, igAccountUsername: form.igAccountUsername,
        youtube: { enabled: Boolean(form.youtubeEnabled), title: form.youtubeTitle || '' },
        firstComment: form.firstComment || '',
        repeat: form.repeatWeekly ? 'weekly' : '',
      })
      setDraftLibName('')
      setDraftLibMsg('Saved to your Drafts library.')
    } catch (e) { setDraftLibMsg(e.message || 'Could not save the draft.') }
  }

  const loadDraft = (d) => {
    if (!d) return
    setForm(withYouTubeFields({ ...d, scheduleTime: '', status: 'scheduled' }))
    setStep(1); setError('')
    setDraftLibMsg(`Loaded “${d.name}” — pick a time in Step 3 when you're ready. Nothing is scheduled yet.`)
  }

  const pickMedia = (m) => {
    setForm((f) => ({ ...f, mediaUrl: m.url, mediaType: m.kind === 'image' ? 'image' : 'video', posterUrl: m.posterUrl || '', title: m.title }))
  }

  // Instagram preview identity: the account this post will publish to
  // (the composer's selected account, else the default connection).
  const previewAccount = useMemo(() => {
    const wanted = form.igAccountId || defaultIgUserId || ''
    const found = (igAccounts || []).find((a) => String(a.igUserId) === String(wanted))
    const username = found?.username || form.igAccountUsername || settings?.instagramUsername || settings?.instagramHandle || ''
    const pic = found?.profile?.profile_picture_url || found?.profile?.profilePictureUrl || settings?.instagramProfile?.profile_picture_url || settings?.instagramProfile?.profilePictureUrl || ''
    return { username: String(username || '').replace(/^@/, ''), pic }
  }, [form.igAccountId, form.igAccountUsername, igAccounts, defaultIgUserId, settings])
  const previewAspect = form.format === 'FEED' ? '4 / 5' : '9 / 16'

  return (
    <div>
      <h2 className="section-title">{editing ? 'Edit post' : 'Studio — create a post'}</h2>
      <p className="section-sub">Three steps: media, caption, schedule. The preview updates live as you type.</p>
      {onSaveLibraryDraft && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Drafts library</h3>
          <p className="muted small" style={{ marginTop: 6 }}>Save this composer setup under a name and load it back any time. Loading a draft never schedules anything.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <input placeholder="Draft name, e.g. Salon offer post" value={draftLibName} onChange={(e) => setDraftLibName(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label="Draft name" />
            <button type="button" className="btn small" onClick={saveToDraftsLibrary}>Save to Drafts library</button>
          </div>
          {draftLibMsg && <p className="small mt">{draftLibMsg}</p>}
          {(drafts || []).length > 0 && (
            <div style={{ marginTop: 10 }}>
              {drafts.map((d) => (
                <span key={d.id} className="chip" style={{ marginRight: 6, marginBottom: 6 }}>
                  <button type="button" onClick={() => loadDraft(d)} style={{ border: 'none', background: 'transparent', fontWeight: 700, padding: 0, color: 'var(--ink)' }} title={d.caption || ''}>{d.name}</button>
                  {onDeleteLibraryDraft && <button type="button" aria-label={`Delete draft ${d.name}`} onClick={() => onDeleteLibraryDraft(d)} style={{ border: 'none', background: 'transparent', color: 'var(--red)', fontWeight: 700, padding: 0, marginLeft: 2 }}>✕</button>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

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
              <input id="mediaUrl" type="url" placeholder="https://…/video.mp4 or image.jpg" value={form.mediaUrl} onChange={(e) => set({ mediaUrl: e.target.value, mediaType: /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(e.target.value) ? 'image' : 'video', posterUrl: '' })} />
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
                  <div style={{ marginTop: 8 }}>
                    {templates.filter((t) => !isSeedTemplate(t)).map((t) => (
                      <span key={t.id} className="chip" style={{ marginRight: 6, marginBottom: 6 }}>
                        {t.name}
                        {onDeleteTemplate && <button type="button" aria-label={`Delete template ${t.name}`} onClick={() => onDeleteTemplate(t)} style={{ border: 'none', background: 'transparent', color: 'var(--red)', fontWeight: 700, padding: 0, marginLeft: 2 }}>✕</button>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <label htmlFor="caption">Caption</label>
              <textarea id="caption" rows={5} placeholder="Write your caption…" value={form.caption} onChange={(e) => set({ caption: e.target.value })} />
              <p className="muted small" style={{ textAlign: 'right' }}>{form.caption.length} characters</p>
              {onCreateTemplate && (
                <div className="mb">
                  {!showTplSave ? (
                    <button type="button" className="btn ghost small" onClick={() => setShowTplSave(true)}>Save caption as template</button>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input placeholder="Template name, e.g. Product launch" value={tplName} onChange={(e) => setTplName(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label="Template name" />
                      <button type="button" className="btn small" onClick={saveAsTemplate}>Save template</button>
                      <button type="button" className="btn ghost small" onClick={() => setShowTplSave(false)}>Cancel</button>
                    </div>
                  )}
                </div>
              )}
              <label htmlFor="hashtags">Hashtags <span className="muted">(space or comma separated)</span></label>
              <input id="hashtags" placeholder="#social #creator #reels" value={form.hashtags} onChange={(e) => set({ hashtags: e.target.value })} />
              <p className="small mt" style={{ color: nTags > 30 ? 'var(--red)' : 'var(--muted)' }}>{nTags} / 30 hashtags{nTags > 30 ? ' — over the Instagram limit of 30. Remove some before publishing.' : ''}</p>
              {nTags > 30 && <div className="warn red"><IconWarn size={17} /><div><b>30-hashtag limit:</b> Instagram allows at most 30 hashtags per post. This post has {nTags}.</div></div>}
              <div className="mt">
                <label>Hashtag bank <span className="muted">(tap a group to add its tags)</span></label>
                {(!hashtagGroups || hashtagGroups.length === 0) ? (
                  <p className="muted small">No saved groups yet — save the hashtags above as a group and reuse them in one tap.</p>
                ) : (
                  <div>
                    {hashtagGroups.map((g) => (
                      <span key={g.id} className="chip" style={{ marginRight: 6, marginBottom: 6 }}>
                        <button type="button" onClick={() => appendHashtagGroup(g)} style={{ border: 'none', background: 'transparent', fontWeight: 700, padding: 0, color: 'var(--ink)' }} title={g.tags}>{g.name} +</button>
                        <button type="button" onClick={() => useGroupAsFirstComment(g)} style={{ border: 'none', background: 'transparent', fontWeight: 700, padding: 0, marginLeft: 4, color: 'var(--gold, #b98a1c)' }} title="Use this group as the first comment">→ 1st comment</button>
                        {onDeleteHashtagGroup && <button type="button" aria-label={`Delete hashtag group ${g.name}`} onClick={() => onDeleteHashtagGroup(g)} style={{ border: 'none', background: 'transparent', color: 'var(--red)', fontWeight: 700, padding: 0, marginLeft: 2 }}>✕</button>}
                      </span>
                    ))}
                  </div>
                )}
                {onCreateHashtagGroup && (
                  !showTagSave ? (
                    <button type="button" className="btn ghost small" onClick={() => setShowTagSave(true)}>Save hashtags as group</button>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input placeholder="Group name, e.g. Reels basics" value={tagName} onChange={(e) => setTagName(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label="Hashtag group name" />
                      <button type="button" className="btn small" onClick={saveAsHashtagGroup}>Save group</button>
                      <button type="button" className="btn ghost small" onClick={() => setShowTagSave(false)}>Cancel</button>
                    </div>
                  )
                )}
                {bankMsg && <p className="small mt" role="status">{bankMsg}</p>}
              </div>
              <label htmlFor="firstComment" style={{ marginTop: 14 }}>First comment <span className="muted">(posted automatically right after publishing — a good place for hashtags)</span></label>
              <textarea id="firstComment" rows={2} maxLength={2200} placeholder="#your #hashtags #here" value={form.firstComment} onChange={(e) => set({ firstComment: e.target.value })} />
              <p className="muted small" style={{ textAlign: 'right' }}>{(form.firstComment || '').length} / 2200 characters</p>
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
              {Array.isArray(igAccounts) && igAccounts.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <label htmlFor="igAccount">Instagram account</label>
                  <select id="igAccount" value={form.igAccountId || defaultIgUserId || ''} onChange={(e) => { const a = igAccounts.find((x) => x.igUserId === e.target.value); set({ igAccountId: e.target.value, igAccountUsername: a ? a.username : '' }) }}>
                    {igAccounts.map((a) => (
                      <option key={a.igUserId} value={a.igUserId}>@{a.username || a.igUserId}{a.isDefault ? ' (default)' : ''}</option>
                    ))}
                    {form.igAccountId && !igAccounts.some((a) => a.igUserId === form.igAccountId) && (
                      <option value={form.igAccountId}>@{form.igAccountUsername || form.igAccountId} (disconnected — pick another)</option>
                    )}
                  </select>
                  <p className="muted small" style={{ marginTop: 6 }}>This post publishes to the chosen account only.</p>
                </div>
              )}
              {ytStatus?.connected && (
                <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={Boolean(form.youtubeEnabled)} onChange={(e) => set({ youtubeEnabled: e.target.checked })} style={{ width: 'auto' }} />
                    <span><b>Also post to YouTube</b> <span className="muted small">({ytStatus.channelTitle || 'your channel'})</span></span>
                  </label>
                  {form.youtubeEnabled && (
                    <div style={{ marginTop: 10 }}>
                      <label htmlFor="youtubeTitle">YouTube title <span className="muted">(blank = first line of the caption)</span></label>
                      <input id="youtubeTitle" maxLength={100} placeholder="Title viewers will see on YouTube" value={form.youtubeTitle} onChange={(e) => set({ youtubeTitle: e.target.value })} />
                      <p className="muted small" style={{ marginTop: 6 }}>The caption + hashtags become the YouTube description. Videos only — an image post skips YouTube. Until Google approves the app, YouTube posts land as Private/scheduled — one tap to make public.</p>
                    </div>
                  )}
                  {!form.youtubeEnabled && (
                    <p className="muted small" style={{ marginTop: 6 }}>The same video also goes to your YouTube channel at the same time.</p>
                  )}
                </div>
              )}
              {ytStatus && !ytStatus.connected && ytStatus.configured && (
                <p className="muted small" style={{ marginTop: 14 }}>Want this on YouTube too? Connect your channel on the <b>Connections</b> page, then tick “Also post to YouTube” here.</p>
              )}
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
              <p className="muted small mt">Evenings 7–9 PM usually perform best — a general guide, not your audience data. Your own suggested slot above comes from your schedule.</p>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 14 }}>
                <input type="checkbox" checked={Boolean(form.repeatWeekly)} onChange={(e) => set({ repeatWeekly: e.target.checked })} style={{ width: 'auto' }} />
                <span><b>Repeat weekly</b> <span className="muted small">— when this post publishes, the next one is scheduled automatically for the same day &amp; time next week. Untick it on any occurrence to stop the chain.</span></span>
              </label>
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
            <div className="card-head"><div><h2>{form.platform === 'Instagram' ? 'Instagram preview' : 'Live preview'}</h2><p>How it will look on {form.platform}.</p></div><span className="badge brand">{form.platform}</span></div>
            <div className="ig-preview" aria-label="Instagram post preview">
              <div className="ig-head">
                {previewAccount.pic
                  ? <img className="ig-avatar" src={previewAccount.pic} alt="" />
                  : <span className="ig-avatar ig-avatar-fallback" aria-hidden="true">{(previewAccount.username || 'k').charAt(0).toUpperCase()}</span>}
                <b>{previewAccount.username || 'youraccount'}</b>
                <span className="ig-format">{form.format}</span>
              </div>
              <div className="ig-media" style={{ aspectRatio: previewAspect }}>
                {form.mediaUrl
                  ? (form.posterUrl
                    ? <img src={form.posterUrl} alt="Preview" />
                    : form.mediaType === 'image'
                      ? <img src={form.mediaUrl} alt="Preview" />
                      : <video src={form.mediaUrl} muted playsInline preload="metadata" />)
                  : <span className="ig-empty">Add media in Step 1 to see it here</span>}
              </div>
              <div className="ig-actions" aria-hidden="true">
                <span className="ig-actions-left"><IconHeart size={21} /><IconComment size={21} /><IconSend size={21} /></span>
                <IconBookmark size={21} />
              </div>
              <div className="ig-caption">
                <p><b>{previewAccount.username || 'youraccount'}</b> {form.caption || <span className="muted">Your caption will appear here…</span>}</p>
                {form.hashtags && <p className="ig-tags">{form.hashtags}</p>}
                {form.cta && <p className="ig-cta">{form.cta}</p>}
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
          <button type="button" className="btn primary small" disabled={!canSave || saving} onClick={() => submit('scheduled')}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Schedule post'}</button>
        </div>
      </div>
    </div>
  )
}
