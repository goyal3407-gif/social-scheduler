import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { trFor, dictSync, loadDict } from '../i18n.js'
import GoogleButton from './GoogleButton.jsx'
import { Logo } from './shared.jsx'
import { IconEye, IconEyeOff } from './icons.jsx'

// The compact brand row (34px logo + name, subtitle under it) —
// shared by the Auth screens and the reset screen (R2-L11).
// Round 3 (B4): the mark is B3's shared <Logo/> (theme-swapped
// transparent artwork), not the old /icon-192.png tile.
function BrandHead({ subtitle }) {
  return (
    <div className="auth-head">
      <div className="auth-brand-row">
        <Logo size={34} />
        <span className="auth-name">KiluaAI</span>
      </div>
      <p className="muted">{subtitle}</p>
    </div>
  )
}

// The "back to the landing page" link shown on the split login
// screen (login split, Prompt-4).
function BackLink({ tr, onBack }) {
  if (!onBack) return null
  return <button type="button" className="auth-switch" onClick={onBack}>← {tr('authBackHome')}</button>
}

// The branded boot state shown while the dictionary chunk lands
// (the same markup the app shell's gates use).
function AuthBootLoad({ lang }) {
  return (
    <div className="boot-load" role="status">
      <Logo size={52} />
      <span className="boot-spinner" aria-hidden="true" />
      <span className="muted small">{trFor(lang, null)('loading')}</span>
    </div>
  )
}

// Round 3 (B4): on a client-side validation failure, focus moves to
// the first invalid field (presentation behaviour only — the
// validation rules themselves are unchanged).
function focusField(id) {
  try { const el = document.getElementById(id); if (el) el.focus() } catch { /* no DOM */ }
}

