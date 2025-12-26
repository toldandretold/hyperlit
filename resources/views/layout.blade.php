<!DOCTYPE html>
<html lang="en">
<head>
    <script>
        // Console banner
        console.log('%c\n _   ___   ______  _____ ____  _     ___ _____\n| | | \\ \\ / /  _ \\| ____|  _ \\| |   |_ _|_   _|\n| |_| |\\ V /| |_) |  _| | |_) | |    | |  | |\n|  _  | | | |  __/| |___|  _ <| |___ | |  | |\n|_| |_| |_| |_|   |_____|_| \\_\\_____|___| |_|\n', 'color: #3B82F6; font-family: monospace;');
        console.log('%cRead, write and publish hypertext literature\n%cGitHub: %chttps://github.com/toldandretold/hyperlit', 'color: #6B7280; font-size: 11px', 'color: #6B7280; font-size: 11px', 'color: #3B82F6; font-size: 11px');
    </script>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hyperlit</title>
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
    <link rel="icon" type="image/png" href="{{ asset('favicon.png') }}?v=2">
    <link rel="apple-touch-icon" href="{{ asset('favicon.png') }}?v=2">
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
    
    @yield('styles')
</head>

{{-- THIS IS THE FIX. THIS ONE LINE. --}}
<body data-page="{{ $pageType ?? 'unknown' }}">

    <!-- Navigation overlay for immediate display - show by default, hide for special cases -->
    <div id="initial-navigation-overlay" class="navigation-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.3); z-index: 10000; pointer-events: none; display: block;">
        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: transparent; padding: 2em; width: 400px; max-width: 70vw;">
            <p class="progress-text" id="page-load-progress-text" style="color: #CBCCCC; text-align: center; margin: 0 0 1em 0; font-size: 16px;">Loading...</p>
            <div class="progress-bar-container">
                <div class="progress-bar" id="page-load-progress-bar" style="width: 5%;"></div>
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
                navigator.serviceWorker.register('/sw.js', { scope: '/' })
                    .then((registration) => {
                        console.log('[SW] Registered with scope:', registration.scope);
                    })
                    .catch((error) => {
                        console.error('[SW] Registration failed:', error);
                    });
            });
        }
    </script>
</body>
</html>