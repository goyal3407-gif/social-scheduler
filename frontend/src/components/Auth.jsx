import { useState } from 'react'
import { api } from '../api.js'

// Login / sign-up screen. Shown on its own — no app content, no queue,
// no stats — until the server confirms a session.
export default function Auth({ onAuth }) {
  const [mode, setMode] = useState('login')
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
        ? await api.signup(email.trim(), password)
        : await api.login(email.trim(), password)
      onAuth(res.user)
    } catch (err) {
      setError(err.message || 'Could not sign in.')
    } finally { setBusy(false) }
  }

  return (
    <div className="wrap" style={{ maxWidth: 440, paddingTop: 48 }}>
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div className="logo-mark" aria-hidden="true" style={{ margin: '0 auto 12px', width: 48, height: 48, fontSize: 22 }}>▦</div>
        <h1 style={{ fontSize: 24 }}>Social Scheduler</h1>
        <p className="muted" style={{ marginTop: 6 }}>by Goyal Kumar · Free forever</p>
      </div>
      <form className="card" onSubmit={submit}>
        <h2>{mode === 'signup' ? 'Create your account' : 'Log in'}</h2>
        <p className="muted small" style={{ marginTop: 6, marginBottom: 16 }}>
          {mode === 'signup'
            ? 'The first account created becomes the account owner.'
            : 'Your posts, media and settings are private to your account.'}
        </p>
        <label htmlFor="authEmail">Email</label>
        <input id="authEmail" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="authPassword" style={{ marginTop: 14 }}>Password</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="authPassword" type={showPw ? 'text' : 'password'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="button" className="btn ghost small" style={{ flex: 'none' }} onClick={() => setShowPw(!showPw)} aria-label={showPw ? 'Hide password' : 'Show password'}>{showPw ? 'Hide' : 'Show'}</button>
        </div>
        {error && <div className="alert error">{error}</div>}
        <button type="submit" className="btn primary block mt" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}
        </button>
        <p className="muted small" style={{ marginTop: 14, textAlign: 'center' }}>
          {mode === 'signup' ? 'Already have an account? ' : 'No account yet? '}
          <button type="button" className="copy-btn" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError('') }}>
            {mode === 'signup' ? 'Log in' : 'Sign up'}
          </button>
        </p>
      </form>
      <p className="muted small" style={{ marginTop: 16, textAlign: 'center' }}>
        Schedule Reels, Feed posts &amp; Stories for Instagram, YouTube, Facebook and TikTok.
      </p>
    </div>
  )
}
