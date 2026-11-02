@extends('layout')

{{-- Hyperlit's own English UI (not book content) — declare the language,
     same as reset-password.blade.php. --}}
@php($htmlLang = 'en')

@section('styles')
    @vite(['resources/css/app.css', 'resources/css/pages/auth.css', 'resources/js/pages/oauthAuthorize.ts'])
    <style>
        /* The lava-lamp hills (homepage hero art) sit behind the card. Their
           component CSS lives in components/homepage.css, which this page
           does not load — these few rules are the standalone equivalent.
           The svg's HEIGHT is the artwork's framing, not just its size: it
           renders preserveAspectRatio="xMidYMax slice", so the viewBox bottom
           (BASE_Y, where every hill stands) pins to the element's bottom edge
           and the cover scale is max(w/1600, h/1000). Keep the homepage's
           +140px or the floor band lands on the fold and the art reads ~20%
           smaller than it does on home. The parallax transform is NOT copied:
           it's driven by homepageHero on scroll and this page doesn't scroll. */
        #lava-lamp-mount { position: fixed; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }
        #lava-lamp-mount .lava-lamp-bg { position: absolute; inset: 0; }
        #lava-lamp-mount .lava-lamp-bg svg { width: 100%; height: calc(100% + 140px); display: block; }
        /* app.css doesn't import base/layout.css (that ships with the page
           bundles), so standalone pages must set the brand font themselves
           or the browser serif default leaks through. */
        .oauth-page { font-family: var(--font-family-base, 'InterVariable', 'Inter', Arial, sans-serif); position: relative; z-index: 1; }
    </style>
@endsection

@section('content')
{{-- $abilityHelp comes from AuthorizationController. Do NOT define it in a
     php block directive here: Blade extracts php blocks from the RAW source
     (before comments are stripped), pairing the block's closing token with
     the FIRST php opener in the file — the one-liner above — and swallowing
     everything in between as raw PHP. Even naming the closing token in this
     comment broke compilation once. --}}
<div id="lava-lamp-mount" aria-hidden="true"></div>
<div class="oauth-page" style="display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; box-sizing: border-box;">
  <div style="width: 100%; max-width: 400px; background: var(--container-solid-bg, #1a1a1a); border-radius: 12px; padding: 30px; box-shadow: 0 0 20px rgba(0,0,0,0.3);">

    @if ($error)
      <h2 style="color: var(--color-secondary); margin: 0 0 8px;">Connection refused</h2>
      <p style="font-size: 13px; color: var(--color-text); opacity: 0.8; margin: 0 0 16px;">{{ $error }}</p>
      <a href="/" style="display:block; text-align:center; font-size:12px; color: var(--color-text); opacity:0.6; margin-top:12px; text-decoration:none;">Back to Hyperlit</a>

    @elseif (! auth()->check())
      <h2 style="color: var(--color-secondary); margin: 0 0 8px;">Sign in to Hyperlit</h2>
      <p style="font-size: 13px; color: var(--color-text); opacity: 0.7; margin: 0 0 24px;">
        <strong>{{ $clientName }}</strong> is asking to connect to your Hyperlit account. Sign in to continue.
      </p>

      <div id="oauth-alert" style="display:none; font-size:12px; padding:10px; border-radius:4px; margin-bottom:16px;"></div>

      <form id="oauth-login-form" autocomplete="on" style="display: block;">
        <div style="margin-bottom: 14px;">
          <input type="email" id="oauth-email" name="email" placeholder="Email" required autocomplete="email"
                 style="width: 100%; padding: 9px; border-radius: 4px; border: none; background: var(--container-bg, #111); color: var(--color-text); box-sizing: border-box; font-size: 14px; font-family: Inter, Arial, sans-serif;">
        </div>
        <div style="margin-bottom: 20px;">
          <input type="password" id="oauth-password" name="password" placeholder="Password" required autocomplete="current-password"
                 style="width: 100%; padding: 9px; border-radius: 4px; border: none; background: var(--container-bg, #111); color: var(--color-text); box-sizing: border-box; font-size: 14px; font-family: Inter, Arial, sans-serif;">
        </div>
        <button type="submit" id="oauth-login-submit"
                style="width: 100%; padding: 10px; background: var(--color-accent); color: var(--color-background); border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-family: Inter, Arial, sans-serif; font-weight: 600;">
          Sign in
        </button>
      </form>

    @else
      <h2 style="color: var(--color-secondary); margin: 0 0 8px;">Connect {{ $clientName }}?</h2>
      <p style="font-size: 13px; color: var(--color-text); opacity: 0.7; margin: 0 0 20px;">
        <strong>{{ $clientName }}</strong> (redirects to <strong>{{ $redirectHost }}</strong>) wants to access your
        Hyperlit account as <strong>{{ auth()->user()->name }}</strong>. Choose what it may do:
      </p>

      <div id="oauth-alert" style="display:none; font-size:12px; padding:10px; border-radius:4px; margin-bottom:16px;"></div>

      <form id="oauth-consent-form">
        @foreach ($abilities as $ability)
          <label style="display:flex; gap:10px; align-items:flex-start; margin-bottom:12px; cursor:pointer;">
            <input type="checkbox" name="scopes[]" value="{{ $ability }}"
                   @checked(in_array($ability, $defaultAbilities, true))
                   style="margin-top:3px;">
            <span style="font-size:13px; color: var(--color-text);">
              <strong>{{ $abilityHelp[$ability][0] ?? $ability }}</strong><br>
              <span style="opacity:0.65; font-size:12px;">{{ $abilityHelp[$ability][1] ?? '' }}</span>
            </span>
          </label>
        @endforeach

        <div style="display:flex; gap:10px; margin-top:20px;">
          <button type="button" id="oauth-deny"
                  style="flex:1; padding: 10px; background: transparent; color: var(--color-text); border: 1px solid var(--color-text); opacity:0.7; border-radius: 4px; cursor: pointer; font-size: 14px; font-family: Inter, Arial, sans-serif;">
            Deny
          </button>
          <button type="submit" id="oauth-approve"
                  style="flex:1; padding: 10px; background: var(--color-accent); color: var(--color-background); border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-family: Inter, Arial, sans-serif; font-weight: 600;">
            Approve
          </button>
        </div>
      </form>

      <p style="font-size:11px; color: var(--color-text); opacity:0.5; margin-top:16px;">
        This creates a revocable access token — manage it anytime under your user button
        → Data sovereignty → MCP for AI access.
      </p>
    @endif
  </div>
