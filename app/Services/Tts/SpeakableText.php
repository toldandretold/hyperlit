<?php

namespace App\Services\Tts;

/**
 * The one place that decides what text a node "speaks".
 *
 * ALWAYS derived from `content` — nodes.plainText is ignored: it is
 * write-path-unreliable (a 280-node prod book had 3 populated rows) AND
 * contaminated (PgNode bakes it with bare strip_tags, which keeps hypercite
 * arrow glyphs, the literal `&nearr;` entity from AI-archivist hypercites,
 * citation bracket numbers, and bare footnote digits — all of which the TTS
 * then narrates as junk).
 *
 * Structural inline elements are VERBALIZED, not leaked:
 *   hypercite arrow (`.open-icon`, any of its 3 historical nestings) → "(hypercite link)"
 *   footnote marker (`sup[fn-count-id]` / `.footnote-ref`)           → "(footnote N)"
 *   numeric citation (`[<a class="in-text-citation">9</a>]`)         → "(citation 9)"
 *   textual citation ("(Smith, 2020)" inner text)                    → kept as-is
 *   math (`latex`/`latex-block`, empty in storage)                   → "equation"
 *   page-number markers (`.pageNumber`), images                      → dropped
 *   mark/u/em/strong/… decoration                                    → unwrapped
 *
 * ⚠ This derivation IS the source_hash input (GenerateBookAudioJob,
 * BookAudioController::manifest staleness, ::audioCounts pricing). Changing
 * ANY rule here flips every generated book to "stale" and re-bills its next
 * regeneration — change deliberately, never incidentally.
 */
final class SpeakableText
{
    /** Sentinel wrappers for citation anchors (resolved in the text pass). */
    private const CITE_OPEN = "\u{E000}";

    private const CITE_CLOSE = "\u{E001}";

    public static function fromContent(?string $content): string
    {
        $html = (string) $content;
        if (trim($html) === '') {
            return '';
        }

        $text = self::domPass($html) ?? strip_tags($html);

        // Decode entities that survived (the AI-archivist arrow is stored as
        // the literal string "&nearr;", which strip_tags/DOM text can keep).
        $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');

        // Citation sentinels → speakable form. ONLY the bracketed numeric
        // marker convention ("[<a>13</a>]" — brackets are body text OUTSIDE
        // the anchor) is verbalized as "(citation 13)". Everything else reads
        // exactly as written: author-year anchors ("(e.g., Dolan and Lawless,
        // <a>2024</a>)") must NOT get "citation" injected before the year.
        $text = preg_replace_callback(
            '/\[\s*' . self::CITE_OPEN . '([\d\s,;&\x{2013}-]+?)' . self::CITE_CLOSE . '\s*\]/su',
            fn (array $m): string => ' (citation ' . trim(preg_replace('/\s+/', ' ', $m[1]) ?? $m[1]) . ') ',
            $text,
        ) ?? $text;
        // Remaining sentinels (unbracketed, or bracketed-but-textual): unwrap.
        $text = preg_replace(
            '/' . self::CITE_OPEN . '(.*?)' . self::CITE_CLOSE . '/su',
            '$1',
            $text,
        ) ?? $text;

        // Invisible characters the TTS must never see: word-joiner (the
        // hypercite seam), zero-widths, soft hyphen, BOM.
        $text = preg_replace('/[\x{2060}\x{200B}\x{200C}\x{200D}\x{00AD}\x{FEFF}]/u', '', $text) ?? $text;

        // Belt-and-braces: no arrow glyph or its entity ever reaches the TTS
        // (AiBrainController uses this same final pass on LLM output).
        $text = preg_replace('/\x{2197}|&nearr;/u', '', $text) ?? $text;

        // Whitespace + punctuation seams left by marker replacement.
        $text = preg_replace('/\s+/u', ' ', $text) ?? $text;
        $text = preg_replace('/\s+([,.;:!?])/u', '$1', $text) ?? $text;
        $text = preg_replace('/\(\s+/u', '(', $text) ?? $text;
        $text = preg_replace('/\s+\)/u', ')', $text) ?? $text;

        return trim($text);
    }

    public static function isSpeakable(?string $content): bool
    {
        return self::fromContent($content) !== '';
    }

