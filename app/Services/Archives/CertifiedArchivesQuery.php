<?php

namespace App\Services\Archives;

use App\Models\ArchiveSource;

/**
 * The archives the homepage links out to: certified by an operator AND holding
 * at least one readable document — the same two gates, failing in the same
 * directions, as CertifiedJournalsQuery. `certified_at` is the human judgement
 * (toggled in the shelf-import console) that nothing automatic may grant; the
 * readable floor SELF-HEALS, so the homepage can never link to an empty
 * archive page. The certified slice is tiny (partial index), so this runs
 * uncached on every homepage request.
 */
class CertifiedArchivesQuery
{
    public function __construct(private ArchiveReadableCount $readableCount)
    {
    }

    /**
     * @return array<int, array{slug: string, display_name: string, readable: int}>
     */
    public function forHomepage(): array
    {
        $archives = ArchiveSource::query()
            ->whereNotNull('certified_at')
            ->orderBy('display_name')
            ->get();

        if ($archives->isEmpty()) {
            return [];
        }

        $counts = $this->readableCount->forArchives(
            $archives->pluck('shelf_id', 'id')->all()
        );

        return $archives
            ->map(fn (ArchiveSource $a) => [
                'slug'         => $a->slug,
                'display_name' => $a->display_name,
                'readable'     => $counts[$a->id] ?? 0,
            ])
            ->filter(fn (array $row) => $row['readable'] > 0)
            ->values()
            ->all();
    }
}
