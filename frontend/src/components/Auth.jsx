import { useEffect, useState } from 'react'
import { api } from '../api.js'

// Login / sign-up screen. Shown on its own — no app content, no queue,
// no stats — until the server confirms a session.
// Minimal layout: no card, just a narrow column on the plain
// background — small gold logo, wordmark, fields, one dark button.
// With `bare` (used inside the public Landing page, Phase F) the
// branding head and the closing tagline are skipped: the landing hero
// above the form already carries the name, logo and the explanation,
// and the landing page only describes features that are live today.
export default function Auth({ onAuth, bare = false }) {
  const [mode, setMode] = useState('login') // 'login' | 'signup' | 'forgot'
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPw, setShowPw] = useState(false)
  // Public app status (batch 6): signups paused / maintenance mode,
  // set by the owner in the console. Fails silent — if the status
  // cannot load, the screen behaves exactly as before.
  const [appStatus, setAppStatus] = useState(null)
  useEffect(() => {
    let live = true
    api.getAppStatus().then((s) => { if (live) setAppStatus(s) }).catch(() => {})
    return () => { live = false }
  }, [])
  const signupsPaused = mode === 'signup' && !!appStatus && appStatus.signupOpen === false
  const maintBanner = appStatus && appStatus.maintenance ? (
    <div className="alert error" role="status" style={{ marginBottom: 14 }}>{appStatus.maintenanceMessage || 'KiluaAI is under quick maintenance — please try again in a few minutes.'}</div>
  ) : null

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!email.trim() || !password) { setError('Enter your email and password.'); return }
    if (mode === 'signup' && password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setBusy(true)
    try {
      // D11: a ?ref=CODE in the signup URL is passed through so the
      // inviter gets credited (unknown codes are ignored server-side).
      const refCode = (() => { try { return new URLSearchParams(window.location.search).get('ref') || undefined } catch { return undefined } })()
      const res = mode === 'signup'
        ? await api.signup(email.trim(), password, name.trim() || undefined, refCode)
        : await api.login(email.trim(), password)
      onAuth(res.user)
    } catch (err) {
      setError(err.message || 'Could not sign in.')
    } finally { setBusy(false) }
  }

  // Forgot password: the server answers the same generic success for
  // every email (account or not), so this screen can too — it never
  // confirms whether the email is registered.
  const submitForgot = async (e) => {
    e.preventDefault()
    setError(''); setNotice('')
    if (!email.trim()) { setError('Enter your email address first.'); return }
    setBusy(true)
    try {
      await api.forgotPassword(email.trim())
      setNotice('If an account exists for that email, a reset link is on its way. Check your inbox (and spam folder) — the link works for 60 minutes.')
    } catch (err) {
      setError(err.message || 'Could not send the reset link.')
    } finally { setBusy(false) }
  }

  if (mode === 'forgot') {
    return (
      <div className="auth-wrap">
        {!bare && (
          <div className="auth-head">
            <div className="logo-mark auth-logo" aria-hidden="true"><img src="/icon-192.png" alt="" width="52" height="52" /></div>
            <h1 className="auth-wordmark">KiluaAI</h1>
            <p className="muted">Reset your password</p>
          </div>
        )}
        {maintBanner}
        <form onSubmit={submitForgot}>
          <label htmlFor="forgotEmail">Email</label>
          <input id="forgotEmail" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <div className="alert error">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
          <button type="submit" className="btn block mt2" disabled={busy}>{busy ? 'Please wait…' : 'Send reset link'}</button>
          <p className="muted small" style={{ marginTop: 16, textAlign: 'center' }}>
            Remembered it?{' '}
            <button type="button" className="auth-switch" onClick={() => { setMode('login'); setError(''); setNotice('') }}>Back to log in</button>
          </p>
        </form>
      </div>
    )
  }

  return (
    <div className="auth-wrap">
      {!bare && (
        <div className="auth-head">
          <div className="logo-mark auth-logo" aria-hidden="true"><img src="/icon-192.png" alt="" width="52" height="52" /></div>
          <h1 className="auth-wordmark">KiluaAI</h1>
          <p className="muted">{mode === 'signup' ? 'Create your account' : 'Log in to your account'}</p>
        </div>
      )}
      {maintBanner}
      <form onSubmit={submit}>
        {mode === 'signup' && (
          <>
            <label htmlFor="authName">Name</label>
            <input id="authName" type="text" autoComplete="name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          </>
        )}
        <label htmlFor="authEmail" style={mode === 'signup' ? { marginTop: 14 } : undefined}>Email</label>
        <input id="authEmail" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="authPassword" style={{ marginTop: 14 }}>Password</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="authPassword" type={showPw ? 'text' : 'password'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="button" className="btn ghost small" style={{ flex: 'none' }} onClick={() => setShowPw(!showPw)} aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? 'Hide' : 'Show'}</button>
        </div>
        {error && <div className="alert error">{error}</div>}
        {signupsPaused ? (
          <div className="alert error" style={{ marginTop: 16 }}>Signups are paused right now — please try again later. If you already have an account, log in instead.</div>
        ) : (
          <button type="submit" className="btn block mt2" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}
          </button>
        )}
        {mode === 'login' && (
          <p className="muted small" style={{ marginTop: 12, textAlign: 'center' }}>
            <button type="button" className="auth-switch" onClick={() => { setMode('forgot'); setError('') }}>Forgot password?</button>
          </p>
        )}
        <p className="muted small" style={{ marginTop: 16, textAlign: 'center' }}>
          {mode === 'signup' ? 'Already have an account? ' : 'No account yet? '}
          <button type="button" className="auth-switch" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError('') }}>
            {mode === 'signup' ? 'Log in' : 'Sign up'}
          </button>
        </p>
      </form>
      {!bare && (
        <p className="muted small" style={{ marginTop: 28, textAlign: 'center' }}>
          Schedule Reels, Feed posts &amp; Stories for Instagram, YouTube, Facebook and TikTok. Free forever.
        </p>
      )}
    </div>
  )
}

