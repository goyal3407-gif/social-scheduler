// Overlay registry (Phase 3, Batch B): component-local overlays that
// are not owned by the App shell (post-row menus, bottom sheets) can
// register a closer while they are open. The Android hardware-back
// handler in App.jsx consults this registry FIRST, so back closes the
// topmost overlay before it ever touches tab history — the order the
// design system specifies (sheet/modal → menu/drawer → tab history →
// Home → exit).
const closers = []

export function registerOverlayCloser(fn) {
  closers.push(fn)
  return () => {
    const i = closers.indexOf(fn)
    if (i >= 0) closers.splice(i, 1)
  }
}

// Closes the most recently registered overlay, if any. Returns true
// when something was closed (the caller should stop there).
export function closeTopOverlay() {
  const fn = closers[closers.length - 1]
  if (!fn) return false
  fn()
  return true
}
