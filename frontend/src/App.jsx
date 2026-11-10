import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, nextBestTime } from './api.js'
import Auth from './components/Auth.jsx'
import SetupWizard from './components/SetupWizard.jsx'
import Dashboard from './components/Dashboard.jsx'
import CalendarView from './components/CalendarView.jsx'
import Queue from './components/Queue.jsx'
import Studio from './components/Studio.jsx'
import Bulk from './components/Bulk.jsx'
import MediaLibrary from './components/MediaLibrary.jsx'
import Tools from './components/Tools.jsx'
import AIStudio from './components/AIStudio.jsx'
import Settings from './components/Settings.jsx'
import { IconHome, IconCal, IconQueue, IconPlus, IconMedia, IconBulk, IconTools, IconSpark, IconSettings, IconSun, IconMoon } from './components/icons.jsx'

const NAV = [
  { id: 'home', label: 'Home', Icon: IconHome },
  { id: 'calendar', label: 'Calendar', Icon: IconCal },
  { id: 'queue', label: 'Queue', Icon: IconQueue },
  { id: 'media', label: 'Media', Icon: IconMedia },
  { id: 'bulk', label: 'Bulk', Icon: IconBulk },
  { id: 'tools', label: 'Tools', Icon: IconTools },
  { id: 'ai', label: 'AI Studio', Icon: IconSpark },
  { id: 'settings', label: 'Settings', Icon: IconSettings }
]

