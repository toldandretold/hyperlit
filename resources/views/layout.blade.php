<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hyperlit</title>
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <!-- Add the <base> tag here to ensure correct resolution of relative URLs -->
    
    
    @yield('styles')<!-- Section for additional CSS files -->
</head>
<body>
    <div class="container">
        @yield('content')
    </div>

@yield('scripts')
    
</body>
</html>

