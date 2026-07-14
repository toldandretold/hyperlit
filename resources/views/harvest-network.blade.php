<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Knowledge Network — {{ $rootTitle }}</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/harvest-network.css'])
</head>
<body>
    <div id="hn-stage" aria-label="3D knowledge network"></div>

    <header class="hn-header">
        <h1>{{ $rootTitle }}</h1>
        @if($rootAuthor)
            <span>{{ $rootAuthor }}</span>
        @endif
        <a href="/source-yield-report-{{ $rootBook }}">&larr; Report</a>
        <a href="/{{ $rootBook }}">&larr; Book</a>
    </header>

    {{-- Click-selected work: citation details + links (bottom-left) --}}
    <aside class="hn-panel" id="hn-panel" hidden aria-label="Selected work"></aside>

    <div class="hn-legend" aria-hidden="true">
        <div><span class="dot" style="background:#e0e0e0"></span>Root book</div>
        <div><span class="dot" style="background:#27ae60"></span>Harvested</div>
        <div><span class="dot" style="background:#e74c3c"></span>Failed</div>
        <div><span class="dot" style="background:#e67e22"></span>Unverified</div>
        <div><span class="dot" style="background:#f1c40f"></span>Over budget</div>
        <div class="hn-axis-note">&#8592; x&nbsp;axis: year of publication &#8594;</div>
    </div>

    <div class="hn-tooltip" id="hn-tooltip" role="status"></div>
    <div class="hn-status" id="hn-status">Loading the knowledge network…</div>

    <script>
        window.__harvestNetwork = {
            rootBook: @json($rootBook),
            rootTitle: @json($rootTitle),
        };
    </script>
    @vite(['resources/js/harvestNetwork3d/main.ts'])
</body>
</html>
