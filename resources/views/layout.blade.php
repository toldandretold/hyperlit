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