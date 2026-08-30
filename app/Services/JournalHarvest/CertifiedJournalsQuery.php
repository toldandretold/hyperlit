<?php

namespace App\Services\JournalHarvest;

use App\Models\JournalSource;

/**
 * The journals the homepage links out to: certified by an operator AND holding
 * at least one readable article.
 *
 * Two gates rather than one, because they fail in different directions.
 * `certified_at` is the human judgement — a person read the conversions and is
 * willing to put the journal in front of visitors — and nothing automatic
 * should be able to grant it. The readable-article floor is the half that
 * SELF-HEALS: if every lane of a journal is demoted, retracted or loses its
 * content, the journal drops off the homepage on the next request without
 * anyone remembering to un-certify it, so the homepage can never link to an
 * empty journal page.
 *
 * The registry holds thousands of rows after a full `journal:sync-registry`;
 * the certified slice is tiny and indexed (partial index on certified_at), and
 * the counts are one grouped query, so this is cheap enough to run uncached on
 * every homepage request. See docs/journal-harvest.md.
 */
class CertifiedJournalsQuery
{
    public function __construct(private JournalReadableCount $readableCount)
    {
    }

    /**
     * @return array<int, array{slug: string, display_name: string, readable: int}>
     */
    public function forHomepage(): array
    {
        $journals = JournalSource::query()
            ->whereNotNull('certified_at')
            ->orderBy('display_name')
            ->get();

        if ($journals->isEmpty()) {
            return [];
        }

        $counts = $this->readableCount->forJournals($journals->pluck('id')->all());

        return $journals
            ->map(fn (JournalSource $j) => [
                'slug'         => $j->slug,
                'display_name' => $j->display_name,
                'readable'     => $counts[$j->id] ?? 0,
            ])
            ->filter(fn (array $row) => $row['readable'] > 0)
            ->values()
            ->all();
    }
}
