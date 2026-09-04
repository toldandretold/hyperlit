<?php

namespace App\Services\CitationReview\Support;

/**
 * Describes what a short-form / ibid citation actually refers to, for report
 * and highlight rendering. The scan (CitationScanBibliographyJob::
 * matchShortFormAntecedents) SUBSTITUTES a linked short form's llm_metadata
 * with its antecedent work's metadata plus a `short_form_of` marker — so the
 * referenced work's title/authors/year are sitting on the claim, but the
 * visible bibliography text is just "Ibid." A reader can't act on a bare
 * "Ibid." entry; this renders the substituted metadata into a human line.
 */
final class ShortFormReference
{
    /**
     * "Refers to: Carney, Terry, “Automating Compliance…” (2024)" for a LINKED
     * short form; an honest could-not-link note for an unlinked ibid/short-form;
     * null for ordinary (full) citations.
     */
    public static function describe(array $claim): ?string
    {
        $meta = $claim['llm_metadata'] ?? null;
        if (!is_array($meta)) {
            return null;
        }

        if (!empty($meta['short_form_of'])) {
            $authors = array_filter(array_map(
                fn ($a) => is_string($a) ? trim($a) : null,
                $meta['authors'] ?? []
            ));
            $parts = [];
            if ($authors) {
                $parts[] = implode('; ', $authors);
            }
            if (!empty($meta['title'])) {
                $parts[] = "\u{201C}{$meta['title']}\u{201D}";
            }
            $line = implode(', ', $parts);
            if (!empty($meta['year'])) {
                $line .= " ({$meta['year']})";
            }

            return $line !== '' ? "Refers to: {$line}" : null;
        }

        if (in_array($meta['type'] ?? null, ['ibid', 'short-form'], true)) {
            // Never substituted — the antecedent couldn't be linked (e.g. the
            // preceding citation was itself an unknown work).
            return 'Short-form citation whose full reference could not be linked '
                . 'to an earlier footnote — check the preceding footnotes manually.';
        }

        return null;
    }
}
