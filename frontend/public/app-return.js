// In-app Google sign-in — return page hand-off.
// In a plain browser this page is only the fallback ("return to the
// app"): it deliberately does NOT consume the one-time code — the app
// completes the sign-in. If the page is ever loaded inside the app's
// WebView (the app-link claim routes it there), hand the code to the
// SPA root instead, whose boot code exchanges it for the session.
(function () {
  try {
    var code = new URLSearchParams(window.location.search).get('code') || '';
    var native = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    if (code && native) window.location.replace('/?appcode=' + encodeURIComponent(code));
  } catch (e) { /* stay on the fallback page */ }
})();
