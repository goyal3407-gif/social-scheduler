import { useEffect, useMemo, useRef, useState } from 'react'
import { api, captionScore, countHashtags, fromLocalInputValue, nextBestTime, toLocalInputValue } from '../api.js'
import { IconWarn, IconCheck, IconHeart, IconComment, IconSend, IconBookmark } from './icons.jsx'
import { Empty } from './shared.jsx'
import BottomSheet from './BottomSheet.jsx'

// Best-time chips (batch 6): the next occurrences of the widely-used
// India Instagram slots (12:30 PM, 6:30 PM, 9:00 PM, local time).
// The app stores NO per-post engagement (Instagram insights need Meta
// App Review), so these are honestly labelled in the UI as a general
// guide — never as the user's own audience data. Pure client-side:
// no endpoint, no server load.
const BEST_TIME_SLOTS = [[12, 30], [18, 30], [21, 0]]
function bestTimeSlots(t) {
  const now = Date.now()
  const out = []
  for (const [h, m] of BEST_TIME_SLOTS) {
    const d = new Date()
    d.setHours(h, m, 0, 0)
    let today = true
    if (d.getTime() <= now + 10 * 60000) { d.setDate(d.getDate() + 1); today = false }
    out.push({
      key: `${h}:${m}:${today ? 't' : 'tm'}`,
      date: d,
      label: `${today ? t('todayWord') : t('tomorrowWord')} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
    })
  }
  return out.sort((a, b) => a.date - b.date).slice(0, 3)
}
const PLATFORMS = ['Instagram', 'YouTube', 'Facebook', 'TikTok']
const FORMATS = ['REELS', 'FEED', 'STORY']
const YT_VISIBILITIES = ['public', 'unlisted', 'private']
const EMPTY = { mediaUrl: '', mediaType: 'video', posterUrl: '', caption: '', hashtags: '', cta: '', platform: 'Instagram', scheduleTime: '', status: 'scheduled', format: 'REELS', igTargets: [], igTick: true, youtubeEnabled: false, youtubeTitle: '', ytVisibility: 'public', ytMadeForKids: false, firstComment: '', repeatWeekly: false }
// The Instagram accounts a post/draft targets, as a list of account
// ids. New posts store igTargets (objects on a saved post, plain ids
// on a library draft); a legacy post carries only igAccountId, which
// reads as a one-element list.
const targetIdsOf = (base) => {
  if (!base) return []
  if (Array.isArray(base.igTargets) && base.igTargets.length) {
    return base.igTargets.map((t) => String(typeof t === 'string' ? t : (t?.igUserId || t?.id || ''))).filter(Boolean)
  }
  return base.igAccountId ? [String(base.igAccountId)] : []
}
// A post's stored YouTube setting is an object ({ enabled, title }) and
// its repeat is a string ('weekly'); the form keeps flat fields and
// submit() folds them back. The platform picker is two ticks:
// igTick (stored as igEnabled) + youtubeEnabled. Visibility and Made
// for Kids are flat post fields (ytVisibility / ytMadeForKids): an
// explicit value on the post/draft wins; a brand-new post pre-fills
// from the user's saved default (ytDefault), falling back to Public.
const withYouTubeFields = (base, ytDefault) => {
  const y = (base && base.youtube) || {}
  const f = {
    ...EMPTY, ...base,
    igTargets: targetIdsOf(base),
    igTick: !base || base.igEnabled !== false, youtubeEnabled: !!y.enabled, youtubeTitle: y.title || '',
    repeatWeekly: (base && base.repeat) === 'weekly',
    ytVisibility: YT_VISIBILITIES.includes(base?.ytVisibility) ? base.ytVisibility : (YT_VISIBILITIES.includes(ytDefault) ? ytDefault : 'public'),
    ytMadeForKids: !!(base && base.ytMadeForKids),
  }
  delete f.youtube
  delete f.repeat
  delete f.igEnabled
  delete f.igAccountId
  delete f.igAccountUsername
  return f
}
// Built-in starter templates (server seeds) have ids tpl-1, tpl-2, … —
// they are not stored per-user, so they cannot be deleted. The KiluaAI
// caption pack (Phase D9) has ids pack-* and is likewise built in.
const isSeedTemplate = (t) => /^tpl-\d+$/.test(String(t?.id || '')) || /^pack-/.test(String(t?.id || ''))
const isPackTemplate = (t) => /^pack-/.test(String(t?.id || ''))

export default function Studio({ editing, seed, media, templates, hashtagGroups, onCreateTemplate, onDeleteTemplate, onCreateHashtagGroup, onDeleteHashtagGroup, drafts, onSaveLibraryDraft, onDeleteLibraryDraft, onSave, onCancel, saving, posts, igAccounts, defaultIgUserId, settings, onNavigate, onUploadFile, tr }) {
  const t = tr || ((k) => k)
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
  // Round 2 (D-2): Step 1 leads with the library + upload; the URL
  // paste box is an "advanced" row, opened on demand (or whenever
  // the current media URL did not come from the library).
  const [showUrl, setShowUrl] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)
  // Prompt-4: the drafts library lives behind a Drafts button +
  // bottom sheet, not as a card at the top of the composer.
  const [draftsOpen, setDraftsOpen] = useState(false)
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
      localStorage.removeItem(draftKey((form.igTargets || [])[0] || defaultIgUserId))
      localStorage.removeItem(draftKey(defaultIgUserId))
    } catch { /* storage unavailable */ }
  }

  const ytVisTouchedRef = useRef(false)
  const targetsTouchedRef = useRef(false)
  useEffect(() => {
    ytVisTouchedRef.current = false
    targetsTouchedRef.current = false
    if (editing?.id) {
      setForm(withYouTubeFields({ ...editing, scheduleTime: editing.scheduleTime || '' }, settings?.ytDefaultVisibility))
    } else if (seed) {
      setForm(withYouTubeFields({ ...seed, scheduleTime: seed.scheduleTime || '' }, settings?.ytDefaultVisibility))
    } else {
      // Restore the autosaved draft for the default account, if any.
      let initial = EMPTY
      try {
        const raw = localStorage.getItem(draftKey(defaultIgUserId))
        if (raw) {
          const draft = JSON.parse(raw)
          if (draft && (draft.caption || draft.mediaUrl || draft.hashtags)) {
            initial = { ...EMPTY, ...draft, scheduleTime: draft.scheduleTime || '' }
            // A restored draft's own visibility counts as the user's
            // choice — the late-default pre-fill must not stomp it.
            if (YT_VISIBILITIES.includes(draft.ytVisibility)) ytVisTouchedRef.current = true
          }
        }
      } catch { /* no usable draft */ }
      setForm(withYouTubeFields(initial, settings?.ytDefaultVisibility))
    }
    restoredDraftRef.current = true
    setStep(1); setError(''); setSavedNote(''); setBankMsg('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, seed])

  // Default account pre-tick: a NEW post starts with the default
  // Instagram account ticked (the owner can tick more, or untick it).
  // Applies only until the user touches the tick list themselves, and
  // never to an edit or a seed (those carry their own targets).
  useEffect(() => {
    if (editing?.id || seed || targetsTouchedRef.current || !defaultIgUserId) return
    setForm((f) => ((f.igTargets || []).length ? f : { ...f, igTargets: [String(defaultIgUserId)] }))
  }, [defaultIgUserId, editing, seed])

  const toggleTarget = (id) => {
    targetsTouchedRef.current = true
    setForm((f) => {
      const cur = f.igTargets || []
      return { ...f, igTargets: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }
    })
  }
  // With connected accounts, "Instagram ticked" means at least one
  // account is ticked; with none connected, the generic tick applies.
  const hasAccounts = Array.isArray(igAccounts) && igAccounts.length > 0
  const igTicked = hasAccounts ? (form.igTargets || []).length > 0 : Boolean(form.igTick)

  // YouTube visibility pre-fill: settings can arrive after the
  // composer mounts. When the user's saved default lands, apply it to
  // a NEW post — never to an edit/seed, and never over a visibility
  // the user (or their restored draft) already chose.
  useEffect(() => {
    const d = settings?.ytDefaultVisibility
    if (!YT_VISIBILITIES.includes(d) || editing?.id || seed || ytVisTouchedRef.current) return
    setForm((f) => (f.ytVisibility === d ? f : { ...f, ytVisibility: d }))
  }, [settings?.ytDefaultVisibility, editing, seed])

  // Persist the draft as the user types (new posts only — edits write
  // to the saved post itself).
  useEffect(() => {
    if (editing?.id || seed || !restoredDraftRef.current) return undefined
    const t = setTimeout(() => {
      try {
        if (form.caption || form.mediaUrl || form.hashtags || form.cta) {
          localStorage.setItem(draftKey((form.igTargets || [])[0] || defaultIgUserId), JSON.stringify(form))
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

  // The save payload, shared by submit() and the pre-flight check so
  // the check always judges exactly what would be saved.
  const buildPayload = (status) => {
    const payload = {
      ...form,
      mediaUrl: form.mediaUrl.trim(),
      caption: form.caption.trim(),
      hashtags: form.hashtags.trim(),
      cta: form.cta.trim(),
      scheduleTime: form.scheduleTime ? (form.scheduleTime.includes('T') && !form.scheduleTime.endsWith('Z') && form.scheduleTime.length <= 16 ? fromLocalInputValue(form.scheduleTime) : form.scheduleTime) : '',
      status,
      // Fold the flat platform-picker fields back into stored shape.
      // The YouTube tick only counts when a channel is connected.
      // With connected accounts the ticked list IS the Instagram
      // selection; without any, the generic tick decides.
      igEnabled: Boolean(igTicked),
      ...(hasAccounts ? { igTargets: form.igTargets || [] } : {}),
      youtube: { enabled: Boolean(form.youtubeEnabled && ytStatus?.connected), title: (form.youtubeTitle || '').trim() },
      firstComment: (form.firstComment || '').trim(),
      repeat: form.repeatWeekly ? 'weekly' : '',
    }
    delete payload.igTick
    if (!hasAccounts) delete payload.igTargets
    delete payload.youtubeEnabled
    delete payload.youtubeTitle
    delete payload.repeatWeekly
    return payload
  }

  // Pre-flight check (batch 2): connection + media + plan verdict,
  // shown inline in Step 3 before saving. Runs when Step 3 opens and
  // on demand via the Re-check button.
  const [preflight, setPreflight] = useState(null)
  const [preflightBusy, setPreflightBusy] = useState(false)
  const runPreflight = async () => {
    setPreflightBusy(true)
    try {
      const r = await api.preflightPost({ ...buildPayload(form.status || 'scheduled'), ...(editing?.id ? { excludePostId: editing.id } : {}) })
      setPreflight(r)
    } catch (e) {
      setPreflight({ ok: false, checks: [{ id: 'preflight', ok: false, message: e.message || t('errPreflight'), fix: t('errPreflightFix') }] })
    }
    setPreflightBusy(false)
  }
  useEffect(() => { if (step === 3) { runPreflight() } }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (statusOverride) => {
    setError('')
    const status = statusOverride || form.status || 'scheduled'
    if (!form.mediaUrl.trim()) { setError(t('errAddMedia')); setStep(1); return }
    // Platform picker: at least one platform must be ticked.
    if (!igTicked && !(form.youtubeEnabled && ytStatus?.connected)) { setError(t('errTickPlatform')); setStep(3); return }
    // Drafts need no time; scheduled posts do.
    if (status !== 'draft' && !form.scheduleTime) { setError(t('errPickTime')); setStep(3); return }
    const payload = buildPayload(status)
    try {
      await onSave(payload, Boolean(editing?.id))
      if (!editing?.id) clearDrafts()
      setSavedNote(statusOverride === 'draft' ? t('noteSavedDraft') : t('noteScheduled'))
    } catch (e) {
      setError(e.message || t('errSavePost'))
    }
  }

  // Caption library (batch 3): a saved set restores caption +
  // hashtags + CTA in one tap. Older templates carry only text —
  // those still apply as caption-only, exactly as before.
  const applyTemplate = (tpl) => {
    if (!tpl) return
    setForm((f) => ({
      ...f,
      caption: tpl.text || tpl.caption || '',
      ...(typeof tpl.hashtags === 'string' && tpl.hashtags ? { hashtags: tpl.hashtags } : {}),
      ...(typeof tpl.cta === 'string' && tpl.cta ? { cta: tpl.cta } : {}),
    }))
    setStep(2)
  }

  const saveAsTemplate = async () => {
    setBankMsg('')
    if (!form.caption.trim()) { setBankMsg(t('bankWriteCaption')); return }
    if (!tplName.trim()) { setBankMsg(t('bankNameSet')); return }
    try {
      await onCreateTemplate({ name: tplName.trim(), text: form.caption.trim(), hashtags: form.hashtags.trim(), cta: form.cta.trim() })
      setTplName(''); setShowTplSave(false)
      setBankMsg(t('bankSetSaved'))
    } catch (e) { setBankMsg(e.message || t('bankSaveSetFail')) }
  }

  // AI caption assistant (batch 3): one suggestion from a topic the
  // user types. The suggestion fills the fields — the user edits
  // freely before saving, and any failure (assistant off, daily cap,
  // network) shows the server's plain message and changes nothing.
  const [aiTopic, setAiTopic] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMsg, setAiMsg] = useState('')
  const [aiRemaining, setAiRemaining] = useState(null)
  const runAiSuggest = async () => {
    const topic = (aiTopic || '').trim() || (form.caption || '').trim()
    if (topic.length < 3) { setAiMsg(t('aiWriteFirst')); return }
    setAiBusy(true); setAiMsg('')
    try {
      const r = await api.aiCaption(topic)
      setForm((f) => ({ ...f, caption: r.caption || f.caption, hashtags: r.hashtags || f.hashtags, cta: r.cta || f.cta }))
      if (r.remaining != null) setAiRemaining(r.remaining)
      setAiMsg(t('aiAdded'))
    } catch (e) { setAiMsg(e.message || t('aiFail')) }
    finally { setAiBusy(false) }
  }

  const appendHashtagGroup = (g) => {
    if (!g) return
    setForm((f) => ({ ...f, hashtags: [f.hashtags.trim(), String(g.tags || '').trim()].filter(Boolean).join(' ') }))
  }

  const saveAsHashtagGroup = async () => {
    setBankMsg('')
    if (!form.hashtags.trim()) { setBankMsg(t('bankAddTags')); return }
    if (!tagName.trim()) { setBankMsg(t('bankNameGroup')); return }
    try {
      await onCreateHashtagGroup({ name: tagName.trim(), tags: form.hashtags.trim() })
      setTagName(''); setShowTagSave(false)
      setBankMsg(t('bankGroupSaved'))
    } catch (e) { setBankMsg(e.message || t('bankSaveGroupFail')) }
  }

  // First comment from a hashtag group (Phase C2): the group's tags,
  // each guaranteed a leading #, become the comment text.
  const useGroupAsFirstComment = (g) => {
    if (!g) return
    const tags = String(g.tags || '').split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ')
    setForm((f) => ({ ...f, firstComment: tags }))
    setBankMsg(t('firstCommentSet').replace('{name}', g.name))
  }

  // Drafts library (Phase C3): save the current composer as a named
  // draft; loading one fills the composer — it never schedules.
  const saveToDraftsLibrary = async () => {
    setDraftLibMsg('')
    if (!onSaveLibraryDraft) return
    if (!draftLibName.trim()) { setDraftLibMsg(t('draftNameFirst')); return }
    try {
      await onSaveLibraryDraft({
        name: draftLibName.trim(),
        caption: form.caption, hashtags: form.hashtags, cta: form.cta,
        mediaUrl: form.mediaUrl, mediaType: form.mediaType, posterUrl: form.posterUrl,
        platform: form.platform, format: form.format,
        igAccountId: (form.igTargets || [])[0] || '', igTargets: form.igTargets || [],
        igEnabled: Boolean(igTicked),
        youtube: { enabled: Boolean(form.youtubeEnabled), title: form.youtubeTitle || '' },
        ytVisibility: form.ytVisibility, ytMadeForKids: Boolean(form.ytMadeForKids),
        firstComment: form.firstComment || '',
        repeat: form.repeatWeekly ? 'weekly' : '',
      })
      setDraftLibName('')
      setDraftLibMsg(t('draftSavedLib'))
    } catch (e) { setDraftLibMsg(e.message || t('draftSaveFail')) }
  }

  const loadDraft = (d) => {
    if (!d) return
    setForm(withYouTubeFields({ ...d, scheduleTime: '', status: 'scheduled' }, settings?.ytDefaultVisibility))
    setStep(1); setError('')
    setDraftLibMsg(t('draftLoaded').replace('{name}', d.name))
  }

  const pickMedia = (m) => {
    setForm((f) => ({ ...f, mediaUrl: m.url, mediaType: m.kind === 'image' ? 'image' : 'video', posterUrl: m.posterUrl || '', title: m.title }))
  }

  // Step 1 upload (D-2): the Library's own upload path (App's
  // handleUpload → api.uploadMedia) — the created item lands in the
  // library AND is picked for this post in the same tap.
  const onPickFile = async (e) => {
    const f = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!f || !onUploadFile) return
    setUploading(true)
    try {
      const item = await onUploadFile(f, { folder: 'Uploads' })
      if (item && item.url) pickMedia({ url: item.url, kind: item.kind, posterUrl: item.posterUrl || '', title: item.title })
    } catch { /* App surfaces upload errors */ }
    setUploading(false)
  }
  // The URL paste row stays open when the current URL did not come
  // from the library (a pasted link, an edited post's own URL).
  const urlInLibrary = Boolean(form.mediaUrl) && (media || []).some((m) => m.url === form.mediaUrl)

  // Instagram preview identity: the first ticked account this post
  // will publish to, else the default connection.
  const previewAccount = useMemo(() => {
    const wanted = (form.igTargets || [])[0] || defaultIgUserId || ''
    const found = (igAccounts || []).find((a) => String(a.igUserId) === String(wanted))
    const username = found?.username || settings?.instagramUsername || settings?.instagramHandle || ''
    const pic = found?.profile?.profile_picture_url || found?.profile?.profilePictureUrl || settings?.instagramProfile?.profile_picture_url || settings?.instagramProfile?.profilePictureUrl || ''
    return { username: String(username || '').replace(/^@/, ''), pic }
  }, [form.igTargets, igAccounts, defaultIgUserId, settings])
  const previewAspect = form.format === 'FEED' ? '4 / 5' : '9 / 16'

  return (
    <div style={{ paddingBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h2 className="section-title">{editing ? t('studioEditTitle') : t('studioTitle')}</h2>
          <p className="section-sub">{t('studioSub')}</p>
        </div>
        {onSaveLibraryDraft && (
          <button type="button" className="btn ghost" onClick={() => setDraftsOpen(true)}>{t('draftsLibrary')}</button>
        )}
      </div>
      {draftsOpen && onSaveLibraryDraft && (
        <BottomSheet title={t('draftsLibrary')} onClose={() => setDraftsOpen(false)}>
          <p className="muted small" style={{ marginTop: 0 }}>{t('draftsLibrarySub')}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <input placeholder={t('draftNamePh')} value={draftLibName} onChange={(e) => setDraftLibName(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label={t('draftNameAria')} />
            <button type="button" className="btn small" onClick={saveToDraftsLibrary}>{t('saveToDrafts')}</button>
          </div>
          {draftLibMsg && <p className="small mt">{draftLibMsg}</p>}
          {(drafts || []).length > 0 && (
            <div style={{ marginTop: 10 }}>
              {drafts.map((d) => (
                <span key={d.id} className="chip" style={{ marginRight: 6, marginBottom: 6 }}>
                  <button type="button" onClick={() => { loadDraft(d); setDraftsOpen(false) }} style={{ border: 'none', background: 'transparent', fontWeight: 700, padding: 0, color: 'var(--ink)' }} title={d.caption || ''}>{d.name}</button>
                  {onDeleteLibraryDraft && <button type="button" aria-label={t('deleteDraftAria').replace('{name}', d.name)} onClick={() => onDeleteLibraryDraft(d)} style={{ border: 'none', background: 'transparent', color: 'var(--red-text)', fontWeight: 700, padding: 0, marginLeft: 2 }}>✕</button>}
                </span>
              ))}
            </div>
          )}
        </BottomSheet>
      )}

      <div className="stepper" aria-label="Composer steps">
        {[t('stepMedia'), t('stepCaption'), t('stepSchedule')].map((label, i) => (
          <button key={label} type="button" className={`stepper-step ${step === i + 1 ? 'active' : ''}`} aria-current={step === i + 1 ? 'step' : undefined} onClick={() => setStep(i + 1)}>
            <b><span className="stepper-n">{i + 1}</span>{label}</b>
          </button>
        ))}
      </div>

      <div className="two-col" style={{ alignItems: 'start' }}>
        <div className="card">
          {step === 1 && (
            <div>
              <h2>{t('step1Title')}</h2>
              <p className="muted small mb">{t('step1Sub')}</p>
              {/* D-2: the library + upload lead Step 1 — the URL paste
                  box is demoted to an advanced row below. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ margin: 0, flex: 1 }}>{t('fromLibrary')}</label>
                <input ref={fileRef} type="file" accept="video/*,image/*" hidden onChange={onPickFile} />
                <button type="button" className="btn ghost small" disabled={uploading || !onUploadFile} onClick={() => fileRef.current && fileRef.current.click()}>{uploading ? t('uploadingWord') : t('uploadMediaBtn')}</button>
                {onNavigate && <button type="button" className="btn ghost small" onClick={() => onNavigate('media')}>{t('seeAllInLibrary')}</button>}
              </div>
              {(!media || media.length === 0) ? (
                <Empty title={t('noMediaYet')} body={t('step1Sub')} action={<button type="button" className="btn primary small" disabled={uploading || !onUploadFile} onClick={() => fileRef.current && fileRef.current.click()}>{t('uploadMediaBtn')}</button>} />
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', maxHeight: 180, overflow: 'auto', marginTop: 8 }}>
                  {media.slice(0, 24).map((m) => m.serverCopyRemoved ? (
                    <button key={m.id} type="button" disabled title={t('removedCopyTitle')} style={{ border: '1px dashed var(--line)', borderRadius: 10, padding: 6, width: 72, height: 96, background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 12, lineHeight: 1.4, cursor: 'not-allowed' }}>
                      {t('publishedMark')}<br />{t('reuploadReuse')}
                    </button>
                  ) : (
                    <button key={m.id} type="button" onClick={() => pickMedia(m)} style={{ border: form.mediaUrl === m.url ? '2px solid var(--brand)' : '1px solid var(--line)', borderRadius: 10, padding: 0, overflow: 'hidden', width: 72, height: 96, background: 'var(--surface-2)' }} title={m.title || m.url}>
                      {m.kind === 'image' ? <img src={m.url} alt={m.title || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <video src={m.url} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                    </button>
                  ))}
                </div>
              )}
              <div className="two-col mt">
                <div>
                  <label htmlFor="mediaType">{t('mediaTypeLabel')}</label>
                  <select id="mediaType" value={form.mediaType} onChange={(e) => set({ mediaType: e.target.value })}>
                    <option value="video">{t('videoWord')}</option>
                    <option value="image">{t('imageWord')}</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="platform">{t('platformLabel')}</label>
                  <select id="platform" value={form.platform} onChange={(e) => set({ platform: e.target.value })}>
                    {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>

              <div className="mt2">
                <label>{t('reelSafety')} <span className="muted">{t('reelSafetyNote')}</span></label>
                <div className="two-col">
                  <input type="number" placeholder={t('widthPh')} value={width} onChange={(e) => setWidth(e.target.value)} aria-label={t('widthAria')} />
                  <input type="number" placeholder={t('heightPh')} value={height} onChange={(e) => setHeight(e.target.value)} aria-label={t('heightAria')} />
                </div>
                {ratio !== null && (
                  <div className={`warn ${reelSafe ? 'green' : feedVerticalWarn ? 'red' : 'blue'}`}>
                    {reelSafe ? <IconCheck size={17} /> : <IconWarn size={17} />}
                    <div>Ratio <b>{ratio.toFixed(2)}</b>{isVertical ? t('ratioSafe') : t('ratioNotVertical')}{feedVerticalWarn && ` ${t('ratioFeedWarn')}`}</div>
                  </div>
                )}
                {form.format === 'FEED' && form.mediaType === 'video' && !width && (
                  <div className="warn amber"><IconWarn size={17} /><div>{t('feedVideoWarn')}</div></div>
                )}
              </div>

              <div className="mt2">
                {!(showUrl || urlInLibrary) ? (
                  <button type="button" className="btn ghost small" onClick={() => setShowUrl(true)}>{t('studioUrlAdvanced')}</button>
                ) : (
                  <>
                    <label htmlFor="mediaUrl">{t('mediaUrlLabel')}</label>
                    <input id="mediaUrl" type="url" placeholder="https://…/video.mp4 or image.jpg" value={form.mediaUrl} onChange={(e) => set({ mediaUrl: e.target.value, mediaType: /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(e.target.value) ? 'image' : 'video', posterUrl: '' })} />
                  </>
                )}
              </div>
              <button type="button" className="btn primary mt" onClick={() => setStep(2)}>{t('continueCaption')}</button>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2>{t('step2Title')}</h2>
              <p className="muted small mb">{t('step2Sub')}</p>
              {templates && templates.length > 0 && (
                <div className="mb">
                  <label htmlFor="tpl">{t('tplLabel')}</label>
                  <select id="tpl" value="" onChange={(e) => { const tpl = templates.find((x) => String(x.id) === e.target.value); if (tpl) applyTemplate(tpl) }}>
                    <option value="">{t('chooseSet')}</option>
                    {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}{isPackTemplate(tpl) ? t('kiluaaiPack') : ''}</option>)}
                  </select>
                  <div style={{ marginTop: 8 }}>
                    {templates.filter((tpl) => !isSeedTemplate(tpl)).map((tpl) => (
                      <span key={tpl.id} className="chip" style={{ marginRight: 6, marginBottom: 6 }}>
                        <button type="button" onClick={() => applyTemplate(tpl)} style={{ border: 'none', background: 'transparent', fontWeight: 700, padding: 0, color: 'var(--ink)' }} title={t('useSetTitle')}>{tpl.name}</button>
                        {onDeleteTemplate && <button type="button" aria-label={t('deleteSetAria').replace('{name}', tpl.name)} onClick={() => onDeleteTemplate(tpl)} style={{ border: 'none', background: 'transparent', color: 'var(--red-text)', fontWeight: 700, padding: 0, marginLeft: 2 }}>✕</button>}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <label htmlFor="caption">{t('captionLabel')}</label>
              <textarea id="caption" rows={5} placeholder={t('captionPh')} value={form.caption} onChange={(e) => set({ caption: e.target.value })} />
              <p className="muted small" style={{ textAlign: 'right' }}>{t('characters').replace('{n}', form.caption.length)}</p>
              {onCreateTemplate && (
                <div className="mb">
                  {!showTplSave ? (
                    <button type="button" className="btn ghost small" onClick={() => setShowTplSave(true)}>{t('saveCaptionSet')}</button>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input placeholder={t('setNamePh')} value={tplName} onChange={(e) => setTplName(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label={t('setNameAria')} />
                      <button type="button" className="btn small" onClick={saveAsTemplate}>{t('saveSetBtn')}</button>
                      <button type="button" className="btn ghost small" onClick={() => setShowTplSave(false)}>{t('cancel')}</button>
                    </div>
                  )}
                </div>
              )}
              <div className="mb" style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 12 }}>
                <label htmlFor="aiTopic">{t('aiAssistant')} <span className="muted">{t('aiBoxNote')}</span></label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input id="aiTopic" placeholder={t('aiTopicPh')} value={aiTopic} onChange={(e) => setAiTopic(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
                  <button type="button" className="btn small" disabled={aiBusy} onClick={runAiSuggest}>{aiBusy ? t('aiThinking') : t('aiSuggest')}</button>
                </div>
                {aiRemaining != null && <p className="muted small" style={{ margin: '6px 0 0' }}>{t('aiLeftToday').replace('{n}', aiRemaining)}</p>}
                {aiMsg && <p className="small" role="status" style={{ margin: '6px 0 0' }}>{aiMsg}</p>}
              </div>
              <label htmlFor="hashtags">{t('hashtagsLabel')} <span className="muted">{t('hashtagsNote')}</span></label>
              <input id="hashtags" placeholder="#social #creator #reels" value={form.hashtags} onChange={(e) => set({ hashtags: e.target.value })} />
              <p className="small mt" style={{ color: nTags > 30 ? 'var(--red-text)' : 'var(--muted)' }}>{t('hashtagsCount').replace('{n}', nTags)}{nTags > 30 ? ` ${t('hashtagsOver')}` : ''}</p>
              {nTags > 30 && <div className="warn red"><IconWarn size={17} /><div><b>{t('hashtagLimitTitle')}</b> {t('hashtagLimitBody').replace('{n}', nTags)}</div></div>}
              <div className="mt">
                <label>{t('hashtagBank')} <span className="muted">{t('hashtagBankNote')}</span></label>
                {(!hashtagGroups || hashtagGroups.length === 0) ? (
                  <p className="muted small">{t('noGroupsYet')}</p>
                ) : (
                  <div>
                    {hashtagGroups.map((g) => (
                      <span key={g.id} className="chip" style={{ marginRight: 6, marginBottom: 6 }}>
                        <button type="button" onClick={() => appendHashtagGroup(g)} style={{ border: 'none', background: 'transparent', fontWeight: 700, padding: 0, color: 'var(--ink)' }} title={g.tags}>{g.name} +</button>
                        <button type="button" onClick={() => useGroupAsFirstComment(g)} style={{ border: 'none', background: 'transparent', fontWeight: 700, padding: 0, marginLeft: 4, color: 'var(--gold-text)' }} title={t('firstCommentUse')}>{t('firstCommentMark')}</button>
                        {onDeleteHashtagGroup && <button type="button" aria-label={t('deleteGroupAria').replace('{name}', g.name)} onClick={() => onDeleteHashtagGroup(g)} style={{ border: 'none', background: 'transparent', color: 'var(--red-text)', fontWeight: 700, padding: 0, marginLeft: 2 }}>✕</button>}
                      </span>
                    ))}
                  </div>
                )}
                {onCreateHashtagGroup && (
                  !showTagSave ? (
                    <button type="button" className="btn ghost small" onClick={() => setShowTagSave(true)}>{t('saveHashtagsGroup')}</button>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input placeholder={t('groupNamePh')} value={tagName} onChange={(e) => setTagName(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label={t('groupNameAria')} />
                      <button type="button" className="btn small" onClick={saveAsHashtagGroup}>{t('saveGroupBtn')}</button>
                      <button type="button" className="btn ghost small" onClick={() => setShowTagSave(false)}>{t('cancel')}</button>
                    </div>
                  )
                )}
                {bankMsg && <p className="small mt" role="status">{bankMsg}</p>}
              </div>
              <label htmlFor="firstComment" style={{ marginTop: 14 }}>{t('firstCommentLabel')} <span className="muted">{t('firstCommentNote')}</span></label>
              <textarea id="firstComment" rows={2} maxLength={2200} placeholder="#your #hashtags #here" value={form.firstComment} onChange={(e) => set({ firstComment: e.target.value })} />
              <p className="muted small" style={{ textAlign: 'right' }}>{(form.firstComment || '').length} / 2200 {t('charactersWord')}</p>
              <label htmlFor="cta" style={{ marginTop: 14 }}>{t('ctaLabel')}</label>
              <input id="cta" placeholder={t('ctaPh')} value={form.cta} onChange={(e) => set({ cta: e.target.value })} />
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button type="button" className="btn ghost" onClick={() => setStep(1)}>{t('backArrow')}</button>
                <button type="button" className="btn primary" onClick={() => setStep(3)}>{t('continueSchedule')}</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h2 style={{ flex: 1, margin: 0 }}>{t('step3Title')}</h2>
                <button type="button" className="btn ghost small" onClick={() => setStep(2)}>{t('backArrow')}</button>
              </div>
              <p className="muted small mb">{t('step3Sub')}</p>
              <div className="two-col">
                <div>
                  <label htmlFor="format">{t('formatLabel')}</label>
                  <select id="format" value={form.format} onChange={(e) => set({ format: e.target.value })}>
                    {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="status">{t('statusLabel')}</label>
                  <select id="status" value={form.status} onChange={(e) => set({ status: e.target.value })}>
                    <option value="scheduled">{t('statusOptScheduled')}</option>
                    <option value="draft">{t('statusOptDraft')}</option>
                  </select>
                </div>
              </div>
              <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                <label>{t('publishToLabel')} <span className="muted">{t('publishToNote')}</span></label>
                {hasAccounts ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                    {igAccounts.map((a) => (
                      <label key={a.igUserId} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 12, padding: '9px 14px' }}>
                        <input type="checkbox" checked={(form.igTargets || []).includes(a.igUserId)} onChange={() => toggleTarget(a.igUserId)} style={{ width: 'auto' }} />
                        <b>Instagram</b> <span>@{a.username || a.igUserId}{a.isDefault ? ` ${t('defaultMark')}` : ''}</span>
                      </label>
                    ))}
                    {(form.igTargets || []).filter((id) => !igAccounts.some((a) => a.igUserId === id)).map((id) => (
                      <label key={id} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 12, padding: '9px 14px' }}>
                        <input type="checkbox" checked onChange={() => toggleTarget(id)} style={{ width: 'auto' }} />
                        <b>Instagram</b> <span>@{id} {t('disconnectedMark')}</span>
                      </label>
                    ))}
                    {ytStatus?.connected ? (
                      <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 12, padding: '9px 14px' }}>
                        <input type="checkbox" checked={Boolean(form.youtubeEnabled)} onChange={(e) => set({ youtubeEnabled: e.target.checked })} style={{ width: 'auto' }} />
                        <b>YouTube</b> <span className="muted small">{ytStatus.channelTitle || t('yourChannel')}</span>
                      </label>
                    ) : (
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center', border: '1px solid var(--line)', borderRadius: 12, padding: '9px 14px', opacity: 0.75 }}>
                        <input type="checkbox" checked={false} disabled readOnly style={{ width: 'auto' }} />
                        <b>YouTube</b>
                        {ytStatus && !ytStatus.configured
                          ? <span className="muted small">{t('ytNotSetup')}</span>
                          : <button type="button" className="btn ghost small" onClick={() => { if (onNavigate) onNavigate('connections') }}>{t('connectYouTube')}</button>}
                      </span>
                    )}
                  </div>
                ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 999, padding: '8px 14px' }}>
                    <input type="checkbox" checked={Boolean(form.igTick)} onChange={(e) => set({ igTick: e.target.checked })} style={{ width: 'auto' }} />
                    <b>Instagram</b>
                  </label>
                  {ytStatus?.connected ? (
                    <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 999, padding: '8px 14px' }}>
                      <input type="checkbox" checked={Boolean(form.youtubeEnabled)} onChange={(e) => set({ youtubeEnabled: e.target.checked })} style={{ width: 'auto' }} />
                      <b>YouTube</b> <span className="muted small">{ytStatus.channelTitle || t('yourChannel')}</span>
                    </label>
                  ) : (
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', border: '1px solid var(--line)', borderRadius: 999, padding: '8px 14px', opacity: 0.75 }}>
                      <input type="checkbox" checked={false} disabled readOnly style={{ width: 'auto' }} />
                      <b>YouTube</b>
                      {ytStatus && !ytStatus.configured
                        ? <span className="muted small">{t('ytNotSetup')}</span>
                        : <button type="button" className="btn ghost small" onClick={() => { if (onNavigate) onNavigate('connections') }}>{t('connectYouTube')}</button>}
                    </span>
                  )}
                </div>
                )}
                {form.youtubeEnabled && ytStatus?.connected && (
                  <div style={{ marginTop: 12 }}>
                    <label htmlFor="youtubeTitle">{t('ytTitleLabel')} <span className="muted">{t('ytTitleNote')}</span></label>
                    <input id="youtubeTitle" maxLength={100} placeholder={t('ytTitlePh')} value={form.youtubeTitle} onChange={(e) => set({ youtubeTitle: e.target.value })} />
                    <div className="two-col" style={{ marginTop: 12 }}>
                      <div>
                        <label htmlFor="ytVisibility">{t('ytVisibilityLabel')}</label>
                        <select id="ytVisibility" value={form.ytVisibility} onChange={(e) => { ytVisTouchedRef.current = true; set({ ytVisibility: e.target.value }) }}>
                          <option value="public">{t('ytVisPublic')}</option>
                          <option value="unlisted">{t('ytVisUnlisted')}</option>
                          <option value="private">{t('ytVisPrivate')}</option>
                        </select>
                      </div>
                      <div>
                        <label>{t('madeForKids')} <span className="muted">{t('madeForKidsNote')}</span></label>
                        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                          {[{ v: false, label: t('noWord') }, { v: true, label: t('yesWord') }].map((o) => (
                            <label key={o.label} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 999, padding: '7px 14px' }}>
                              <input type="radio" name="ytMadeForKids" checked={Boolean(form.ytMadeForKids) === o.v} onChange={() => set({ ytMadeForKids: o.v })} style={{ width: 'auto' }} />
                              <b>{o.label}</b>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                    <p className="muted small" style={{ marginTop: 6 }}>{t('ytApprovalShort')}</p>
                  </div>
                )}
                {!igTicked && form.youtubeEnabled && ytStatus?.connected && (
                  <p className="muted small" style={{ marginTop: 8 }}>{t('ytOnlyNote')}</p>
                )}
                {!igTicked && !form.youtubeEnabled && (
                  <p className="small" style={{ marginTop: 8, color: 'var(--red-text)' }}>{t('tickOnePlatform')}</p>
                )}
              </div>
              <label htmlFor="scheduleTime" style={{ marginTop: 14 }}>{t('scheduleTimeLabel')}</label>
              <input id="scheduleTime" type="datetime-local" value={form.scheduleTime && form.scheduleTime.length > 16 ? toLocalInputValue(form.scheduleTime) : form.scheduleTime} onChange={(e) => set({ scheduleTime: e.target.value })} />
              <div style={{ marginTop: 10 }}>
                <div className="small" style={{ fontWeight: 600 }}>{t('bestTimesTitle')}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                  {bestTimeSlots(t).map((s) => (
                    <button key={s.key} type="button" className="btn ghost small" onClick={() => set({ scheduleTime: toLocalInputValue(s.date) })}>{s.label}</button>
                  ))}
                </div>
                <p className="muted small" style={{ marginTop: 6 }}>{t('bestTimesNote')}</p>
              </div>
              {suggestion && (
                <div className="warn blue">
                  <IconCheck size={17} />
                  <div>
                    <b>{t('suggestedTime').replace('{label}', suggestionLabel)}</b> {t('suggestedBody')}
                    <div style={{ marginTop: 8 }}>
                      <button type="button" className="btn ghost small" onClick={() => set({ scheduleTime: toLocalInputValue(suggestion) })}>{t('useSlot').replace('{label}', suggestionLabel)}</button>
                    </div>
                  </div>
                </div>
              )}
              <p className="muted small mt">{t('eveningsNote')}</p>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', marginTop: 14 }}>
                <input type="checkbox" checked={Boolean(form.repeatWeekly)} onChange={(e) => set({ repeatWeekly: e.target.checked })} style={{ width: 'auto' }} />
                <span><b>{t('repeatWeeklyLabel')}</b> <span className="muted small">{t('repeatWeeklyNote')}</span></span>
              </label>
              {duplicateOf && <div className="warn amber"><IconWarn size={17} /><div>{t('duplicateWarn').replace('{status}', duplicateOf.status).replace('{time}', duplicateOf.scheduleTime ? new Date(duplicateOf.scheduleTime).toLocaleString() : t('noTimeWord'))}</div></div>}
              {collision && <div className="warn amber"><IconWarn size={17} /><div>{t('collisionWarn').replace('{caption}', collision.caption ? collision.caption.slice(0, 60) : t('untitledWord'))}</div></div>}
              {feedVerticalWarn && <div className="warn red"><IconWarn size={17} /><div>{t('feedCropWarn').replace('{ratio}', ratio?.toFixed(2))}</div></div>}
              {error && <div className="alert error">{error}</div>}
              {savedNote && <div className="alert success">{savedNote}</div>}
              <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', marginTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <b>{t('preflightTitle')}</b>
                  <button type="button" className="btn ghost small" disabled={preflightBusy} onClick={runPreflight}>{preflightBusy ? t('checkingWord') : t('recheckBtn')}</button>
                </div>
                <p className="muted small" style={{ margin: '4px 0 6px' }}>{t('preflightSub')}</p>
                {preflightBusy && !preflight && <p className="muted small">{t('checkingWord')}</p>}
                {preflight && (preflight.checks || []).map((c) => (
                  <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 6 }}>
                    {c.ok ? <IconCheck size={17} /> : <IconWarn size={17} />}
                    <div>
                      <span style={{ color: c.ok ? 'var(--green-text)' : 'var(--red-text)', fontWeight: 600 }}>{c.ok ? t('goodWord') : t('problemWord')}</span>{c.message}
                      {!c.ok && c.fix && (
                        <div className="muted small">{t('fixWord')}{c.fix}
                          {c.id === 'connection' && onNavigate ? <> <button type="button" className="btn ghost small" onClick={() => onNavigate('connections')}>{t('openConnections')}</button></> : null}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {preflight && (
                  <p className="small" style={{ marginTop: 8, fontWeight: 600, color: preflight.ok ? 'var(--green-text)' : 'var(--red-text)' }}>
                    {preflight.ok ? t('preflightOk') : t('preflightBad')}
                  </p>
                )}
              </div>
              {/* D-2: no second action row here — the sticky bar
                  below is the ONE action row for every step. */}
            </div>
          )}
        </div>

        <div>
          <div className="card preview-card">
            <div className="card-head"><div><h2>{form.platform === 'Instagram' ? t('previewIg') : t('previewLive')}</h2><p>{t('previewHow').replace('{platform}', form.platform)}</p></div><span className="badge brand">{form.platform}</span></div>
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
                  : <span className="ig-empty">{t('previewEmpty')}</span>}
              </div>
              <div className="ig-actions" aria-hidden="true">
                <span className="ig-actions-left"><IconHeart size={21} /><IconComment size={21} /><IconSend size={21} /></span>
                <IconBookmark size={21} />
              </div>
              <div className="ig-caption">
                <p><b>{previewAccount.username || 'youraccount'}</b> {form.caption || <span className="muted">{t('previewCaptionPh')}</span>}</p>
                {form.hashtags && <p className="ig-tags">{form.hashtags}</p>}
                {form.cta && <p className="ig-cta">{form.cta}</p>}
              </div>
            </div>
            <div className="score-wrap mt">
              <div className="score-ring" style={{ '--p': `${score}%` }}><i>{score}</i></div>
              <div>
                <b>{t('captionScore')}</b>
                <p className="muted small">{score >= 80 ? t('scoreStrong') : score >= 50 ? t('scoreGood') : t('scoreWeak')}</p>
              </div>
            </div>
            <p className="muted small mt">{t('scoreMeta').replace('{tags}', nTags).replace('{chars}', form.caption.length).replace('{format}', form.format)}{reelSafe ? t('reelSafeMark') : ''}</p>
            <p className="muted small" style={{ marginTop: 6 }}>{t('scoreExplain')}</p>
          </div>
        </div>
      </div>

      <div className="sticky-bar">
        <div>
          <b>{editing ? t('editingPost') : t('newPostWord')}</b> <span className="muted small">· {form.platform} · {form.format} · {t('scoreOf').replace('{score}', score)}</span>
          {!canSave && <div className="muted small" style={{ marginTop: 2 }}>{canSaveDraft ? t('canSaveHintDraft') : t('canSaveHintMedia')}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {onCancel && <button type="button" className="btn ghost small" onClick={onCancel}>{t('cancel')}</button>}
          <button type="button" className="btn ghost small" disabled={!canSaveDraft || saving} onClick={() => submit('draft')}>{t('saveDraftBtn')}</button>
          <button type="button" className="btn primary small" disabled={!canSave || saving} onClick={() => submit('scheduled')}>{saving ? t('savingWord') : editing ? t('saveChangesBtn') : t('schedulePostBtn')}</button>
        </div>
      </div>
    </div>
  )
}
