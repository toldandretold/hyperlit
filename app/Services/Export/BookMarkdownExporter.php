<?php

namespace App\Services\Export;

use Illuminate\Support\Facades\DB;
use League\HTMLToMarkdown\Converter\TableConverter;
use League\HTMLToMarkdown\HtmlConverter;

/**
 * Server-side port of the source panel's buildMarkdownForBook
 * (resources/js/components/sourceContainer/downloads.ts) for whole-library
 * vault exports — one .md per book, hyperlit constructs resolved:
 *
 *   - sup.footnote-ref            → [^n] + definition from the footnote's
 *                                    sub-book nodes ({book}/{fnId}) or the
 *                                    footnotes row (preview_nodes/content);
 *   - hypercite arrows (a.open-icon / a > sup.open-icon)
 *                                 → [^n] + a compact citation of the cited
 *                                    book (its library row) linking the
 *                                    hyperlit deep URL;
 *   - a.citation-ref              → unwrapped to plain text, with the book's
 *                                    bibliography rows emitted as
 *                                    ## References (deduped by source);
 *   - img src                     → absolutized (vault v1 links images, it
 *                                    does not bundle them).
 *
 * Footnotes and hypercites share ONE [^n] sequence, mirroring the client.
 * The [^n] markers ride through league/html-to-markdown as sentinel tokens
 * (the converter would otherwise escape/mangle bracket syntax inside text)
 * and are swapped in afterwards.
 *
 * Reads run on pgsql_admin — the caller (BuildArchiveExportJob) has already
 * resolved the corpus with explicit visibility filters.
 */
class BookMarkdownExporter
{
    private HtmlConverter $converter;

    public function __construct()
    {
        $this->converter = new HtmlConverter([
            'header_style' => 'atx',
            'strip_tags' => true, // unknown tags (mark, span) → content only, like turndown
            'strip_placeholder_links' => true,
            'hard_break' => false,
        ]);
        $this->converter->getEnvironment()->addConverter(new TableConverter());
    }

    /** @return string full markdown document for one book */
    public function markdownFor(string $bookId): string
    {
        $nodes = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', $bookId)
            ->orderBy('chunk_id')
            ->orderBy('startLine')
            ->pluck('content');

        $html = $nodes->filter()->implode("\n");
        if (trim($html) === '') {
            return '';
        }

        $doc = $this->loadHtml($html);
        $xpath = new \DOMXPath($doc);

        // One shared footnote sequence, numbered in first-appearance order.
        $counter = 0;
        $footnoteIds = [];   // fnId => n
        $hypercites = [];    // elementId => ['n' => int, 'targetBookId' => ?, 'sourceUrl' => ?]
        $citationRefIds = [];

        // Document order pass over the three constructs at once, so numbering
        // matches reading order regardless of construct type.
        $constructs = $xpath->query(
            '//sup[contains(concat(" ", normalize-space(@class), " "), " footnote-ref ") and @id]'
            . ' | //a[@href and @id and (contains(concat(" ", normalize-space(@class), " "), " open-icon ")'
            . ' or .//sup[contains(concat(" ", normalize-space(@class), " "), " open-icon ")])]'
            . ' | //a[contains(concat(" ", normalize-space(@class), " "), " citation-ref ")]'
        );

        $replacements = [];
        foreach ($constructs as $el) {
            /** @var \DOMElement $el */
            $class = ' ' . preg_replace('/\s+/', ' ', trim($el->getAttribute('class'))) . ' ';

            if ($el->nodeName === 'sup' && str_contains($class, ' footnote-ref ')) {
                $id = $el->getAttribute('id');
                if (!isset($footnoteIds[$id])) {
                    $footnoteIds[$id] = ++$counter;
                }
                $replacements[] = [$el, "@@HLFN{$footnoteIds[$id]}@@"];

                continue;
            }

            if (str_contains($class, ' citation-ref ')) {
                if ($el->getAttribute('id') !== '') {
                    $citationRefIds[] = $el->getAttribute('id');
                }
                // Unwrap to plain text — no link in the body; the reference
                // list at the bottom carries the full citation.
                $replacements[] = [$el, $el->textContent];

                continue;
            }

            // Hypercite arrow. Repeated arrows to the same element id share a number.
            $id = $el->getAttribute('id');
            if (!isset($hypercites[$id])) {
                $target = $this->parseHyperciteHref($el->getAttribute('href'));
                if ($target === null) {
                    continue;
                }
                $hypercites[$id] = ['n' => ++$counter] + $target;
            }
            $replacements[] = [$el, "@@HLFN{$hypercites[$id]['n']}@@"];
        }

        foreach ($replacements as [$el, $text]) {
            $el->parentNode?->replaceChild($doc->createTextNode($text), $el);
        }

        // Absolutize image sources (vault v1 links, doesn't bundle).
        foreach ($xpath->query('//img[@src]') as $img) {
            /** @var \DOMElement $img */
            $img->setAttribute('src', $this->absoluteUrl($img->getAttribute('src')));
        }

        $body = $this->convert($this->innerHtml($doc));
        // Swap the sentinels for real footnote markers post-conversion.
        $body = preg_replace('/@@HLFN(\d+)@@/', '[^$1]', $body) ?? $body;

        $sections = [$body];

        $defs = $this->footnoteDefinitions($bookId, $footnoteIds, $hypercites);
        if ($defs !== []) {
            $sections[] = "---\n\n" . implode("\n\n", $defs);
        }

        $references = $this->referencesSection($bookId, $citationRefIds);
        if ($references !== '') {
            $sections[] = "---\n\n" . $references;
        }

        return implode("\n\n", $sections) . "\n";
    }

