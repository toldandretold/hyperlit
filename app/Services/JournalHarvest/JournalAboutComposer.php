<?php

namespace App\Services\JournalHarvest;

use App\Models\JournalSource;

/**
 * The copy block for a journal's /j/{slug} page. Operator-set `about` wins
 * wholesale; otherwise the parts compose from DOAJ/OpenAlex registry metadata.
 * Null-tolerant throughout — at 1000+ journals most rows are sparse.
 */
class JournalAboutComposer
{
    /**
     * @return array{custom: ?string, paragraph: ?string, keywords: array, subjects: array, links: array<string, string>}
     */
    public function compose(JournalSource $journal): array
    {
        return [
            'custom'    => $journal->about ?: null,
            'paragraph' => $this->paragraph($journal),
            'keywords'  => array_values(array_filter((array) ($journal->keywords ?? []))),
            'subjects'  => array_values(array_filter((array) ($journal->subjects ?? []))),
            'links'     => $this->links($journal),
        ];
    }

    private function paragraph(JournalSource $journal): ?string
    {
        $publisher = $journal->publisher ?: $journal->institution;

        $sentence = $journal->display_name
            . ' is ' . ($journal->is_diamond
                ? 'a diamond open access journal — free to read and free to publish'
                : 'an open access journal')
            . ($publisher ? ', published by ' . $publisher : '')
            . '.';

        $extras = [];
        if ($journal->review_process) {
            $extras[] = 'Peer review: ' . strtolower($journal->review_process) . '.';
        }
        if ($journal->doaj_license) {
            $extras[] = 'Articles are licensed ' . $journal->doaj_license . '.';
        }

        return trim($sentence . ' ' . implode(' ', $extras));
    }

    /**
     * @return array<string, string> label => url
     */
    private function links(JournalSource $journal): array
    {
        $refs = (array) ($journal->ref_urls ?? []);

        return array_filter([
            'Journal website' => $journal->homepage_url ?: ($refs['journal'] ?? null),
            'Aims & scope'    => $refs['aims_scope'] ?? null,
            'Editorial board' => $refs['board'] ?? null,
        ]);
    }
}
