<?php

namespace App\Services\SourceImport\Content;

/**
 * Walks HTML into LEAF block-level texts, plus the two "this isn't prose"
 * filters that go with them.
 *
 * Extracted from BodyPresenceAssessor so the citation resolver's main-content
 * extraction (App\Services\WebContent\MainContentExtractor) can reuse the same
 * calibrated notion of "a body paragraph" instead of growing a second one.
 * BodyPresenceAssessor still owns the THRESHOLDS and the verdict; this class
 * only knows how to find candidate blocks and recognise non-prose.
 *
 * "Leaf" (a block containing no other block) is what stops a wrapping
 * <div>/<section> from being counted again on top of the paragraphs inside it.
 *
 * NOTE on $stripNonContent: BodyPresenceAssessor is fed the paste engine's
 * already-cleaned body HTML and passes FALSE, preserving its exact historical
 * behaviour (leaked <style>/<script> text arrives as a block and is dropped by
 * isCodeLike). MainContentExtractor is fed a RAW web page, where nav rails,
 * cookie banners and ad slots are the majority of the markup, so it passes
 * TRUE and those subtrees are removed before the walk.
 */
class ProseBlockExtractor
{
    /** Block-level elements whose text is a candidate body paragraph. */
    public const BLOCK_TAGS = ['p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'dd', 'pre', 'div', 'section', 'article'];

    /**
     * Subtrees that are never article body. Removed wholesale (not merely
     * filtered per block) because their text is what buries the article: a news
     * page's trending rail is dozens of short <li>s that no per-block filter
     * can tell from a genuine list inside the piece.
     */
    private const NON_CONTENT_TAGS = [
        'script', 'style', 'noscript', 'svg', 'template', 'iframe', 'canvas',
        'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'dialog',
    ];

    /**
     * @return list<string> raw textContent of each leaf block, unnormalised
     */
    public function leafBlocks(string $html, bool $stripNonContent = false): array
    {
        if (trim($html) === '') {
            return [];
        }

        $doc  = new \DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="UTF-8"><div id="__root">' . $html . '</div>', LIBXML_NOERROR | LIBXML_NOWARNING);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);

        $xpath = new \DOMXPath($doc);

        if ($stripNonContent) {
            $this->removeNonContent($xpath);
        }

        $self  = implode(' or ', array_map(fn ($t) => "self::{$t}", self::BLOCK_TAGS));
        $nodes = $xpath->query("//*[{$self}][not(.//*[{$self}])]");
        if (!$nodes) {
            return [];
        }

        $out = [];
        foreach ($nodes as $node) {
            $out[] = $node->textContent;
        }

        return $out;
    }

    /**
     * Collapse a block's whitespace the way the assessors measure it.
     */
    public function normalise(string $text): string
    {
        return trim(preg_replace('/\s+/u', ' ', $text) ?? '');
    }

    /**
     * Leaked stylesheet / script payload. The paste engine emits <style> and
     * <script> contents of some publisher templates as body blocks (Springer's
     * buybox CSS alone is ~2k chars, twice), so without this filter a landing
     * page's boilerplate would read as prose.
     */
    public function isCodeLike(string $text): bool
    {
        return (bool) preg_match(
            '/(\{[^}]*[\w-]+\s*:\s*[^};]+;)|(\bfunction\s*\()|(\bwindow\.)|(\bdocument\.)|(\bvar\s+\w+\s*=)|(dataLayer)|(@media\b)|(!important)/i',
            $text,
        );
    }

    /**
     * A bibliography entry rather than body prose. Publisher landing pages
     * ship the FULL reference list — it is the single biggest chunk of text on
     * the page and would otherwise pass for an article body.
     */
    public function isReferenceLike(string $text): bool
    {
        return (bool) preg_match('/^\s*\[?\d{0,3}\]?\s*[A-Z][A-Za-z\'’-]+,\s+[A-Z]\./u', $text)
            || (bool) preg_match('/\bdoi:\s*10\.|https?:\/\/doi\.org\/10\./i', $text)
            || (bool) preg_match('/\bRetrieved from\s+https?:/i', $text);
    }

    private function removeNonContent(\DOMXPath $xpath): void
    {
        $self  = implode(' or ', array_map(fn ($t) => "self::{$t}", self::NON_CONTENT_TAGS));
        $nodes = $xpath->query("//*[{$self}]");
        if (!$nodes) {
            return;
        }

        // Snapshot first: removing while iterating a live DOMNodeList skips nodes.
        $doomed = [];
        foreach ($nodes as $node) {
            $doomed[] = $node;
        }
        foreach ($doomed as $node) {
            $node->parentNode?->removeChild($node);
        }
    }
}