    /** Vault filename: "{Author} - {Title}.md" (client getBookDownloadName parity). */
    public function filenameFor(object $libraryRow): string
    {
        $sanitize = fn (string $s) => trim(preg_replace('/\s+/', ' ', preg_replace('/[<>:"\/\\\\|?*]/', '', $s) ?? '') ?? '');
        $title = $sanitize((string) ($libraryRow->title ?? '')) ?: $libraryRow->book;
        $author = $sanitize((string) ($libraryRow->author ?? ''));

        return ($author !== '' ? "{$author} - {$title}" : $title) . '.md';
    }

    // ---------- footnotes ----------

    /** @return string[] "[^n]: body" definitions, footnotes first then hypercites (client parity) */
    private function footnoteDefinitions(string $bookId, array $footnoteIds, array $hypercites): array
    {
        $defs = [];

        foreach ($footnoteIds as $fnId => $n) {
            $paragraphs = $this->footnoteParagraphs($bookId, $fnId);
            $def = "[^{$n}]: " . ($paragraphs[0] ?? '(footnote)');
            foreach (array_slice($paragraphs, 1) as $p) {
                $def .= "\n\n    " . str_replace("\n", "\n    ", $p);
            }
            $defs[] = $def;
        }

        foreach ($hypercites as $info) {
            $defs[] = "[^{$info['n']}]: " . $this->hyperciteCitation($info['targetBookId'], $info['sourceUrl']);
        }

        return $defs;
    }

    /** @return string[] markdown paragraphs of one footnote's body */
    private function footnoteParagraphs(string $bookId, string $fnId): array
    {
        // Preferred source: the footnote's sub-book nodes (the live content).
        $subNodes = DB::connection('pgsql_admin')->table('nodes')
            ->where('book', "{$bookId}/{$fnId}")
            ->orderBy('chunk_id')
            ->orderBy('startLine')
            ->pluck('content')
            ->filter(fn ($c) => trim((string) $c) !== '');

        if ($subNodes->isNotEmpty()) {
            return $subNodes->map(fn ($c) => trim($this->convert($c)))->filter()->values()->all();
        }

        // Fallback: the footnotes row (preview_nodes snapshot, then raw content).
        $row = DB::connection('pgsql_admin')->table('footnotes')
            ->where('book', $bookId)
            ->where('footnoteId', $fnId)
            ->first(['preview_nodes', 'content']);

        if ($row) {
            $preview = json_decode((string) $row->preview_nodes, true);
            if (is_array($preview) && $preview !== []) {
                $paragraphs = [];
                foreach ($preview as $node) {
                    $content = is_array($node) ? ($node['content'] ?? '') : '';
                    if (trim((string) $content) !== '') {
                        $paragraphs[] = trim($this->convert($content));
                    }
                }
                if ($paragraphs !== []) {
                    return $paragraphs;
                }
            }
            if (trim((string) $row->content) !== '') {
                return [trim($this->convert($row->content))];
            }
        }

        return ['(footnote)'];
    }

