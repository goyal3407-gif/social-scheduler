import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api.js'
import Dashboard from './components/Dashboard.jsx'
import CalendarView from './components/CalendarView.jsx'
import Queue from './components/Queue.jsx'
import Studio from './components/Studio.jsx'
import Bulk from './components/Bulk.jsx'
import MediaLibrary from './components/MediaLibrary.jsx'
import Tools from './components/Tools.jsx'
import Settings from './components/Settings.jsx'
import { IconHome, IconCal, IconQueue, IconPlus, IconMedia, IconBulk, IconTools, IconSettings, IconSun, IconMoon } from './components/icons.jsx'

const NAV = [
  { id: 'home', label: 'Home', Icon: IconHome },
  { id: 'calendar', label: 'Calendar', Icon: IconCal },
  { id: 'queue', label: 'Queue', Icon: IconQueue },
  { id: 'media', label: 'Media', Icon: IconMedia },
  { id: 'bulk', label: 'Bulk', Icon: IconBulk },
  { id: 'tools', label: 'Tools', Icon: IconTools },
  { id: 'settings', label: 'Settings', Icon: IconSettings }
]

export default function App() {
  const [tab, setTab] = useState('home')
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('ss-theme') || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') } catch { return 'light' }
  })
  const [posts, setPosts] = useState([])
  const [media, setMedia] = useState([])
  const [templates, setTemplates] = useState([])
  const [settings, setSettings] = useState(null)
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

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [p, m, t, s, st] = await Promise.all([
        api.getPosts().catch(() => []),
        api.getMedia().catch(() => []),
        api.getTemplates().catch(() => []),
        api.getSettings().catch(() => null),
        api.getStats().catch(() => null)
      ])
      setPosts(p); setMedia(m); setTemplates(t); setSettings(s); setStats(st)
    } catch (e) {
      setError(e)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 4000) }

  const refreshStats = useCallback(async () => {
    try { setStats(await api.getStats()) } catch { /* keep last stats */ }
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

  const handleBulkImport = useCallback(async (rows) => {
    let imported = 0
    const errors = []
    for (const row of rows) {
      try { await api.createPost(row); imported++ } catch (e) { errors.push(e.message || 'Failed row') }
    }
    const fresh = await api.getPosts().catch(() => null)
    if (fresh) setPosts(fresh)
    refreshStats()
    return { imported, failed: rows.length - imported, errors }
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
            onPublish={handlePublish} publishingId={publishingId} settings={settings} />
        )}
        {tab === 'calendar' && (
          <div className="section"><CalendarView posts={posts} loading={loading} onEdit={goStudio} onDelete={(p) => setConfirmDelete({ type: 'post', item: p })} onPublish={handlePublish} publishingId={publishingId} /></div>
        )}
        {tab === 'queue' && (
          <div className="section"><Queue posts={posts} loading={loading} onEdit={goStudio} onDelete={(p) => setConfirmDelete({ type: 'post', item: p })} onPublish={handlePublish} publishingId={publishingId} onCreate={() => goStudio(null)} /></div>
        )}
        {tab === 'studio' && (
          <div className="section">
            <Studio key={`${studioKey}-${editing?.id || 'new'}`} editing={editing} seed={templateSeed ? { caption: templateSeed.text || templateSeed.caption || '', mediaUrl: templateSeed.mediaUrl || '', mediaType: templateSeed.mediaType || 'video', scheduleTime: templateSeed.scheduleTime || '' } : null} media={media} templates={templates} onSave={handleSavePost} onCancel={() => setTab('queue')} saving={saving} />
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
        {tab === 'settings' && (
          <div className="section"><Settings settings={settings} saving={saving} onSave={async (s) => { setSaving(true); try { const u = await api.saveSettings(s); setSettings(u || s) } finally { setSaving(false) } }} /></div>
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
