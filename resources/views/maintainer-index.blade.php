<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Workbenches — Hyperlit</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/maintainer-index.css'])
</head>
<body>
    @include('partials.maintainer-theme')

    {{-- The one place every operator workbench is listed. A new workbench is
         added to config/workbenches.php, which this page renders — see
         docs/workbenches.md. --}}
    <header class="mi-header">
        <h1>Workbenches</h1>
        <span class="mi-header-sub">admin-only operator tools</span>
        <a href="/">&larr; Hyperlit</a>
    </header>

    <main class="mi-main">
        @foreach ($groups as $group => $tools)
        <h2>{{ $group }}</h2>
        <ul class="mi-list">
            @foreach ($tools as $tool)
            <li>
                <a class="mi-card" href="{{ $tool['url'] }}">
                    <strong>{{ $tool['name'] }}</strong>
                    <code>{{ $tool['url'] }}</code>
                    <span>{{ $tool['purpose'] }}</span>
                </a>
            </li>
            @endforeach
        </ul>
        @endforeach

        <p class="mi-note">What each one does, how they are gated, and which are open to shelf owners: <code>docs/workbenches.md</code>.</p>
    </main>
</body>
</html>
