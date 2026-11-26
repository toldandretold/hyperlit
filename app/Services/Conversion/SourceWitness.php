<?php

namespace App\Services\Conversion;

/**
 * What a born-digital source (an EPUB, a saved HTML page) itself says about its structure, so the
 * lint can tell "the converter did this" from "the source prints it this way".
 *
 * A PDF has no structure to ask — its paragraphs are the converter's reading of ink — so every
 * split sentence there is the converter's. An EPUB is different: its paragraphs, headings and
 * raised numbers are the publisher's markup, and a converter that carries them over faithfully
 * has done its job even when the result looks wrong. marxists.org's Civil War in France breaks
 * "…contrived to grasp in the name of his ⏎ bastards, a large succession…" into two `<p>`s at a
 * manuscript page break; Theories of Surplus-Value prints a note number as a bare `<sup>` with
 * no note behind it. Neither is something a converter fix could change, and listing them beside
 * real defects buries the real ones (prod 2026-11-26: 217 of ~470 findings on the first
 * marxists.org shelf).
 *
 * Read with regular expressions, not a DOM: this runs for every book of a shelf, the answer is
 * a few sets of folded strings, and a tolerant scan is right for markup we do not control.
 */
class SourceWitness
{
    private const OPENING_CHARS = 40;
    private const BLOCKS = 'p|li|h[1-6]|blockquote|dd|dt|td|th|div|pre|caption|figcaption';

    /**
     * @return array{blocks: array<string, true>, headings: list<string>, bare_sups: array<string, true>}|null
     *         null when the book has no born-digital source on disk
     */
    public static function for(string $book): ?array
    {
        $documents = self::documents(resource_path("markdown/{$book}"));
        if ($documents === []) {
            return null;
        }

        $out = ['blocks' => [], 'headings' => [], 'bare_sups' => []];
        foreach ($documents as $html) {
            self::read($html, $out);
        }

        return $out;
    }

    /** @param array{blocks: array<string, true>, headings: list<string>, bare_sups: array<string, true>} $out */
    public static function read(string $html, array &$out): void
    {
        // Every block's opening words. A paragraph of the converted book that opens the same way
        // was a block of its own in the source.
        if (preg_match_all('/<(?:' . self::BLOCKS . ')\b[^>]*>/i', $html, $m, PREG_OFFSET_CAPTURE)) {
            foreach ($m[0] as [$tag, $at]) {
                $opening = self::opening(substr($html, $at + strlen($tag), 600));
                if (strlen($opening) >= 8) {
                    $out['blocks'][$opening] = true;
                }
            }
        }
        if (preg_match_all('/<(h[1-6])\b[^>]*>(.*?)<\/\1>/is', $html, $m)) {
            foreach ($m[2] as $inner) {
                $folded = self::fold($inner);
                if (strlen($folded) >= 8) {
                    $out['headings'][] = $folded;
                }
            }
        }
        // A raised number the source never linked to anything.
        if (preg_match_all('/<sup\b[^>]*>\s*(\d{1,3})\s*<\/sup>/i', $html, $m, PREG_OFFSET_CAPTURE)) {
            foreach ($m[0] as $i => [$tag, $at]) {
                $out['bare_sups'][self::supKey(substr($html, max(0, $at - 400), min(400, $at)), $m[1][$i][0])] = true;
            }
        }
    }

    /** The folded opening of a run of markup — what `blocks` is keyed by. */
    public static function opening(string $markup): string
    {
        // Stop at the block's own end, so a short paragraph is not keyed with its neighbour's words.
        $markup = preg_split('/<\/?(?:' . self::BLOCKS . '|table|ul|ol)\b/i', $markup, 2)[0] ?? '';
        // A note marker reads "[1]" in the source and whatever the book renumbered it to here.
        $markup = preg_replace('/<sup\b[^>]*>.*?<\/sup>/is', '', $markup) ?? $markup;

        return substr(self::fold($markup), 0, self::OPENING_CHARS);
    }

    /** Identity of one raised number: the words just before it, and the number. */
    public static function supKey(string $markupBefore, string $number): string
    {
        // Only the words of its OWN block: the book holds one block per node, so the paragraph
        // before is not there to compare.
        $pieces = preg_split('/<\/?(?:' . self::BLOCKS . '|table|ul|ol)\b[^>]*>/i', $markupBefore) ?: [''];

        return substr(self::fold((string) end($pieces)), -24) . '^' . $number;
    }

    public static function fold(string $markup): string
    {
        $text = html_entity_decode(strip_tags($markup), ENT_QUOTES | ENT_HTML5, 'UTF-8');

        return preg_replace('/[^a-z0-9]+/', '', mb_strtolower($text)) ?? '';
    }

    /** @return list<string> the source's documents, as markup */
    private static function documents(string $dir): array
    {
        // A PDF's book may also hold the landing page it was fetched from. That page is not
        // what was converted and must never vouch for the conversion.
        if (is_file("{$dir}/original.pdf")) {
            return [];
        }
        // The import already unpacked the EPUB beside the original.
        $unpacked = glob("{$dir}/epub_original/{*,*/*,*/*/*}.{xhtml,html,htm}", GLOB_BRACE) ?: [];
        if ($unpacked !== []) {
            return array_values(array_filter(array_map(fn ($p) => (string) @file_get_contents($p), $unpacked)));
        }

        if (is_file("{$dir}/original.epub") && class_exists(\ZipArchive::class)) {
            $zip = new \ZipArchive();
            $out = [];
            if ($zip->open("{$dir}/original.epub") === true) {
                for ($i = 0; $i < $zip->numFiles; $i++) {
                    $name = (string) $zip->getNameIndex($i);
                    if (preg_match('/\.x?html?$/i', $name)) {
                        $out[] = (string) $zip->getFromIndex($i);
                    }
                }
                $zip->close();
            }
            if ($out !== []) {
                return $out;
            }
        }

        foreach (['original.html', 'fetched_page.html'] as $file) {
            if (is_file("{$dir}/{$file}")) {
                return [(string) file_get_contents("{$dir}/{$file}")];
            }
        }

        return [];
    }
}