    // ---------- hypercites ----------

    /** @return ?array{targetBookId: string, sourceUrl: string} */
    private function parseHyperciteHref(string $href): ?array
    {
        $absolute = $this->absoluteUrl($href);
        $parts = parse_url($absolute);
        $segments = array_values(array_filter(explode('/', $parts['path'] ?? '')));
        if ($segments === []) {
            return null;
        }

        $sourceUrl = ($parts['scheme'] ?? 'https') . '://' . ($parts['host'] ?? '') . ($parts['path'] ?? '');
        if (!empty($parts['fragment'])) {
            $sourceUrl .= '#' . $parts['fragment'];
        }

        return ['targetBookId' => rawurldecode($segments[0]), 'sourceUrl' => $sourceUrl];
    }

    /** Compact markdown citation of the cited book, linking the hyperlit deep URL. */
    private function hyperciteCitation(string $targetBookId, string $sourceUrl): string
    {
        $row = DB::connection('pgsql_admin')->table('library')
            ->where('book', $targetBookId)
            ->first(['title', 'author', 'creator', 'year', 'journal', 'publisher']);

        if (!$row) {
            return "[{$targetBookId}]({$sourceUrl})";
        }

        $title = trim((string) ($row->title ?? '')) ?: $targetBookId;
        $author = trim((string) ($row->author ?? $row->creator ?? ''));
        // Anonymous creators are stored as UUIDs — cite as Anon, like the client.
        if (preg_match('/^[0-9a-fA-F-]{36}$/', $author)) {
            $author = 'Anon';
        }

        $parts = [];
        if ($author !== '') {
            $parts[] = $author;
        }
        $parts[] = "“[{$title}]({$sourceUrl})”";
        foreach (['journal', 'publisher', 'year'] as $field) {
            $v = trim((string) ($row->$field ?? ''));
            if ($v !== '') {
                $parts[] = $v;
            }
        }

        return implode(', ', $parts) . '.';
    }

    // ---------- references ----------

    private function referencesSection(string $bookId, array $citationRefIds): string
    {
        if ($citationRefIds === []) {
            return '';
        }

        $rows = DB::connection('pgsql_admin')->table('bibliography')
            ->where('book', $bookId)
            ->whereIn('referenceId', array_values(array_unique($citationRefIds)))
            ->get(['referenceId', 'content', 'source_id']);
        if ($rows->isEmpty()) {
            return '';
        }

        $byId = $rows->keyBy('referenceId');
        $seen = [];
        $lines = ['## References', ''];
        foreach ($citationRefIds as $refId) {
            $row = $byId->get($refId);
            if (!$row || trim((string) $row->content) === '') {
                continue;
            }
            $dedupKey = $row->source_id ?: $row->referenceId;
            if (isset($seen[$dedupKey])) {
                continue;
            }
            $seen[$dedupKey] = true;
            $lines[] = trim($this->convert($row->content));
            $lines[] = '';
        }

        return count($lines) > 2 ? rtrim(implode("\n", $lines)) : '';
    }

    // ---------- html plumbing ----------

    private function convert(string $html): string
    {
        return trim($this->converter->convert($html));
    }

    private function loadHtml(string $html): \DOMDocument
    {
        $doc = new \DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $doc->loadHTML(
            '<?xml encoding="utf-8"?><div id="__hl_export_root__">' . $html . '</div>',
            LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD
        );
        libxml_clear_errors();
        libxml_use_internal_errors($prev);

        return $doc;
    }

    private function innerHtml(\DOMDocument $doc): string
    {
        // With LIBXML_HTML_NOIMPLIED the wrapper div IS the document element
        // (getElementById is unreliable without a DTD declaring id as ID).
        $root = $doc->documentElement;
        if (!$root) {
            return '';
        }
        $html = '';
        foreach ($root->childNodes as $child) {
            $html .= $doc->saveHTML($child);
        }

        return $html;
    }

    private function absoluteUrl(string $url): string
    {
        if ($url === '' || preg_match('#^(https?:)?//#', $url) || str_starts_with($url, 'data:')) {
            return $url;
        }

        return rtrim(config('app.url'), '/') . '/' . ltrim($url, '/');
    }
}
