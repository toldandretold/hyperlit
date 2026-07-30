<?php

namespace App\Services\Translation;

/**
 * The one place that decides what text of a node gets translated.
 *
 * ALWAYS derived from `content` — nodes.plainText is ignored for the same
 * reasons SpeakableText ignores it: it is write-path-unreliable (the hot path
 * in DbNodeController binds a client-supplied value via raw SQL, and a 280-node
 * production book had 3 populated rows) AND contaminated (bare strip_tags keeps
 * hypercite arrow glyphs, the literal `&nearr;` entity, citation brackets and
 * bare footnote digits).
 *
 * ⚠ DELIBERATELY A SEPARATE CLASS FROM SpeakableText, NOT A REUSE OF IT.
 * SpeakableText's output IS the audio `source_hash` input, so any change to its
 * rules reflags every generated audiobook as stale and re-bills the next
 * regeneration. If translation shared that derivation, a tweak made for a
 * translator's benefit would silently invalidate every audiobook, and vice
 * versa. The DOM-pass skeleton below is copied on purpose; the RULES diverge.
 *
 * HOW THE RULES DIVERGE FROM SPEECH — a narrator and a translator want
 * opposite things from the same furniture:
 *   footnote marker (`sup[fn-count-id]` / `.footnote-ref`)
 *       speech: "(footnote 3)"  →  translation: DROPPED
 *       Narrating it means the word "footnote" gets translated and welded into
 *       the prose ("(pie de página 3)"), which is not what the author wrote.
 *   hypercite arrow (`.open-icon`, all 3 historical nestings)
 *       speech: "(hypercite link)"  →  translation: DROPPED (a UI affordance,
 *       not language)
 *   numeric citation (`[<a class="in-text-citation">9</a>]`)
 *       speech: "(citation 9)"  →  translation: KEPT VERBATIM as "[9]".
 *       Reference numbers are language-neutral and belong in scholarly prose.
 *   textual citation ("(Smith, 2020)")
 *       both: kept as-is — it is prose, and a translator may legitimately
 *       localise the connective while leaving the name and year alone.
 *   math (`latex` / `latex-block`)
 *       speech: "equation"  →  translation: DROPPED. Storage holds these EMPTY
 *       (KaTeX renders from data-math client-side), so there is no text to
 *       translate and injecting a placeholder word would leak into the output.
 *   page markers (`.pageNumber`), images
 *       both: dropped.
 *   mark/u/em/strong/…
 *       both: unwrapped.
 *
 * ⚠ SCOPE: this produces TRANSLATABLE PROSE, and it is a ONE-WAY derivation.
 * It does not round-trip — footnote markers, math and inline formatting are
 * gone, so translated output cannot be spliced back into a node's HTML in place
 * of the original. Structure-preserving translation (markers surviving as
 * inline tags, math held verbatim, annotation offsets realigned) is a distinct
 * and harder problem, deliberately left to the reading-mode work. Do not build
 * a whole-book replacement view on top of this function without solving that
 * first.
 */
final class TranslatableText
{
    public static function fromContent(?string $content): string
    {
        $html = (string) $content;
        if (trim($html) === '') {
            return '';
        }

        $text = self::domPass($html) ?? strip_tags($html);

        // The AI-archivist arrow is stored as the literal string "&nearr;", which
        // strip_tags and DOM textContent both happily keep.
        $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');

        // Invisible characters a model must never see: word-joiner (the hypercite
        // seam), zero-widths, soft hyphen, BOM. Left in, these become literal
        // bytes inside the translated string or split a word mid-token.
        $text = preg_replace('/[\x{2060}\x{200B}\x{200C}\x{200D}\x{00AD}\x{FEFF}]/u', '', $text) ?? $text;

        // Belt-and-braces: neither the arrow glyph nor its entity ever reaches
        // the model, whichever nesting produced it.
        $text = preg_replace('/\x{2197}|&nearr;/u', '', $text) ?? $text;

        // Seams left by dropping markers: a removed footnote sup leaves
        // "word  ." or "word [ ]" behind.
        $text = preg_replace('/\s+/u', ' ', $text) ?? $text;
        $text = preg_replace('/\[\s*\]/u', '', $text) ?? $text;           // emptied citation brackets
        $text = preg_replace('/\(\s*\)/u', '', $text) ?? $text;           // emptied parentheticals
        $text = preg_replace('/\s+([,.;:!?])/u', '$1', $text) ?? $text;
        $text = preg_replace('/\(\s+/u', '(', $text) ?? $text;
        $text = preg_replace('/\s+\)/u', ')', $text) ?? $text;
        $text = preg_replace('/\s+/u', ' ', $text) ?? $text;              // re-collapse after removals

        return trim($text);
    }

