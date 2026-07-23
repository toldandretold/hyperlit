<!DOCTYPE html>
<html lang="en">
<head>
    <script>
        // Console banner
        console.log('%c\n██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ██╗     ██╗████████╗\n██║  ██║╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██║     ██║╚══██╔══╝\n███████║ ╚████╔╝ ██████╔╝█████╗  ██████╔╝██║     ██║   ██║   \n██╔══██║  ╚██╔╝  ██╔═══╝ ██╔══╝  ██╔══██╗██║     ██║   ██║   \n██║  ██║   ██║   ██║     ███████╗██║  ██║███████╗██║   ██║   \n╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝   ╚═╝   \n', 'color: #3B82F6; font-family: monospace; line-height: 1;');
        console.log('%cRead, write and publish hypertext literature\n%cGitHub: %chttps://github.com/toldandretold/hyperlit', 'color: #6B7280; font-size: 11px', 'color: #6B7280; font-size: 11px', 'color: #3B82F6; font-size: 11px');
        console.log('%cVerbose logs: logger.enableVerbose()  ·  logger.disableVerbose()  ·  logger.isVerbose()', 'color: #6B7280; font-size: 11px');
    </script>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <script>
        // Kill iOS Safari's auto-zoom on focusing a text field with font-size
        // under 16px. iOS ignores maximum-scale for USER pinch gestures (since
        // iOS 10), so pinch-zoom accessibility (WCAG 1.4.4) stays intact.
        // iOS-only: Android Chrome WOULD honour the cap and lose pinch-zoom,
        // so it must not get it. (MacIntel + maxTouchPoints catches iPadOS,
        // which masquerades as desktop Safari.)
        if (/iPad|iPhone|iPod/.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
            var viewportMeta = document.querySelector('meta[name="viewport"]');
            if (viewportMeta) {
                viewportMeta.setAttribute('content', viewportMeta.getAttribute('content') + ', maximum-scale=1.0');
            }
        }
    </script>
    <script>
        // Deploy self-heal: when a lazy chunk fails to load (a deploy replaced
        // the hashed /build/assets between this page's HTML and the moment a
        // dynamic import fired), reload ONCE to pick up the new HTML + assets
        // instead of wedging the app. vite:preloadError covers vite's preload
        // helper; unhandledrejection catches bare import() failures (Safari:
        // "Importing a module script failed", Chrome: "Failed to fetch
        // dynamically imported module"). One-shot guard (60s) prevents loops
        // when the server itself is the problem.
        (function () {
            function healChunkError() {
                try {
                    var last = Number(sessionStorage.getItem('hl_chunk_reload') || 0);
                    if (Date.now() - last < 60000) return; // already tried — don't loop
                    sessionStorage.setItem('hl_chunk_reload', String(Date.now()));
                } catch (e) { /* storage unavailable — still better to reload once */ }
                window.location.reload();
            }
            // NEVER preventDefault() on vite:preloadError: vite's preload
            // helper treats a cancelled event as "error handled" and lets the
            // failed import RESOLVE AS UNDEFINED — downstream code then dies on
            // `Cannot destructure ... from undefined` half-loaded instead of
            // failing loudly. Let the error throw; just schedule the reload.
            window.addEventListener('vite:preloadError', function () {
                healChunkError();
            });
            window.addEventListener('unhandledrejection', function (e) {
                var msg = String((e.reason && e.reason.message) || e.reason || '');
                if (/Importing a module script failed|dynamically imported module|error loading dynamically imported/i.test(msg)) {
                    healChunkError();
                }
            });
        })();
    </script>
    <title>{{ $pageTitle ?? 'Hyperlit' }}</title>
    <meta name="description" content="{{ $pageDescription ?? 'Read, write and publish hypertext literature' }}">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <link rel="canonical" href="{{ $canonicalUrl ?? url()->current() }}">
    <link rel="icon" type="image/png" href="{{ asset('favicon.png') }}?v=2">
    <link rel="apple-touch-icon" href="{{ asset('favicon.png') }}?v=2">

    {{-- Open Graph --}}
    <meta property="og:title" content="{{ $ogTitle ?? $pageTitle ?? 'Hyperlit' }}">
    <meta property="og:description" content="{{ $ogDescription ?? $pageDescription ?? 'Read, write and publish hypertext literature' }}">
    <meta property="og:type" content="{{ $ogType ?? 'website' }}">
    <meta property="og:url" content="{{ $ogUrl ?? url()->current() }}">
    <meta property="og:image" content="{{ $ogImage ?? asset('images/og-card.png') . '?v=3' }}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:type" content="image/png">
    <meta property="og:site_name" content="Hyperlit">

    {{-- Twitter Card --}}
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="{{ $ogTitle ?? $pageTitle ?? 'Hyperlit' }}">
    <meta name="twitter:description" content="{{ $ogDescription ?? $pageDescription ?? 'Read, write and publish hypertext literature' }}">
    <meta name="twitter:image" content="{{ $ogImage ?? asset('images/og-card.png') . '?v=3' }}">

    {{-- Keywords --}}
    @if(!empty($keywords))
    <meta name="keywords" content="{{ $keywords }}">
    @endif

    {{-- Google Scholar citation meta tags --}}
    @if(!empty($citationMeta))
    @foreach($citationMeta as $name => $value)
    <meta name="{{ $name }}" content="{{ $value }}">
    @endforeach
    @endif

    @yield('structured_data')
    <style>
        @media screen and (max-width: 768px) {
            html {
                transform: none !important;
            }
            @supports (-webkit-touch-callout: none) {
                /* iOS-specific orientation lock */
                body {
                    -webkit-transform-origin: top left;
                    transform-origin: top left;
                }
            }
        }
    </style>
    <script>
        // Lock screen orientation to portrait on mobile devices
        if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('portrait').catch(() => {
                // Orientation lock failed (requires fullscreen on some browsers)
            });
        }
    </script>
    
    @if(isset($userPreferences) && !empty($userPreferences))
    <script>window.__userPreferences = @json($userPreferences);</script>
    @endif
    <script>
        // Prevent white flash by setting background color before CSS loads
        (function() {
            var theme = localStorage.getItem('hyperlit_theme_preference');
            var colors = { light: '#F4ECD8', sepia: '#E8D7B8' };
            document.documentElement.style.backgroundColor = colors[theme] || '#221F20';
        })();
    </script>
    <script>
        // Apply the user's text-size preference synchronously, BEFORE first paint.
        // Otherwise the page renders at the CSS default (--font-size-base: 28px) and
        // only shrinks to the user's size once settingsContainer.applyTextAdjustments()
        // runs post-render — the visible "text sinks smaller" reflow on refresh.
        // An inline style on <html> outranks the stylesheet's :root default, so this
        // value wins even though it's set before the CSS files load.
        // Source of truth: server-injected window.__userPreferences (device-scoped),
        // falling back to localStorage (seeded on prior visits by seedFromServer()).
        (function() {
            try {
                var prefs = window.__userPreferences || {};
                var device = window.innerWidth <= 500 ? 'mobile' : 'desktop';
                var size = prefs['text_size_' + device] ?? prefs.text_size
                    ?? localStorage.getItem('hyperlit_text_size');
                if (size != null && size !== '') {
                    document.documentElement.style.setProperty('--font-size-base', parseInt(size, 10) + 'px');
                }
            } catch (e) {}
        })();
    </script>
    @yield('styles')
