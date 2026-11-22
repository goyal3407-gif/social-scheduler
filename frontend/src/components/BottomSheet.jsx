import { useEffect } from 'react'
import { registerOverlayCloser } from '../overlayRegistry.js'
import { trFor, dictSync } from '../i18n.js'
import { IconX } from './icons.jsx'

// Bottom sheet (Round 2 / Prompt-4): a panel that rises from the
// bottom on phones and centres on wider screens. Backdrop tap,
// Escape and the Android back button (via the overlay registry)
// all close it. Used by the Studio drafts library and the Queue
// filters — one shared implementation so they can never drift.
// Lives in its own module so it ships with the lazy tab chunks,
// not the main bundle. Like shared.jsx's pieces it receives no tr
// prop, so it translates from the persisted language + the loaded
// dictionary, exactly like the shell does.
export default function BottomSheet({ title, onClose, children }) {
  let lang = 'en'
  try { lang = localStorage.getItem('ss-lang') || 'en' } catch { /* storage unavailable */ }
  const t = trFor(lang, dictSync())
  useEffect(() => registerOverlayCloser(onClose), [onClose])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <b>{title}</b>
          <button type="button" className="icon-btn" aria-label={t('dismiss')} onClick={onClose}><IconX size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
