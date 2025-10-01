<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hyperlit</title>
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    
    @yield('styles')
</head>

{{-- THIS IS THE FIX. THIS ONE LINE. --}}
<body data-page="{{ $pageType ?? 'unknown' }}">

    <!-- Navigation overlay for immediate display - show by default, hide for special cases -->
    <div id="initial-navigation-overlay" class="navigation-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.3); z-index: 10000; pointer-events: none;">
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
        } else if (pageType === 'reader') {
            console.log('🎯 Overlay visible for reader page load');
        } else if (pageType === 'home') {
            console.log('🎯 Overlay visible for home page load');
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
</body>
</html>