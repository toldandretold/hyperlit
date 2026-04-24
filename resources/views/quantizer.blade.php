<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Q — {{ $title }}</title>
    <meta name="robots" content="noindex">
    @vite(['resources/css/quantizer.css'])
</head>
<body>
    <div class="quantizer-shell">
        <header class="quantizer-header">
            <div class="quantizer-header-left">
                <h1 class="quantizer-title">{{ $title }}</h1>
                @if($author)
                    <span class="quantizer-author">{{ $author }}</span>
                @endif
            </div>
            <a href="/{{ $book }}" class="quantizer-back">&larr; Reader</a>
        </header>

        <div class="quantizer-columns" id="quantizer-columns">
            <div class="quantizer-pane" id="quantizer-book">
                @foreach($nodes as $node)
                    <div class="quantizer-node" data-node-id="{{ $node->node_id }}" data-start-line="{{ $node->startLine }}">{!! $node->content !!}</div>
                @endforeach
            </div>

            <div class="quantizer-links">
                <svg id="quantizer-connectors" class="quantizer-links-svg"></svg>
            </div>

            <div class="quantizer-pane quantizer-cards-pane" id="quantizer-cards">
                {{-- JS renders cards here --}}
            </div>

            {{-- Additional SVG + cards columns are added dynamically by JS --}}
        </div>
    </div>

    <script>
        window.__quantizerData = {
            hyperlights: @json($hyperlights),
            hypercites: @json($hypercites),
            footnotes: @json($footnotes)
        };
    </script>
    @vite(['resources/js/quantizer/index.js'])
</body>
</html>
