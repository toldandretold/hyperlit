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

    <!-- Navigation overlay for immediate display -->
    <div id="initial-navigation-overlay" class="navigation-overlay" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.3); z-index: 10000;"></div>
    
    <script>
        // Show overlay immediately if we're loading from a navigation
        if (sessionStorage.getItem('navigationOverlayActive') === 'true') {
            document.getElementById('initial-navigation-overlay').style.display = 'block';
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