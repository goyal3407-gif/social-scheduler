import { useEffect, useRef } from 'react'
import { isNativeShell } from '../openExternal.js'

// Sign in with Google — the official Google Identity Services button.
// The Client ID is a PUBLIC identifier (Google's own docs ship it in
// page source); there is no client secret anywhere in this flow —
// the browser receives a signed ID token and the SERVER verifies it
// against Google before issuing a session (POST /api/auth/google).
//
// Native shell: Google refuses to run its sign-in inside embedded
// WebViews, so inside the Capacitor app this renders NOTHING and
// email + password stays the in-app path. Web is unaffected.
export const GOOGLE_CLIENT_ID = '628297569656-dc5stqkpmdogk64e396paagapciai7vj.apps.googleusercontent.com'
const GIS_SRC = 'https://accounts.google.com/gsi/client'

let gisPromise = null
function loadGis() {
  try {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve(window.google)
  } catch { /* fall through to the script load */ }
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = GIS_SRC
      s.async = true
      s.defer = true
      s.onload = () => {
        try {
          if (window.google && window.google.accounts && window.google.accounts.id) resolve(window.google)
          else reject(new Error('gis-unavailable'))
        } catch { reject(new Error('gis-unavailable')) }
      }
      s.onerror = () => reject(new Error('gis-load-failed'))
      document.head.appendChild(s)
    })
  }
  return gisPromise
}

export default function GoogleButton({ mode, onCredential, onFailure }) {
  const ref = useRef(null)
  const cbRef = useRef({ onCredential, onFailure })
  cbRef.current = { onCredential, onFailure }
  const native = (() => { try { return isNativeShell() } catch { return false } })()

  useEffect(() => {
    if (native) return undefined
    let live = true
    loadGis()
      .then((g) => {
        if (!live || !ref.current) return
        g.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (resp) => {
            if (resp && resp.credential) cbRef.current.onCredential(resp.credential)
            else cbRef.current.onFailure()
          },
        })
        const w = Math.min(400, Math.max(200, ref.current.clientWidth || 320))
        g.accounts.id.renderButton(ref.current, {
          type: 'standard', theme: 'outline', size: 'large',
          text: mode === 'signup' ? 'signup_with' : 'signin_with',
          shape: 'rectangular', logo_alignment: 'left', width: w,
        })
      })
      // The GIS script itself could not load (offline, blocked):
      // stay silent — the button area simply remains empty and
      // email + password keeps working exactly as before.
      .catch(() => {})
    return () => { live = false }
  }, [mode, native])

  if (native) return null
  return <div ref={ref} className="auth-google" />
}
