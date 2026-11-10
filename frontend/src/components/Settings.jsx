import { useEffect, useState } from 'react'

export default function Settings({ settings, onSave, saving }) {
  const [handle, setHandle] = useState('')
  const [connected, setConnected] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (settings) {
      setHandle(settings.instagramHandle || '')
      setConnected(Boolean(settings.instagramConnected))
    }
  }, [settings])

  const submit = async (e) => {
    e.preventDefault()
    setErr(''); setMsg('')
    try {
      // NOTE: the access token itself is never entered or shown here.
      // The server reads it from its own environment/config; this form only
      // records the handle and the connected flag. If the server's contract
      // expects a token field, add it server-side — never in this UI.
      await onSave({ instagramHandle: handle.trim(), instagramConnected: connected })
      setMsg('Settings saved.')
    } catch (e2) {
      setErr(e2.message || 'Could not save settings.')
    }
  }

  return (
    <div>
      <h2 className="section-title">Settings</h2>
      <p className="section-sub">Connect Instagram so “Publish now” can go live. Your token stays on the server — it is never displayed here.</p>
      <div className="two-col" style={{ alignItems: 'start' }}>
        <form className="card" onSubmit={submit}>
          <h2>Instagram connection</h2>
          <p className="muted small mb">Status: {settings?.instagramConnected ? 'Connected' : 'Not connected'}{settings?.tokenConfigured ? ' · token configured on server' : ' · no token on server'}</p>
          <label htmlFor="igHandle">Instagram handle</label>
          <input id="igHandle" placeholder="@yourhandle" value={handle} onChange={(e) => setHandle(e.target.value)} />
          <label style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={connected} onChange={(e) => setConnected(e.target.checked)} style={{ width: 'auto' }} />
            Instagram is connected
          </label>
          <p className="muted small mt">To connect: add your Instagram access token to the server (environment / server config), then tick this box and save. If publishing fails with “Instagram not connected”, the server has no token yet.</p>
          {err && <div className="alert error">{err}</div>}
          {msg && <div className="alert success">{msg}</div>}
          <button type="submit" className="btn primary mt" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
        </form>
        <section className="card">
          <h2>About this app</h2>
          <p className="muted small" style={{ marginTop: 8 }}>Social Scheduler is free forever. Schedule Reels, Feed posts and Stories for Instagram, YouTube, Facebook and TikTok from one calm place.</p>
          <ul className="muted small" style={{ marginTop: 12, paddingLeft: 18, lineHeight: 1.9 }}>
            <li>Free forever — no trial, no card</li>
            <li>Your media, queue and templates are yours</li>
            <li>Publish live via the Instagram Graph API</li>
            <li>Works on phone and desktop</li>
          </ul>
          <p className="muted small mt">Made by <b style={{ color: 'var(--ink)' }}>Goyal Kumar</b>.</p>
        </section>
      </div>
    </div>
  )
}
