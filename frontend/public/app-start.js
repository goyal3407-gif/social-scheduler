// In-app Google sign-in — browser side (opened in the SYSTEM BROWSER
// from the Android app, because Google blocks WebView sign-in).
// Runs the standard GIS flow here; the signed ID token goes to
// POST /api/auth/google/app-code, which verifies it server-side and
// answers with a one-time return URL instead of a session. This page
// then navigates to that URL (the https return page the app claims).
// Kept in an external file on purpose: the site CSP has no
// 'unsafe-inline' for scripts.
(function () {
  var CLIENT_ID = '628297569656-dc5stqkpmdogk64e396paagapciai7vj.apps.googleusercontent.com';
  function fail(msg) {
    document.getElementById('err').textContent = msg ||
      'Google sign-in did not work — try again, or use your email and password in the app.';
  }
  function onCredential(resp) {
    if (!resp || !resp.credential) { fail(); return; }
    fetch('/api/auth/google/app-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: resp.credential }),
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (x) {
      if (x.ok && x.d && x.d.returnUrl) { window.location.replace(x.d.returnUrl); return; }
      fail(x.d && x.d.error);
    }).catch(function () { fail(); });
  }
  window.addEventListener('load', function () {
    try {
      window.google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential });
      window.google.accounts.id.renderButton(document.getElementById('gbtn'), {
        type: 'standard', theme: 'outline', size: 'large',
        text: 'signin_with', shape: 'rectangular', width: 320,
      });
    } catch (e) { fail(); }
  });
})();