export default function App() {
  const [tab, setTab] = useState('home')
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('ss-theme') || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') } catch { return 'light' }
  })
  const [user, setUser] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [posts, setPosts] = useState([])
  const [media, setMedia] = useState([])
  const [templates, setTemplates] = useState([])
  const [settings, setSettings] = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState('')
  const [editing, setEditing] = useState(null)
  const [studioKey, setStudioKey] = useState(0)
  const [saving, setSaving] = useState(false)
  const [publishingId, setPublishingId] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null) // {type:'post'|'media', item}
  const [templateSeed, setTemplateSeed] = useState(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('ss-theme', theme) } catch { /* storage unavailable */ }
  }, [theme])

  // Who is logged in? Logged-out visitors see only the Auth screen.
  useEffect(() => {
    let alive = true
    api.me()
      .then((res) => { if (alive) setUser(res.user || null) })
      .catch(() => { if (alive) setUser(null) })
      .finally(() => { if (alive) setAuthChecked(true) })
    return () => { alive = false }
  }, [])

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
        api.dbStatus().catch(() => null)
      ])
      for (const r of results) {
        if (r.status === 'rejected' && r.reason && r.reason.status === 401) { setUser(null); return }
      }
      const value = (i, fallback) => (results[i].status === 'fulfilled' ? results[i].value : fallback)
      const firstError = results.find((r) => r.status === 'rejected')
      setPosts(value(0, [])); setMedia(value(1, [])); setTemplates(value(2, [])); setSettings(value(3, null)); setStats(value(4, null)); setDbStatus(value(5, null))
      if (firstError) setError(firstError.reason)
    } catch (e) {
      if (e && e.status === 401) { setUser(null); return }
      setError(e)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { if (user) loadAll() }, [user, loadAll])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 4000) }

  const refreshStats = useCallback(async () => {
    try { setStats(await api.getStats()) } catch { /* keep last stats */ }
  }, [])

  const refreshSettings = useCallback(async () => {
    try { setSettings(await api.getSettings()) } catch { /* keep last settings */ }
    await loadAll()
  }, [loadAll])

  const handleLogout = useCallback(async () => {
    try { await api.logout() } catch { /* cookie cleared server-side anyway */ }
    setUser(null); setPosts([]); setMedia([]); setTemplates([]); setSettings(null); setStats(null); setTab('home')
  }, [])

  const goStudio = (post = null) => {
    setEditing(post)
    setTemplateSeed(null)
    setStudioKey((k) => k + 1)
    setTab('studio')
    window.scrollTo({ top: 0 })
  }

  const handleSavePost = useCallback(async (payload, isEdit) => {
    setSaving(true)
    try {
      if (isEdit && editing?.id) {
        const updated = await api.updatePost(editing.id, payload)
        setPosts((prev) => prev.map((p) => (p.id === editing.id ? { ...p, ...(updated || payload) } : p)))
        showToast('Post updated.')
      } else {
        const created = await api.createPost(payload)
        setPosts((prev) => [created || { ...payload, id: `local-${Date.now()}` }, ...prev])
        showToast(payload.status === 'draft' ? 'Draft saved.' : 'Post scheduled.')
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
      showToast('Duplicated as a draft.')
      refreshStats()
    } catch (e) { setError(e) }
  }, [refreshStats])

  const handleReschedule = useCallback(async (post, patch) => {
    try {
      const res = await api.reschedulePost(post.id, patch)
      const updated = res?.post || res
      if (updated && updated.id) setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, ...updated } : p)))
      showToast('Rescheduled.')
      refreshStats()
    } catch (e) { setError(e) }
  }, [refreshStats])

  const handleRescheduleNextBest = useCallback(async (post) => {
    const slot = nextBestTime(posts.filter((p) => p.id !== post.id))
    if (!slot) { showToast('No free 7:00 PM slot in the next 14 days.'); return }
    await handleReschedule(post, { scheduleTime: slot })
  }, [posts, handleReschedule])

  const handlePublish = useCallback(async (post) => {
    setPublishingId(post.id)
    try {
      const res = await api.publishPost(post.id)
      if (res && res.ok === false) throw new Error(res.error || 'Publish failed.')
      const liveUrl = res?.liveUrl || res?.live_url
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, status: 'published', ...(liveUrl ? { liveUrl } : {}) } : p)))
      showToast(liveUrl ? `Published live — ${liveUrl}` : 'Published.')
      refreshStats()
    } catch (e) {
      showToast(e.message || 'Publish failed.')
      // Surface the server's message plainly so the user knows what to fix
      // (e.g. "Instagram not connected — add your access token in Settings").
      setError(e)
      if (/not connected/i.test(e.message || '')) setTab('settings')
    } finally { setPublishingId(null) }
  }, [refreshStats])

  const doDelete = useCallback(async () => {
    if (!confirmDelete) return
    const { type, item } = confirmDelete
    setConfirmDelete(null)
    try {
      if (type === 'post') { await api.deletePost(item.id); setPosts((prev) => prev.filter((p) => p.id !== item.id)) }
      else { await api.deleteMedia(item.id); setMedia((prev) => prev.filter((m) => m.id !== item.id)) }
      showToast('Deleted.')
      refreshStats()
    } catch (e) { setError(e) }
  }, [confirmDelete, refreshStats])

  // AI Studio: save one draft, or many at once (Weekly Plan). Drafts are
  // created with status 'draft' and no media yet — the user adds the video
  // in Studio before anything is scheduled or published.
  const handleSaveDraft = useCallback(async (post) => {
    const created = await api.createPost({ ...post, status: 'draft' })
    if (created && created.id) setPosts((prev) => [created, ...prev])
    else { const fresh = await api.getPosts().catch(() => null); if (fresh) setPosts(fresh) }
    showToast('Saved as a draft — find it in your Queue.')
    refreshStats()
    return created
  }, [refreshStats])

  const handleSaveDrafts = useCallback(async (postsToSave) => {
    const res = await api.createPostsBulk(postsToSave.map((p) => ({ ...p, status: 'draft' })))
    const fresh = await api.getPosts().catch(() => null)
    if (fresh) setPosts(fresh)
    refreshStats()
    showToast(`Added ${res?.imported ?? postsToSave.length} draft${(res?.imported ?? postsToSave.length) === 1 ? '' : 's'} to your Queue.`)
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

  const handleUpload = useCallback(async (file, extra) => {
    const created = await api.uploadMedia(file, extra)
    const item = created?.media || created
    if (item && item.id) setMedia((prev) => [item, ...prev])
    else { const fresh = await api.getMedia().catch(() => null); if (fresh) setMedia(fresh) }
    refreshStats()
  }, [refreshStats])

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
  }, [])

  const useInStudio = useCallback((seed) => {
    // Seed is {text} (content bank) or a full template {name,text}.
    setTemplateSeed(seed)
    setEditing(null)
    setStudioKey((k) => k + 1)
    setTab('studio')
    window.scrollTo({ top: 0 })
  }, [])

  const statsFallback = useMemo(() => stats || {
    scheduled: posts.filter((p) => p.status === 'scheduled').length,
    published: posts.filter((p) => p.status === 'published').length,
    failed: posts.filter((p) => p.status === 'failed').length,
    drafts: posts.filter((p) => p.status === 'draft').length,
    mediaCount: media.length
  }, [stats, posts, media])

  // --- Login gate: nothing but the Auth screen until the server says who this is.
  if (!authChecked) {
    return <div className="app"><div className="wrap" style={{ paddingTop: 60, textAlign: 'center' }}><p className="muted">Loading…</p></div></div>
  }
  if (!user) {
    return (
      <div className="app">
        <Auth onAuth={(u) => { setUser(u); setTab('home') }} />
      </div>
    )
  }

  // --- Setup wizard: first login only, until it is finished or skipped.
  if (settings && settings.setupDone !== true) {
    return (
      <div className="app">
        <SetupWizard settings={settings} onDone={refreshSettings} onInstagramChanged={refreshSettings} />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-in">
          <div className="logo">
            <div className="logo-mark" aria-hidden="true"><IconQueue size={22} /></div>
            <div>
              <b>Social Scheduler</b>
              <span>by Goyal Kumar · Free forever</span>
            </div>
          </div>
          <div className="top-actions">
            <span className="pill" title={settings?.instagramConnected ? 'Instagram connected' : 'Instagram not connected'}>
              <span className={`dot ${settings?.instagramConnected ? '' : 'off'}`} />
              {settings?.instagramConnected ? `IG ${settings.instagramHandle || 'connected'}` : 'IG not connected'}
            </span>
            <button type="button" className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
            </button>
            <button type="button" className="btn ghost small" onClick={handleLogout} title={`Log out ${user.email || ''}`}>Log out</button>
          </div>
        </div>
      </header>

      <main className="wrap">
        {toast && <div className="alert success" role="status" style={{ marginTop: 16 }}>{toast}</div>}
        {error && tab !== 'home' && (
          <div className="alert error" role="alert" style={{ marginTop: 16 }}>
            <div style={{ flex: 1 }}>{String(error.message || error)}</div>
            <button type="button" className="btn ghost small" onClick={() => { setError(null); loadAll() }}>Retry</button>
            <button type="button" className="btn ghost small" onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {tab === 'home' && (
          <Dashboard posts={posts} stats={statsFallback} loading={loading} error={error} onRetry={loadAll}
            onCreate={() => goStudio(null)} onGoQueue={() => setTab('queue')}
            onEdit={goStudio} onDelete={(p) => setConfirmDelete({ type: 'post', item: p })}
            onPublish={handlePublish} publishingId={publishingId} settings={settings}
            onDuplicate={handleDuplicate} onReschedule={handleReschedule} onRescheduleNextBest={handleRescheduleNextBest} />
        )}
        {tab === 'calendar' && (
          <div className="section"><CalendarView posts={posts} loading={loading} onEdit={goStudio} onDelete={(p) => setConfirmDelete({ type: 'post', item: p })} onPublish={handlePublish} publishingId={publishingId} /></div>
        )}
        {tab === 'queue' && (
          <div className="section"><Queue posts={posts} loading={loading} onEdit={goStudio} onDelete={(p) => setConfirmDelete({ type: 'post', item: p })} onPublish={handlePublish} publishingId={publishingId} onCreate={() => goStudio(null)} onDuplicate={handleDuplicate} onReschedule={handleReschedule} onRescheduleNextBest={handleRescheduleNextBest} /></div>
        )}
        {tab === 'studio' && (
          <div className="section">
            <Studio key={`${studioKey}-${editing?.id || 'new'}`} editing={editing} seed={templateSeed ? { caption: templateSeed.text || templateSeed.caption || '', hashtags: templateSeed.hashtags || '', cta: templateSeed.cta || '', mediaUrl: templateSeed.mediaUrl || '', mediaType: templateSeed.mediaType || 'video', scheduleTime: templateSeed.scheduleTime || '' } : null} media={media} templates={templates} onSave={handleSavePost} onCancel={() => setTab('queue')} saving={saving} posts={posts} />
          </div>
        )}
        {tab === 'bulk' && <div className="section"><Bulk onImport={handleBulkImport} /></div>}
        {tab === 'media' && (
          <div className="section"><MediaLibrary media={media} loading={loading} error={error} onRetry={loadAll}
            onAddLink={handleAddLink} onUpload={handleUpload}
            onToggleFav={async (m) => { const u = await api.updateMedia(m.id, { favorite: !m.favorite }); setMedia((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...(u || {}), favorite: !m.favorite } : x))) }}
            onDelete={(m) => setConfirmDelete({ type: 'media', item: m })}
            onUse={(m) => { setEditing(null); setTemplateSeed({ mediaUrl: m.url, mediaType: m.kind === 'image' ? 'image' : 'video', caption: '', scheduleTime: '' }); setStudioKey((k) => k + 1); setTab('studio'); window.scrollTo({ top: 0 }) }} /></div>
        )}
        {tab === 'tools' && (
          <div className="section"><Tools posts={posts} stats={statsFallback} templates={templates} onCreateTemplate={handleCreateTemplate} onUseTemplate={useInStudio} /></div>
        )}
        {tab === 'ai' && (
          <div className="section"><AIStudio posts={posts} settings={settings} onSendToStudio={useInStudio} onSaveDraft={handleSaveDraft} onSaveDrafts={handleSaveDrafts} /></div>
        )}
        {tab === 'settings' && (
          <div className="section"><Settings settings={settings} dbStatus={dbStatus} saving={saving} onSave={async (s) => { setSaving(true); try { const u = await api.saveSettings(s); setSettings(u || s) } finally { setSaving(false) } }} onInstagramChanged={refreshSettings} /></div>
        )}

        <footer className="footer">
          <b>Social Scheduler</b> — free forever, for every creator.<br />
          Made by <b>Goyal Kumar</b> · Schedule Reels, Feed posts &amp; Stories for Instagram, YouTube, Facebook and TikTok.
        </footer>
      </main>

      <nav className="dock" aria-label="Main navigation">
        {NAV.slice(0, 3).map(({ id, label, Icon }) => (
          <button key={id} type="button" className={`dock-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}>
            <Icon size={20} />{label}
          </button>
        ))}
        <button type="button" className="dock-create" onClick={() => goStudio(null)} aria-label="Create a post"><IconPlus size={24} /></button>
        {NAV.slice(3).map(({ id, label, Icon }) => (
          <button key={id} type="button" className={`dock-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}>
            <Icon size={20} />{label}
          </button>
        ))}
      </nav>

      {confirmDelete && (
        <div className="modal-bg" role="dialog" aria-modal="true" aria-label="Confirm delete">
          <div className="modal">
            <h2>Delete this {confirmDelete.type === 'post' ? 'post' : 'media file'}?</h2>
            <p className="muted mt">{confirmDelete.type === 'post' ? (confirmDelete.item.caption || 'This post') : (confirmDelete.item.title || confirmDelete.item.url)} — this cannot be undone.</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button type="button" className="btn danger" onClick={doDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
