import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// A deploy that lands while a tab is open replaces the hashed chunks:
// a lazy import in the old tab can then fail and blank the app. Vite
// fires 'vite:preloadError' for exactly that case — reload ONCE per
// session to pick up the fresh build instead of white-paging. (The
// update guard banner in App.jsx covers the gentler case where the
// old tab is still usable.)
try {
  window.addEventListener('vite:preloadError', () => {
    try {
      if (!sessionStorage.getItem('ss-preload-reload')) {
        sessionStorage.setItem('ss-preload-reload', '1')
        window.location.reload()
      }
    } catch { /* storage unavailable — the banner is the fallback */ }
  })
} catch { /* very old browser — nothing to do */ }

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
