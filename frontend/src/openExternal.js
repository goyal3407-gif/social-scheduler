// External-link handling (Phase 3, Batch C — audit H-05, design
// system §6.2). Inside the native app, external URLs must open in
// the system browser (window.open '_system' — the mechanism the
// connect flows already use) instead of navigating the WebView away
// from the app with no way back. On the web nothing changes: links
// keep their normal target=_blank behaviour.
//
// The native check reads window.Capacitor directly (no imports) so
// this module never pulls Capacitor packages into a chunk.
export function isNativeShell() {
  try { return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) } catch { return false }
}

// Returns true when the URL was handed to the system browser (the
// caller should preventDefault its anchor); false on the web.
export function openExternalUrl(url) {
  if (!isNativeShell()) return false
  try { window.open(url, '_system'); return true } catch { return false }
}