// The /reset page the emailed link lands on: reads the one-time token
// from the URL, asks for a new password, and hands off to the server.
// Every token problem (missing, wrong, expired, already used) shows
// the same plain message with a path back to "Forgot password?".
export function ResetPassword() {
  const [token] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('token') || '' } catch { return '' }
  })
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showPw, setShowPw] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!token) { setError('That reset link is not valid or has expired — request a new one from the login screen.'); return }
    if (password.length < 8) { setError('The new password must be at least 8 characters long.'); return }
    if (password !== confirm) { setError('The two passwords do not match — type the same one twice.'); return }
    setBusy(true)
    try {
      await api.resetPassword(token, password)
      setDone(true)
    } catch (err) {
      setError(err.message || 'Could not reset the password.')
    } finally { setBusy(false) }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-head">
        <div className="logo-mark auth-logo" aria-hidden="true"><img src="/icon-192.png" alt="" width="52" height="52" /></div>
        <h1 className="auth-wordmark">KiluaAI</h1>
        <p className="muted">Choose a new password</p>
      </div>
      {done ? (
        <div>
          <div className="alert success">Your password has been changed. Every device was logged out — log in with the new password.</div>
          <button type="button" className="btn block mt2" onClick={() => { window.location.href = '/' }}>Go to log in</button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="resetPassword">New password</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="resetPassword" type={showPw ? 'text' : 'password'} autoComplete="new-password" placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn ghost small" style={{ flex: 'none' }} onClick={() => setShowPw(!showPw)} aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? 'Hide' : 'Show'}</button>
          </div>
          <label htmlFor="resetConfirm" style={{ marginTop: 14 }}>Type it again</label>
          <input id="resetConfirm" type={showPw ? 'text' : 'password'} autoComplete="new-password" placeholder="Same password again" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {error && <div className="alert error">{error}</div>}
          <button type="submit" className="btn block mt2" disabled={busy}>{busy ? 'Please wait…' : 'Set new password'}</button>
          <p className="muted small" style={{ marginTop: 16, textAlign: 'center' }}>
            Link not working?{' '}
            <button type="button" className="auth-switch" onClick={() => { window.location.href = '/' }}>Back to log in</button>
            {' '}and use “Forgot password?” for a fresh link.
          </p>
        </form>
      )}
    </div>
  )
}
