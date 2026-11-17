import { useEffect, useRef, useState } from 'react'
import { api, openInstagramConnect } from '../api.js'

// Two-step setup wizard shown after first login:
// 1. Connect Instagram (Meta login, verified live).
// 2. Import the connected account's profile + existing posts.
// Followers and DMs cannot be imported — Meta does not allow it.
// Either step can be skipped.
export default function SetupWizard({ settings, onDone, onInstagramChanged }) {
  const [step, setStep] = useState(settings?.instagramConnected ? 2 : 1)
  const [connectBusy, setConnectBusy] = useState(false)
  const [connectMsg, setConnectMsg] = useState('')
  const [err, setErr] = useState('')
  const [importing, setImporting] = useState(false)
  const [job, setJob] = useState(null)
  const [finishing, setFinishing] = useState(false)
  const pollRef = useRef(null)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const markDone = async () => {
    setFinishing(true)
    try { await api.saveSettings({ setupDone: true }) } catch { /* wizard still closes */ }
    setFinishing(false)
    onDone()
  }

  const startConnect = async () => {
    setErr(''); setConnectMsg('')
    setConnectBusy(true)
    try {
      await openInstagramConnect()
      // In the app, the Meta login is now open in the system browser and
      // this screen stays put; the focus/visibility refresh below flips
      // Step 1 to "Already connected" when the user returns.
      setConnectMsg('Meta login opened — approve access there, then come back here. This screen updates itself when you return.')
    } finally { setConnectBusy(false) }
  }

  // Returning from the Meta login: refresh the connection state when
  // this screen becomes visible / regains focus, no manual reload.
  useEffect(() => {
    if (!onInstagramChanged) return undefined
    const refresh = () => { onInstagramChanged() }
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refresh)
    }
  }, [onInstagramChanged])

  const startImport = async () => {
    setErr(''); setJob(null)
    setImporting(true)
    try {
      const res = await api.startInstagramImport()
      const jobId = res.jobId
      pollRef.current = setInterval(async () => {
        try {
          const data = await api.getInstagramImport(jobId)
          setJob(data.job)
          if (data.job.done) {
            clearInterval(pollRef.current); pollRef.current = null
            setImporting(false)
            if (onInstagramChanged) await onInstagramChanged()
          }
        } catch (e2) {
          clearInterval(pollRef.current); pollRef.current = null
          setImporting(false)
          setErr(e2.message || 'Could not check import progress.')
        }
      }, 1500)
    } catch (e2) {
      setImporting(false)
      setErr(e2.message || 'Could not start the import.')
    }
  }

  const profile = job?.profile || settings?.instagramProfile || null

  return (
    <div className="wrap" style={{ maxWidth: 620, paddingTop: 40 }}>
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <h1 style={{ fontSize: 24 }}>Welcome — let&apos;s set you up</h1>
        <p className="muted" style={{ marginTop: 6 }}>Two quick steps. You can skip either one and do it later in Settings.</p>
      </div>

      <div className="steps" aria-label="Setup steps">
        {['Connect Instagram', 'Import your posts'].map((label, i) => (
          <button key={label} type="button" className={`step ${step === i + 1 ? 'active' : ''}`} onClick={() => setStep(i + 1)}>
            <b><span className="step-num">{i + 1}</span>{label}</b>
            <span className="muted small">{['Log in with Meta, approve once', 'Profile + existing media into your library'][i]}</span>
          </button>
        ))}
      </div>

      {step === 1 && (
        <div className="card">
          <h2>Step 1 — Connect Instagram</h2>
          {settings?.instagramConnected ? (
            <p className="muted small" style={{ marginTop: 8 }}>Already connected{settings.instagramUsername ? ` as @${settings.instagramUsername}` : ''}. You can reconnect with a fresh Meta login, or continue.</p>
          ) : (
            <p className="muted small" style={{ marginTop: 8 }}>
              Tap the button and log in with Meta — Meta opens its own login page, you approve access once, and from then on the connection renews itself automatically. Your Instagram must be a Business or Creator account linked to a Facebook Page.
            </p>
          )}
          {err && <div className="alert error">{err}</div>}
          {connectMsg && <div className="alert success">{connectMsg}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" disabled={connectBusy} onClick={startConnect}>
              {connectBusy ? 'Opening Meta login…' : settings?.instagramConnected ? 'Reconnect Instagram' : 'Connect Instagram'}
            </button>
            {settings?.instagramConnected && <button type="button" className="btn ghost" onClick={() => setStep(2)}>Continue →</button>}
            <button type="button" className="btn ghost" disabled={finishing} onClick={markDone}>Skip setup</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h2>Step 2 — Import my Instagram</h2>
          <p className="muted small" style={{ marginTop: 8 }}>
            This pulls your account&apos;s profile (username, picture, bio, media count) and your existing posts into the library and queue as published posts, with their original captions and links.
          </p>
          <p className="muted small" style={{ marginTop: 8 }}>
            <b style={{ color: 'var(--ink)' }}>Followers and DMs cannot be imported</b> — Meta does not allow it.
          </p>

          {profile && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16, padding: 12, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface-2)' }}>
              {profile.profilePictureUrl && <img src={profile.profilePictureUrl} alt="" style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover' }} />}
              <div>
                <b>@{profile.username}</b>
                {profile.biography && <p className="muted small">{profile.biography}</p>}
                <p className="muted small">{profile.mediaCount} posts on Instagram</p>
              </div>
            </div>
          )}

          {(importing || job) && (
            <div style={{ marginTop: 16 }}>
              <p><b>{job?.status === 'done' ? 'Import finished' : job?.status === 'error' ? 'Import stopped' : 'Importing…'}</b></p>
              <p className="muted small" style={{ marginTop: 4 }}>
                Found {job?.fetched ?? 0} post{job?.fetched === 1 ? '' : 's'} so far · {job?.importedMedia ?? 0} saved to your media library · {job?.importedPosts ?? 0} added to your queue as published.
              </p>
              {job?.message && <div className="alert success">{job.message}</div>}
              {job?.error && <div className="alert error">{job.error}</div>}
            </div>
          )}
          {err && <div className="alert error">{err}</div>}

          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            {!job?.done && (
              <button type="button" className="btn primary" disabled={importing} onClick={startImport}>
                {importing ? 'Importing…' : job ? 'Retry import' : 'Import my Instagram'}
              </button>
            )}
            {job?.done && job?.status === 'done' && (
              <button type="button" className="btn primary" disabled={finishing} onClick={markDone}>Finish — go to my scheduler</button>
            )}
            <button type="button" className="btn ghost" onClick={() => setStep(1)}>← Back</button>
            <button type="button" className="btn ghost" disabled={finishing} onClick={markDone}>Skip this step</button>
          </div>
        </div>
      )}
    </div>
  )
}