</head>

{{-- THIS IS THE FIX. THIS ONE LINE. --}}
<body data-page="{{ $pageType ?? 'unknown' }}">

    {{-- Skip link (WCAG 2.4.1): first focusable on every page; visually hidden
         until keyboard focus. Each page template provides the #main-start anchor. --}}
    <a href="#main-start" class="skip-link">Skip to content</a>

    <!-- Navigation overlay for immediate display - show by default, hide for special cases -->
    <div id="initial-navigation-overlay" class="navigation-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.3); z-index: 10000; pointer-events: none; display: block;">
        <div id="progress-overlay-wrapper" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: transparent; padding: 2em; width: 400px; max-width: 70vw;">
            <p class="progress-text" id="page-load-progress-text" style="color: #CBCCCC; text-align: center; margin: 0 0 1em 0; font-size: 16px;">Loading...</p>
            <div class="progress-bar-container" style="width: 100%; height: 20px; background: #ddd; border-radius: 10px; overflow: hidden; margin: 1em 0;">
                <div class="progress-bar" id="page-load-progress-bar" style="width: 5%; height: 100%; background: linear-gradient(to right, #EE4A95, #EF8D34, #4EACAE, #EE4A95); transition: width 0.3s;"></div>
            </div>
            <p class="progress-details" id="page-load-progress-details" style="color: #888; text-align: center; margin: 0.5em 0 0 0; font-size: 12px;">Initializing...</p>
        </div>
    </div>
    
    <script>
        // Hide overlay immediately for non-reader pages and new book creation
        const pageType = document.body.getAttribute('data-page');
        const isNewBookCreation = sessionStorage.getItem('pending_new_book_sync');
        const isImportedBook = sessionStorage.getItem('pending_import_book');
        const overlay = document.getElementById('initial-navigation-overlay');
        
        // Hide overlay for new book creation or imported books, but show for reader and home pages
        if (isNewBookCreation) {
            overlay.style.display = 'none';
            console.log('✅ Overlay hidden for new book creation - content is immediately available');
        } else if (isImportedBook) {
            overlay.style.display = 'none';
            console.log('✅ Overlay hidden for imported book - content is immediately available');
        } else if (pageType === 'reader' || pageType === 'home' || pageType === 'user') {
            // Overlay visible for these page types
        } else {
            // Hide overlay for other page types
            overlay.style.display = 'none';
            console.log('✅ Overlay hidden for other page types');
        }
        
        // Clear overlay when page is restored from cache (back button)
        window.addEventListener('pageshow', function(event) {
            if (event.persisted) {
                // Page was restored from cache, clear overlay and sessionStorage
                const overlay = document.getElementById('initial-navigation-overlay');
                if (overlay) {
                    overlay.style.display = 'none';
                }
                sessionStorage.removeItem('navigationOverlayActive');
                sessionStorage.removeItem('navigationTargetId');
                sessionStorage.removeItem('pending_import_book');
            }
        });
        
        // Also clear on visibility change as backup
        document.addEventListener('visibilitychange', function() {
            if (!document.hidden) {
                const overlay = document.getElementById('initial-navigation-overlay');
                if (overlay) {
                    overlay.style.display = 'none';
                }
                sessionStorage.removeItem('navigationOverlayActive');
                sessionStorage.removeItem('navigationTargetId');
                sessionStorage.removeItem('pending_import_book');
            }
        });
    </script>

    <div id="page-wrapper" class="container">
        @yield('content')
    </div>

    @yield('scripts')
    @if(session('edit_permission_denied'))
    <script>
        window.editPermissionDenied = true;
    </script>
    @endif

    <!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "d8043ef8f9484fffa2a00be19173a9ea"}'></script><!-- End Cloudflare Web Analytics -->

    <!-- Service Worker Registration for Offline Support -->
    <script>
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                // updateViaCache:'none' → sw.js itself always bypasses the HTTP
                // cache, and the explicit update() forces the version check every
                // load — so a new SW (skipWaiting+claim) takes over immediately
                // instead of a stale one lingering. A stale CacheFirst SW serving
                // mutated /media/ bytes broke the E2EE image passes + render.
                navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
                    .then((registration) => {
                        console.log('[SW] Registered with scope:', registration.scope);
                        registration.update();
                    })
                    .catch((error) => {
                        console.error('[SW] Registration failed:', error);
                    });
            });
        }
    </script>
</body>
</html>