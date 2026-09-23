<?php

namespace App\Services\Archives;

use App\Models\ArchiveSource;
use Illuminate\Support\Facades\Cache;

/**
 * The archives the homepage links out to: certified by an operator AND holding
 * at least one readable document — the same two gates, failing in the same
 * directions, as CertifiedJournalsQuery. `certified_at` is the human judgement
 * (toggled in the shelf-import console) that nothing automatic may grant; the
 * readable floor SELF-HEALS, so the homepage can never link to an empty
 * archive page.
 *
 * Cached stale-while-revalidate with viewer-independent public counts, same as
 * CertifiedJournalsQuery (whose RLS-per-request form cost ~4.8s on prod and
 * read as "clicking Home stalls"; this twin is only fast today because the
 * archive corpus is small). The certify toggle busts the cache directly
 * (ShelfImportController), so operator liveness is preserved; the readable
 * floor's self-heal lags at most the fresh TTL.
 */
class CertifiedArchivesQuery
{
    public const CACHE_KEY = 'certified-archives-homepage:v1';

    private const CACHE_TTL = 900;

    private const CACHE_STALE_TTL = 86400;

    public function __construct(private ArchiveReadableCount $readableCount)
    {
    }

    /**
     * @return array<int, array{slug: string, display_name: string, readable: int}>
     */
    public function forHomepage(): array
    {
        return Cache::flexible(
            self::CACHE_KEY,
            [self::CACHE_TTL, self::CACHE_STALE_TTL],
            fn () => $this->build(),
        );
    }

    /** @return array<int, array{slug: string, display_name: string, readable: int}> */
    private function build(): array
    {
        $archives = ArchiveSource::query()
            ->whereNotNull('certified_at')
            ->orderBy('display_name')
            ->get();

        if ($archives->isEmpty()) {
            return [];
        }

        $counts = $this->readableCount->forArchivesPublic(
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