    /** DOM transform → plain text, or null when the parser refuses the HTML. */
    private static function domPass(string $html): ?string
    {
        $dom = new \DOMDocument('1.0', 'UTF-8');
        $prev = libxml_use_internal_errors(true);
        // Same loading recipe as NodeHtmlSanitizer::scrub — force UTF-8, no
        // implied html/body wrapper.
        $loaded = $dom->loadHTML(
            '<?xml encoding="utf-8"?><div data-speakable-root="1">' . $html . '</div>',
            LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD | LIBXML_NONET
        );
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        if (! $loaded) {
            return null;
        }

        $root = $dom->getElementsByTagName('div')->item(0);
        if (! $root) {
            return null;
        }

        $xpath = new \DOMXPath($dom);

        // 1. Hypercite arrows — match by class in EVERY historical nesting
        //    (a.open-icon / a>sup.open-icon / sup.open-icon>a). Replace the
        //    OUTERMOST arrow-bearing element (the <a> when it wraps the sup).
        foreach (self::collect($xpath, "//*[contains(concat(' ', normalize-space(@class), ' '), ' open-icon ')]") as $el) {
            $target = $el;
            if ($el->parentNode instanceof \DOMElement && strtolower($el->parentNode->tagName) === 'a') {
                $target = $el->parentNode;
            }
            self::replaceWithText($target, ' (hypercite link) ');
        }

        // 2. Footnote markers — sup[fn-count-id], sup.footnote-ref, or a
        //    .footnote-ref anchor inside a sup. Speak "(footnote N)".
        foreach (self::collect($xpath, '//sup[@fn-count-id]'
            . " | //sup[contains(concat(' ', normalize-space(@class), ' '), ' footnote-ref ')]"
            . " | //sup[.//*[contains(concat(' ', normalize-space(@class), ' '), ' footnote-ref ')]]") as $sup) {
            if (! $sup->parentNode) {
                continue; // already replaced via an overlapping selector match
            }
            $n = trim($sup->getAttribute('fn-count-id')) !== ''
                ? trim($sup->getAttribute('fn-count-id'))
                : trim($sup->textContent);
            self::replaceWithText($sup, $n === '' ? ' (footnote) ' : " (footnote {$n}) ");
        }

        // 3. Pipeline citation anchors → sentinel-wrapped inner text (resolved
        //    in the text pass, where the surrounding literal brackets are
        //    visible). The editor's a.citation-ref is NOT sentineled — its
        //    anchor holds a bare year inside "(Author …)" sibling text, which
        //    already reads naturally via plain unwrapping.
        foreach (self::collect($xpath, "//a[contains(concat(' ', normalize-space(@class), ' '), ' in-text-citation ')]") as $a) {
            self::replaceWithText($a, self::CITE_OPEN . $a->textContent . self::CITE_CLOSE);
        }

        // 4. Never-spoken subtrees: page-number markers, images.
        foreach (self::collect($xpath, "//*[contains(concat(' ', normalize-space(@class), ' '), ' pageNumber ')] | //img") as $el) {
            $el->parentNode?->removeChild($el);
        }

        // 5. Math is stored EMPTY (KaTeX renders from data-math client-side) —
        //    silence would drop a grammatically load-bearing object.
        foreach (self::collect($xpath, '//latex') as $el) {
            self::replaceWithText($el, ' equation ');
        }
        foreach (self::collect($xpath, '//latex-block') as $el) {
            self::replaceWithText($el, ' Equation. ');
        }

        // 6. Word boundaries: <br> and block-element seams become spaces so
        //    adjacent words don't fuse when tags drop.
        foreach (self::collect($xpath, '//br') as $br) {
            self::replaceWithText($br, ' ');
        }
        foreach (self::collect($xpath, '//p | //li | //h1 | //h2 | //h3 | //h4 | //h5 | //h6 | //blockquote | //div | //tr | //dt | //dd') as $block) {
            $block->appendChild($dom->createTextNode(' '));
        }

        // Everything else (mark/u/em/strong/cite/abbr/sub/other sup/a…)
        // contributes its textContent — decoration unwraps for free.
        return $root->textContent;
    }

    /** @return \DOMElement[] materialised list (safe to mutate the tree while iterating) */
    private static function collect(\DOMXPath $xpath, string $query): array
    {
        $out = [];
        foreach ($xpath->query($query) ?: [] as $node) {
            if ($node instanceof \DOMElement) {
                $out[] = $node;
            }
        }

        return $out;
    }

    private static function replaceWithText(\DOMNode $node, string $text): void
    {
        if (! $node->parentNode || ! $node->ownerDocument) {
            return;
        }
        $node->parentNode->replaceChild($node->ownerDocument->createTextNode($text), $node);
    }
}