</div>

<script>
// CSP TRAP — do not convert these fetch() submits into plain form POSTs.
// SecurityHeaders sends `form-action 'self'`, and Chrome enforces form-action
// on the POST's redirect too: a classic consent form whose server 302s to
// https://claude.ai/... gets BLOCKED after submit. So the decision endpoint
// returns {redirect} as JSON and we navigate with window.location instead.

const oauthParams = @json($params);

function oauthShowAlert(msg) {
  const el = document.getElementById('oauth-alert');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = 'rgba(238,74,149,0.12)';
  el.style.color = 'var(--color-primary)';
}

function getCsrfFromCookie() {
  const value = `; ${document.cookie}`;
  const parts = value.split('; XSRF-TOKEN=');
  if (parts.length === 2) return decodeURIComponent(parts.pop().split(';').shift());
  return '';
}

const loginForm = document.getElementById('oauth-login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = document.getElementById('oauth-login-submit');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await fetch('/sanctum/csrf-cookie', { credentials: 'include' });
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-XSRF-TOKEN': getCsrfFromCookie(),
        },
        credentials: 'include',
        body: JSON.stringify({
          email: document.getElementById('oauth-email').value.trim(),
          password: document.getElementById('oauth-password').value,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && (data.success ?? true)) {
        // Reload with the full OAuth query string intact — the page
        // re-renders in the consent state now the session exists.
        window.location.reload();
      } else {
        oauthShowAlert(data.message || 'Sign-in failed. Check your email and password.');
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    } catch (err) {
      oauthShowAlert('A network error occurred. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}

const consentForm = document.getElementById('oauth-consent-form');
if (consentForm) {
  async function sendDecision(action) {
    const scopes = [...consentForm.querySelectorAll('input[name="scopes[]"]:checked')].map(cb => cb.value);
    if (action === 'approve' && scopes.length === 0) {
      oauthShowAlert('Select at least one permission, or press Deny.');
      return;
    }
    const approveBtn = document.getElementById('oauth-approve');
    const denyBtn = document.getElementById('oauth-deny');
    approveBtn.disabled = denyBtn.disabled = true;
    try {
      const response = await fetch('/oauth/authorize/decision', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-TOKEN': '{{ csrf_token() }}',
        },
        credentials: 'include',
        body: JSON.stringify({ ...oauthParams, action, scopes }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.reload(); // session expired mid-consent → login state
        return;
      }
      if (response.ok && data.redirect) {
        window.location.href = data.redirect;
      } else {
        oauthShowAlert(data.error_description || data.error || 'Something went wrong. Please try again.');
        approveBtn.disabled = denyBtn.disabled = false;
      }
    } catch (err) {
      oauthShowAlert('A network error occurred. Please try again.');
      approveBtn.disabled = denyBtn.disabled = false;
    }
  }

  consentForm.addEventListener('submit', function (e) {
    e.preventDefault();
    sendDecision('approve');
  });
  document.getElementById('oauth-deny').addEventListener('click', function () {
    sendDecision('deny');
  });
}
</script>
@endsection