    /**
     * Whether this node has anything worth paying to translate. A node that is
     * pure furniture (an image, a page marker, an empty equation) yields '' and
     * must be skipped rather than sent to a model.
     */
    public static function isTranslatable(?string $content): bool
    {
        return self::fromContent($content) !== '';
    }

    /** DOM transform → plain text, or null when the parser refuses the HTML. */
    private static function domPass(string $html): ?string
    {
        $dom = new \DOMDocument('1.0', 'UTF-8');
        $prev = libxml_use_internal_errors(true);
        // Same loading recipe as SpeakableText::domPass / NodeHtmlSanitizer::scrub —
        // force UTF-8, no implied html/body wrapper.
        $loaded = $dom->loadHTML(
            '<?xml encoding="utf-8"?><div data-translatable-root="1">'.$html.'</div>',
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

        // 1. Hypercite arrows — drop the OUTERMOST arrow-bearing element, matching
        //    every historical nesting (a.open-icon / a>sup.open-icon / sup.open-icon>a).
        foreach (self::collect($xpath, "//*[contains(concat(' ', normalize-space(@class), ' '), ' open-icon ')]") as $el) {
            $target = $el;
            if ($el->parentNode instanceof \DOMElement && strtolower($el->parentNode->tagName) === 'a') {
                $target = $el->parentNode;
            }
            $target->parentNode?->removeChild($target);
        }

        // 2. Footnote markers — dropped entirely (see class docblock: narrating
        //    them would get the word "footnote" translated into the prose).
        foreach (self::collect($xpath, '//sup[@fn-count-id]'
            ." | //sup[contains(concat(' ', normalize-space(@class), ' '), ' footnote-ref ')]"
            ." | //sup[.//*[contains(concat(' ', normalize-space(@class), ' '), ' footnote-ref ')]]") as $sup) {
            if (! $sup->parentNode) {
                continue; // already removed via an overlapping selector match
            }
            $sup->parentNode->removeChild($sup);
        }

        // 3. Never-translated subtrees: page-number markers, images.
        foreach (self::collect($xpath, "//*[contains(concat(' ', normalize-space(@class), ' '), ' pageNumber ')] | //img") as $el) {
            $el->parentNode?->removeChild($el);
        }

        // 4. Math is stored EMPTY, so there is nothing to translate and no
        //    placeholder that wouldn't leak into the output.
        foreach (self::collect($xpath, '//latex | //latex-block') as $el) {
            $el->parentNode?->removeChild($el);
        }

        // 5. Word boundaries: <br> and block seams become spaces so adjacent
        //    words don't fuse when tags drop.
        foreach (self::collect($xpath, '//br') as $br) {
            self::replaceWithText($br, ' ');
        }
        foreach (self::collect($xpath, '//p | //li | //h1 | //h2 | //h3 | //h4 | //h5 | //h6 | //blockquote | //div | //tr | //dt | //dd') as $block) {
            $block->appendChild($dom->createTextNode(' '));
        }

        // Everything else contributes its textContent, so citation anchors
        // (numeric AND author-year) keep their text and decoration unwraps.
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
