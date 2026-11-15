<?php

namespace App\Services\DocumentImport;

use Illuminate\Support\Str;

/**
 * An imported footnote's content → the nodes of its sub-book, one per BLOCK.
 *
 * The conversion hands a footnote over as one HTML string: its paragraphs
 * joined by `<br><br>`, with a quotation or a list as a whole block element
 * between them (app/Python/digestion/footnoteExtraction/footnotes.py). Every
 * import path used to push that through `strip_tags` into a single `<p>`, so a
 * footnote of three paragraphs and a quotation was stored — and read — as one
 * run of text, its words welded together at the joins ("has it:the commons").
 * A footnote written in the editor has always been a real multi-node sub-book;
 * an imported one is now the same shape:
 *
 *   - a paragraph            → `<p>`
 *   - a `<blockquote>`       → `<blockquote>` (one per paragraph inside it)
 *   - a `<ul>` / `<ol>`      → the list, its items kept
 *   - anything else (table, pre, figure) → a paragraph of its text, as before
 *
 * Inline markup is still limited to links and emphasis.
 */
class FootnoteBlocks
{
    private const INLINE_TAGS = '<a><em><strong><i><b>';

    private const BLOCK_TAGS = ['p', 'div', 'blockquote', 'ul', 'ol', 'table', 'pre', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article'];

    /**
     * @return list<array{node_id: string, startLine: int, content: string, plainText: string}>
     *   always at least one node — an empty footnote is still a place to type
     */
    public static function nodes(string $content): array
    {
        $nodes = [];
        foreach (self::blocks($content) as [$tag, $html]) {
            $uuid = (string) Str::uuid();
            $attr = 'data-node-id="' . e($uuid) . '"';
            $nodes[] = [
                'node_id'   => $uuid,
                'startLine' => count($nodes) + 1,
                'content'   => match ($tag) {
                    'blockquote' => "<blockquote {$attr}>{$html}</blockquote>",
                    'ul', 'ol'   => "<{$tag} {$attr}>{$html}</{$tag}>",
                    default      => "<p {$attr} style=\"min-height:1.5em;\">{$html}</p>",
                },
                'plainText' => self::text($html),
            ];
        }

        if ($nodes === []) {
            $uuid = (string) Str::uuid();
            $nodes[] = [
                'node_id' => $uuid, 'startLine' => 1, 'plainText' => '',
                'content' => '<p data-node-id="' . e($uuid) . '" style="min-height:1.5em;"></p>',
            ];
        }

        return $nodes;
    }

    /** The same nodes as the `preview_nodes` payload a footnote row carries. */
    public static function previewNodes(string $subBookId, array $nodes): array
    {
        return array_map(fn (array $n) => [
            'book'        => $subBookId,
            'chunk_id'    => 0,
            'startLine'   => (float) $n['startLine'],
            'node_id'     => $n['node_id'],
            'content'     => $n['content'],
            'footnotes'   => [],
            'hyperlights' => [],
            'hypercites'  => [],
        ], $nodes);
    }

    /**
     * @return list<array{0: string, 1: string}>  [tag, inner html] per block, in order
     */
    private static function blocks(string $content): array
    {
        if (trim($content) === '') {
            return [];
        }

        $doc = new \DOMDocument();
        $previous = libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="utf-8"?><div id="__fn_root__">' . $content . '</div>', LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
        libxml_clear_errors();
        libxml_use_internal_errors($previous);

        $root = (new \DOMXPath($doc))->query('//*[@id="__fn_root__"]')->item(0);
        if (!$root) {
            return [['p', self::inline($content)]];
        }

        $blocks = [];
        self::walk($root, $doc, $blocks);

        return $blocks;
    }

    /** Collect $parent's children into blocks: inline runs become paragraphs, split at a double break. */
    private static function walk(\DOMNode $parent, \DOMDocument $doc, array &$blocks): void
    {
        $run = '';
        $breaks = 0;
        $flush = function () use (&$run, &$breaks, &$blocks) {
            $html = self::inline($run);
            if ($html !== '') {
                $blocks[] = ['p', $html];
            }
            $run = '';
            $breaks = 0;
        };

        foreach (iterator_to_array($parent->childNodes) as $child) {
            $name = $child instanceof \DOMElement ? strtolower($child->nodeName) : '';

            if ($name === 'br') {
                // One break is a line break inside a paragraph; two end it.
                if (++$breaks >= 2) {
                    $flush();
                } else {
                    $run .= ' ';
                }

                continue;
            }
            if ($child instanceof \DOMText && trim($child->nodeValue ?? '') === '') {
                $run .= ' ';

                continue;   // whitespace between two breaks does not separate them
            }
            $breaks = 0;

            if (!in_array($name, self::BLOCK_TAGS, true)) {
                $run .= $doc->saveHTML($child);

                continue;
            }

            $flush();
            if ($name === 'blockquote') {
                $inner = [];
                self::walk($child, $doc, $inner);
                foreach ($inner as [, $html]) {
                    $blocks[] = ['blockquote', $html];
                }
            } elseif ($name === 'ul' || $name === 'ol') {
                $items = '';
                foreach ($child->childNodes as $li) {
                    if ($li instanceof \DOMElement && strtolower($li->nodeName) === 'li') {
                        $html = self::inline(self::innerHtml($li, $doc));
                        $items .= $html !== '' ? "<li>{$html}</li>" : '';
                    }
                }
                if ($items !== '') {
                    $blocks[] = [$name, $items];
                }
            } elseif (in_array($name, ['p', 'div', 'section', 'article'], true)) {
                self::walk($child, $doc, $blocks);
            } else {
                // table / pre / figure / heading: its words, as one paragraph.
                $html = self::inline(self::innerHtml($child, $doc));
                if ($html !== '') {
                    $blocks[] = ['p', $html];
                }
            }
        }
        $flush();
    }

    private static function innerHtml(\DOMNode $node, \DOMDocument $doc): string
    {
        $html = '';
        foreach ($node->childNodes as $child) {
            $html .= $doc->saveHTML($child);
        }

        return $html;
    }

    /** Links and emphasis only; every block boundary inside becomes a space, never a welded word. */
    private static function inline(string $html): string
    {
        $spaced = (string) preg_replace('~<br\s*/?>|</?(?:p|div|blockquote|li|ul|ol|tr|td|th|table|pre|figure|h[1-6])\b[^>]*>~i', ' ', $html);

        return trim((string) preg_replace('/\s+/u', ' ', strip_tags($spaced, self::INLINE_TAGS)));
    }

    private static function text(string $html): string
    {
        $spaced = (string) preg_replace('~</li>~i', ' ', $html);

        return trim((string) preg_replace('/\s+/u', ' ', html_entity_decode(strip_tags($spaced), ENT_QUOTES | ENT_HTML5)));
    }
}
