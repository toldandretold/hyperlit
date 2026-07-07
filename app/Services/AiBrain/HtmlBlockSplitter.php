<?php

namespace App\Services\AiBrain;

/**
 * Splits an LLM HTML answer into a flat list of top-level block elements, one per
 * node. Crucially, it LIFTS block elements out of paragraphs: an LLM routinely
 * emits `<p>text <blockquote>quote</blockquote> more</p>`, which is invalid HTML
 * nesting — the browser auto-closes the <p> at the <blockquote>, so a node stored
 * as that single string only renders its leading fragment (the blockquote and
 * everything after it are orphaned and vanish). Parsing with the HTML content
 * model (libxml) auto-corrects the nesting; we then regroup the corrected tree
 * into clean top-level blocks so every paragraph/quote/list becomes its own node.
 */
class HtmlBlockSplitter
{
    private const BLOCK_TAGS = [
        'p', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'pre', 'div', 'table', 'figure', 'hr',
    ];

    /** @return string[] top-level block HTML fragments (never nested block-in-p) */
    public static function split(string $html): array
    {
        $html = trim($html);
        if ($html === '') return [];

        $dom = new \DOMDocument();
        $prev = libxml_use_internal_errors(true);
        // `<?xml encoding>` forces UTF-8; NOIMPLIED/NODEFDTD keep libxml from adding
        // <html>/<body>/doctype. A wrapper div gives us a single, findable root.
        $dom->loadHTML(
            '<?xml encoding="UTF-8"><div id="__hlroot">' . $html . '</div>',
            LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD
        );
        libxml_clear_errors();
        libxml_use_internal_errors($prev);

        $root = null;
        foreach ($dom->childNodes as $n) {
            if ($n->nodeType === XML_ELEMENT_NODE) { $root = $n; break; }
        }
        if (!$root) return [$html];

        $blocks = [];
        $inline = '';

        $flush = function () use (&$inline, &$blocks) {
            $t = trim($inline);
            if ($t !== '' && trim(strip_tags($t)) !== '') {
                $blocks[] = '<p>' . $t . '</p>';
            }
            $inline = '';
        };

        foreach (iterator_to_array($root->childNodes) as $child) {
            $isBlock = $child->nodeType === XML_ELEMENT_NODE
                && in_array(strtolower($child->nodeName), self::BLOCK_TAGS, true);

            if ($isBlock) {
                $flush();               // close any accumulated inline run first
                $blocks[] = $dom->saveHTML($child);
            } else {
                // Text node or inline element (em, a, b, sup, …) — buffer it so a
                // run of inline content after a lifted blockquote stays one <p>.
                $inline .= $dom->saveHTML($child);
            }
        }
        $flush();

        return $blocks ?: [$html];
    }
}
