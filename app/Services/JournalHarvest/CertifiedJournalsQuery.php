<?php

namespace App\Services\JournalHarvest;

use App\Models\JournalSource;
use Illuminate\Support\Facades\Cache;

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
 * Cached stale-while-revalidate: this used to run per-request under the
 * caller's RLS view and measured ~4.8s on prod (2026-09-23) — the SPA fetches
 * `/` while the user still looks at the outgoing page, so the whole cost read
 * as "clicking Home stalls". The counts are now the viewer-independent public
 * variant (safe to share), served stale-instantly while a rebuild runs after
 * the response. A certify toggle busts the cache directly
 * (JournalImportController::setCertified), so operator liveness is preserved;
 * the readable-floor self-heal lags at most the fresh TTL.
 * See docs/journal-harvest.md.
 */
class CertifiedJournalsQuery
{
    public const CACHE_KEY = 'certified-journals-homepage:v1';

    private const CACHE_TTL = 900;

    private const CACHE_STALE_TTL = 86400;

    public function __construct(private JournalReadableCount $readableCount)
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
        $journals = JournalSource::query()
            ->whereNotNull('certified_at')
            ->orderBy('display_name')
            ->get();

        if ($journals->isEmpty()) {
            return [];
        }

        $counts = $this->readableCount->forJournalsPublic($journals->pluck('id')->all());

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
