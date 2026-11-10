import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

const APP_DASHBOARD_URL = 'https://developers.facebook.com/apps/1671693167666941'

// Two-step setup wizard shown after first login:
// 1. Connect Instagram (guided token flow, verified live).
// 2. Import the connected account's profile + existing posts.
// Followers and DMs cannot be imported — Meta does not allow it.
// Either step can be skipped.
export default function SetupWizard({ settings, onDone, onInstagramChanged }) {
  const [step, setStep] = useState(settings?.instagramConnected ? 2 : 1)
  const [token, setToken] = useState('')
  const [igUserId, setIgUserId] = useState('')
  const [connecting, setConnecting] = useState(false)
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

  const connect = async (e) => {
    e.preventDefault()
    setErr(''); setConnectMsg('')
    if (!token.trim()) { setErr('Paste your access token first.'); return }
    setConnecting(true)
    try {
      const res = await api.connectInstagram(token.trim(), igUserId.trim() || undefined)
      setConnectMsg(res.username ? `Connected as @${res.username}.` : 'Connected — token verified with Instagram.')
      setToken('')
      if (onInstagramChanged) await onInstagramChanged()
      setStep(2)
    } catch (e2) {
      setErr(e2.message || 'Could not verify this token.')
    } finally { setConnecting(false) }
  }

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
            <span className="muted small">{['Paste your token, verified live', 'Profile + existing media into your library'][i]}</span>
          </button>
        ))}
      </div>

      {step === 1 && (
        <form className="card" onSubmit={connect}>
          <h2>Step 1 — Connect Instagram</h2>
          {settings?.instagramConnected ? (
            <p className="muted small" style={{ marginTop: 8 }}>Already connected{settings.instagramUsername ? ` as @${settings.instagramUsername}` : ''}. You can paste a new token to reconnect, or continue.</p>
          ) : (
            <ol className="muted small" style={{ marginTop: 10, paddingLeft: 18, lineHeight: 2 }}>
              <li>Open your Meta app dashboard: <a href={APP_DASHBOARD_URL} target="_blank" rel="noreferrer">developers.facebook.com/apps/1671693167666941</a></li>
              <li>Go to <b style={{ color: 'var(--ink)' }}>API Setup</b> &gt; <b style={{ color: 'var(--ink)' }}>Generate token</b></li>
              <li>Copy the token</li>
              <li>Paste it below and press “Save &amp; test connection”</li>
            </ol>
          )}
          <p className="muted small" style={{ marginTop: 10 }}>
            This works for your own Instagram only — the app is in development mode, so no App Review is needed for your own account.
          </p>
          <label htmlFor="wizToken" style={{ marginTop: 14 }}>Access token</label>
          <input id="wizToken" type="password" autoComplete="off" placeholder="Paste your Instagram access token" value={token} onChange={(e) => setToken(e.target.value)} />
          <label htmlFor="wizIgId" style={{ marginTop: 14 }}>Instagram User ID <span className="muted">(optional if set on the server)</span></label>
          <input id="wizIgId" placeholder="e.g. 178414…" value={igUserId} onChange={(e) => setIgUserId(e.target.value)} />
          {err && <div className="alert error">{err}</div>}
          {connectMsg && <div className="alert success">{connectMsg}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button type="submit" className="btn primary" disabled={connecting || !token.trim()}>{connecting ? 'Testing…' : 'Save & test connection'}</button>
            {settings?.instagramConnected && <button type="button" className="btn ghost" onClick={() => setStep(2)}>Continue →</button>}
            <button type="button" className="btn ghost" disabled={finishing} onClick={markDone}>Skip setup</button>
          </div>
        </form>
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