// Login / sign-up screen. Shown on its own — no app content, no queue,
// no stats — until the server confirms a session.
// Minimal layout: no card, just a narrow column on the plain
// background — small gold logo, wordmark, fields, one dark button.
// With `bare` (used inside the public Landing page, Phase F) the
// branding head and the closing tagline are skipped: the landing hero
// above the form already carries the name, logo and the explanation,
// and the landing page only describes features that are live today.
export default function Auth({ onAuth, bare = false, initialMode = 'login', onBack }) {
  const [mode, setMode] = useState(initialMode) // 'login' | 'signup' | 'forgot'
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [gError, setGError] = useState('')
  const [busy, setBusy] = useState(false)
  // Round 2 (D-1 / R2-M1): EVERY string on this screen renders
  // through the dictionary, like everywhere else — the screen gates
  // on loadDict() exactly like the app shell, so nothing flashes as
  // a raw key and nothing stays English in Hinglish mode. (The four
  // oldest strings — divider, Google lines — live in i18n.js CORE;
  // the rest of this screen's strings live in DICT.) The persisted
  // language choice is read the same way the app shell reads it.
  const [lang] = useState(() => { try { return localStorage.getItem('ss-lang') || 'en' } catch { return 'en' } })
  const [dict, setDict] = useState(() => dictSync())
  useEffect(() => {
    let live = true
    loadDict().then((d) => { if (live) setDict(d) })
    return () => { live = false }
  }, [])
  const tr = trFor(lang, dict)
  // Google sign-in shows everywhere: on the web it is the GIS button;
  // inside the native app (where Google blocks WebView sign-in) the
  // button opens the system-browser flow instead — GoogleButton
  // decides which one to render.
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
    <div className="alert error auth-banner" role="status">{appStatus.maintenanceMessage || tr('authMaintDefault')}</div>
  ) : null

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!email.trim() || !password) { setError(tr('authErrEmailPw')); focusField(!email.trim() ? 'authEmail' : 'authPassword'); return }
    if (mode === 'signup' && password.length < 8) { setError(tr('authErrPwShort')); focusField('authPassword'); return }
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
      setError(err.message || tr('authErrGeneric'))
    } finally { setBusy(false) }
  }

  // Sign in with Google: the GIS button hands back a signed ID
  // token; the server verifies it and answers with the same session
  // a password login gets, so success lands exactly the same way.
  const onGoogleCredential = async (idToken) => {
    setError(''); setGError('')
    setBusy(true)
    try {
      const refCode = (() => { try { return new URLSearchParams(window.location.search).get('ref') || undefined } catch { return undefined } })()
      const res = await api.googleLogin(idToken, refCode)
      onAuth(res.user)
    } catch (err) {
      setGError(err.message || tr('googleSignInFailed'))
    } finally { setBusy(false) }
  }

  // Forgot password: the server answers the same generic success for
  // every email (account or not), so this screen can too — it never
  // confirms whether the email is registered.
  const submitForgot = async (e) => {
    e.preventDefault()
    setError(''); setNotice('')
    if (!email.trim()) { setError(tr('authErrEmailFirst')); focusField('forgotEmail'); return }
    setBusy(true)
    try {
      await api.forgotPassword(email.trim())
      setNotice(tr('authForgotNotice'))
    } catch (err) {
      setError(err.message || tr('authErrResetSend'))
    } finally { setBusy(false) }
  }

  // Dictionary gate (the shell's own pattern): until DICT lands the
  // screen shows the branded boot state instead of raw keys.
  if (!dict) return <AuthBootLoad lang={lang} />

  // Round 2 (R2-L11): the standalone screens carry the same compact
  // brand row as the Landing page instead of the old 52px header.
  const brandHead = (subtitle) => (!bare ? <BrandHead subtitle={subtitle} /> : null)

  if (mode === 'forgot') {
    return (
      <div className="auth-wrap">
        <BackLink tr={tr} onBack={onBack} />
        {brandHead(tr('authResetHead'))}
        {maintBanner}
        <form onSubmit={submitForgot}>
          <label htmlFor="forgotEmail">{tr('authEmailLabel')}</label>
          <input id="forgotEmail" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <div className="alert error" role="alert">{error}</div>}
          {notice && <div className="alert success">{notice}</div>}
          <button type="submit" className="btn primary block mt2" disabled={busy}>{busy ? tr('authPleaseWait') : tr('authSendResetBtn')}</button>
          <p className="muted small auth-note">
            {tr('authRemembered')}{' '}
            <button type="button" className="auth-switch" onClick={() => { setMode('login'); setError(''); setNotice('') }}>{tr('authBackToLogin')}</button>
          </p>
        </form>
      </div>
    )
  }

  return (
    <div className="auth-wrap">
      <BackLink tr={tr} onBack={onBack} />
      {brandHead(mode === 'signup' ? tr('authSignupHead') : tr('authLoginHead'))}
      {maintBanner}
      <form onSubmit={submit}>
        {mode === 'signup' && (
          <>
            <label htmlFor="authName">{tr('authNameLabel')}</label>
            <input id="authName" type="text" autoComplete="name" placeholder={tr('authNamePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
          </>
        )}
        <label htmlFor="authEmail" className={mode === 'signup' ? 'auth-label-gap' : undefined}>{tr('authEmailLabel')}</label>
        <input id="authEmail" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="authPassword" className="auth-label-gap">{tr('authPasswordLabel')}</label>
        <div className="pw-field">
          <input id="authPassword" type={showPw ? 'text' : 'password'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder={mode === 'signup' ? tr('authPwPlaceholderNew') : tr('authPwPlaceholder')} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="button" className="pw-eye" onClick={() => setShowPw(!showPw)} aria-label={showPw ? tr('ariaHidePassword') : tr('ariaShowPassword')}>{showPw ? <IconEyeOff size={19} /> : <IconEye size={19} />}</button>
        </div>
        {mode === 'signup' && <p className="field-helper">{tr('authPwHint')}</p>}
        {mode === 'login' && (
          <p className="auth-forgot-row">
            <button type="button" className="auth-switch" onClick={() => { setMode('forgot'); setError('') }}>{tr('authForgotLink')}</button>
          </p>
        )}
        {error && <div className="alert error" role="alert">{error}</div>}
        {signupsPaused ? (
          <div className="alert error auth-alert-top">{tr('authSignupsPaused')}</div>
        ) : (
          <button type="submit" className="btn primary block mt2" disabled={busy}>
            {busy ? tr('authPleaseWait') : mode === 'signup' ? tr('authSignupBtn') : tr('authLoginBtn')}
          </button>
        )}
      </form>
      {!signupsPaused && (
        <>
          <div className="auth-divider" aria-hidden="true"><span>{tr('authOrDivider')}</span></div>
          {gError && <div className="alert error auth-gerror" role="alert">{gError}</div>}
          <GoogleButton mode={mode} onCredential={onGoogleCredential} onFailure={() => setGError(tr('googleSignInFailed'))} appLabel={tr('googleContinueApp')} appHint={tr('googleAppHint')} loadFailedText={tr('googleLoadFailed')} />
        </>
      )}
      <p className="muted small auth-note">
        {mode === 'signup' ? tr('authHaveAccount') : tr('authNoAccount')}
        <button type="button" className="auth-switch" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); setGError('') }}>
          {mode === 'signup' ? tr('authLoginBtn') : tr('authSignupSwitch')}
        </button>
      </p>
      <p className="muted small auth-note">{tr('authTrustLine')}</p>
      {!bare && (
        <p className="muted small auth-note-lg">
          {tr('authTagline')}
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
  // Round 2 (D-1 / R2-M1): same dictionary wiring + gate as Auth.
  const [lang] = useState(() => { try { return localStorage.getItem('ss-lang') || 'en' } catch { return 'en' } })
  const [dict, setDict] = useState(() => dictSync())
  useEffect(() => {
    let live = true
    loadDict().then((d) => { if (live) setDict(d) })
    return () => { live = false }
  }, [])
  const tr = trFor(lang, dict)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!token) { setError(tr('resetErrInvalidLink')); return }
    if (password.length < 8) { setError(tr('resetErrShort')); focusField('resetPassword'); return }
    if (password !== confirm) { setError(tr('resetErrMismatch')); focusField('resetConfirm'); return }
    setBusy(true)
    try {
      await api.resetPassword(token, password)
      setDone(true)
    } catch (err) {
      setError(err.message || tr('resetErrGeneric'))
    } finally { setBusy(false) }
  }

  if (!dict) return <AuthBootLoad lang={lang} />

  return (
    <div className="auth-wrap">
      <BrandHead subtitle={tr('resetHead')} />
      {done ? (
        <div>
          <div className="alert success">{tr('resetDoneMsg')}</div>
          <button type="button" className="btn primary block mt2" onClick={() => { window.location.href = '/' }}>{tr('resetGoLogin')}</button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="resetPassword">{tr('resetNewPwLabel')}</label>
          <div className="pw-field">
            <input id="resetPassword" type={showPw ? 'text' : 'password'} autoComplete="new-password" placeholder={tr('authPwPlaceholderNew')} value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="pw-eye" onClick={() => setShowPw(!showPw)} aria-label={showPw ? tr('ariaHidePassword') : tr('ariaShowPassword')}>{showPw ? <IconEyeOff size={19} /> : <IconEye size={19} />}</button>
          </div>
          <label htmlFor="resetConfirm" className="auth-label-gap">{tr('resetConfirmLabel')}</label>
          <input id="resetConfirm" type={showPw ? 'text' : 'password'} autoComplete="new-password" placeholder={tr('resetConfirmPlaceholder')} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {error && <div className="alert error" role="alert">{error}</div>}
          <button type="submit" className="btn primary block mt2" disabled={busy}>{busy ? tr('authPleaseWait') : tr('resetSetBtn')}</button>
          <p className="muted small auth-note">
            {tr('resetLinkBroken')}{' '}
            <button type="button" className="auth-switch" onClick={() => { window.location.href = '/' }}>{tr('authBackToLogin')}</button>
            {' '}{tr('resetLinkHelpTail')}
          </p>
        </form>
      )}
    </div>
  )
}
