import { useState } from 'react'
import { api } from '../api.js'

// Login / sign-up screen. Shown on its own — no app content, no queue,
// no stats — until the server confirms a session.
// Minimal layout: no card, just a narrow column on the plain
// background — small gold logo, wordmark, fields, one dark button.
export default function Auth({ onAuth }) {
  const [mode, setMode] = useState('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPw, setShowPw] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!email.trim() || !password) { setError('Enter your email and password.'); return }
    if (mode === 'signup' && password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setBusy(true)
    try {
      const res = mode === 'signup'
        ? await api.signup(email.trim(), password, name.trim() || undefined)
        : await api.login(email.trim(), password)
      onAuth(res.user)
    } catch (err) {
      setError(err.message || 'Could not sign in.')
    } finally { setBusy(false) }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-head">
        <div className="logo-mark auth-logo" aria-hidden="true"><img src="/icon-192.png" alt="" width="52" height="52" /></div>
        <h1 className="auth-wordmark">KiluaAI</h1>
        <p className="muted">{mode === 'signup' ? 'Create your account' : 'Log in to your account'}</p>
      </div>
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
        <button type="submit" className="btn block mt2" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}
        </button>
        <p className="muted small" style={{ marginTop: 16, textAlign: 'center' }}>
          {mode === 'signup' ? 'Already have an account? ' : 'No account yet? '}
          <button type="button" className="auth-switch" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError('') }}>
            {mode === 'signup' ? 'Log in' : 'Sign up'}
          </button>
        </p>
      </form>
      <p className="muted small" style={{ marginTop: 28, textAlign: 'center' }}>
        Schedule Reels, Feed posts &amp; Stories for Instagram, YouTube, Facebook and TikTok. Free forever.
      </p>
    </div>
  )
}
