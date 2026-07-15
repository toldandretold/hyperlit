<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ $focusTitle ? $focusTitle . ' — in the Docuverse' : 'The Docuverse — Hyperlit' }}</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/pages/docuverse.css'])
</head>
<body>
    {{-- Theme before paint: the READER's storage key, so the page opens in
         whatever theme the user reads in (docuverse3d/main.ts writes the same
         key back when the picker below changes it). --}}
    <script>
        (function () {
            var t = 'dark';
            try { t = localStorage.getItem('hyperlit_theme_preference') || 'dark'; } catch (e) {}
            if (['dark', 'light', 'sepia'].indexOf(t) === -1) t = 'dark';
            document.body.classList.add('theme-' + t);
        })();
    </script>

    <div id="dv-stage" aria-label="3D docuverse map"></div>

    <header class="dv-header">
        @if($focusBook)
            <h1>{{ $focusTitle }}</h1>
            <span class="dv-header-sub">in the docuverse</span>
            <a href="/{{ $focusBook }}">&larr; Book</a>
            <a href="/3d/docuverse">Whole docuverse &rarr;</a>
        @else
            <h1>The Docuverse</h1>
            <a href="/">&larr; Hyperlit</a>
        @endif
    </header>

    {{-- Connection-layer control: which edges wire the map (refetches on change) --}}
    <fieldset class="dv-layers dv-glass" aria-label="Connection layers">
        <legend>
            <button type="button" class="dv-collapse-toggle" data-target="dv-layers-body" aria-expanded="true">Connected by</button>
        </legend>
        <div id="dv-layers-body">
            <label><input type="checkbox" value="hypercite" checked>
                <span class="swatch" style="background:linear-gradient(to right, var(--hyperlit-pink), var(--hyperlit-orange), var(--hyperlit-aqua))"></span>Hypercites</label>
            {{-- ONE citations layer: the API's verified/auto split is not a
                 user-facing distinction (verification is a rare manual act —
                 splitting them made citations look absent). The compound value
                 requests both kinds; main.ts splits on ','. --}}
            <label><input type="checkbox" value="citation_verified,citation_auto" checked>
                <span class="swatch" style="background:var(--dv-edge-citation)"></span>Citations</label>
        </div>
    </fieldset>

    <div class="dv-legend dv-glass">
        <button type="button" class="dv-collapse-toggle" data-target="dv-legend-body" aria-expanded="true">Legend</button>
        <div id="dv-legend-body">
            @if($focusBook)
                <div><span class="dot" style="background:var(--color-text)"></span>This book</div>
            @endif
            <div><span class="dot" style="background:var(--dv-node-held)"></span>Canonical source <span class="dv-legend-sub">&mdash; verified on an external database</span></div>
            <div><span class="dot" style="background:var(--dv-node-book)"></span>Source <span class="dv-legend-sub">&mdash; in hyperlit, not linked to an external record</span></div>
            <div><span class="dot" style="background:var(--dv-node-canonical)"></span>Citation <span class="dv-legend-sub">&mdash; no source material yet</span></div>
            <div class="dv-axis-note">&#8592; x: year &middot; y: connectedness &#8594;</div>
        </div>
    </div>

    {{-- Theme picker (bottom-left): dark / light / sepia, reader-shared --}}
    <div class="dv-theme" id="dv-theme">
        <div class="dv-theme-picker dv-glass" id="dv-theme-picker" hidden>
            <button type="button" data-theme="dark">Dark</button>
            <button type="button" data-theme="light">Light</button>
            <button type="button" data-theme="sepia">Sepia</button>
        </div>
        <button type="button" class="dv-theme-toggle" id="dv-theme-toggle" aria-label="Switch theme" aria-haspopup="true" aria-expanded="false">&#9681;</button>
    </div>

    {{-- View controls (centre-bottom): zoom / reset / spaceship + how-to hint --}}
    <div class="dv-controls dv-glass" aria-label="View controls">
        <button type="button" id="dv-zoom-out" aria-label="Zoom out">&minus;</button>
        <button type="button" id="dv-reset" aria-label="Reset view">&#10226;</button>
        <button type="button" id="dv-zoom-in" aria-label="Zoom in">+</button>
        <button type="button" id="dv-fly" aria-label="Spaceship mode" aria-pressed="false">
            {{-- Mini Sputnik: sphere + four swept antennae --}}
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                <circle cx="15.5" cy="8.5" r="4.6" fill="currentColor"/>
                <g stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none">
                    <path d="M12.4 11.9 L2.5 20.5"/>
                    <path d="M13.6 13 L7.5 22.5"/>
                    <path d="M11.8 9.9 L1.5 14.5"/>
                    <path d="M15.2 13.2 L13.5 23"/>
                </g>
            </svg>
        </button>
        <span class="dv-controls-hint" id="dv-controls-hint">drag to orbit &middot; scroll to zoom &middot; right-drag to pan</span>
    </div>

    {{-- Touch flight deck (fly mode on coarse pointers): thrust+boost left, joystick right --}}
    <div class="dv-fly-touch" id="dv-fly-touch" hidden>
        <div class="dv-fly-touch-left">
            <button type="button" id="dv-touch-boost" class="dv-glass">BOOST</button>
            <button type="button" id="dv-touch-thrust" class="dv-glass">THRUST</button>
        </div>
        <button type="button" id="dv-touch-exit" class="dv-glass" aria-label="Exit spaceship mode">&#10005;</button>
        <div class="dv-joystick dv-glass" id="dv-joystick" aria-label="Steering joystick">
            <div class="dv-joystick-knob"></div>
        </div>
    </div>

    {{-- Click-selected work: citation details + links (bottom-left, above the theme button) --}}
    <aside class="dv-panel dv-glass" id="dv-panel" hidden aria-label="Selected work"></aside>

    <div class="dv-tooltip" id="dv-tooltip" role="status"></div>
    <div class="dv-status" id="dv-status">Charting the docuverse&hellip;</div>

    <script>
        window.__docuverse = { focus: @json($focusBook) };
    </script>
    @vite(['resources/js/docuverse3d/main.ts'])
</body>
</html>
