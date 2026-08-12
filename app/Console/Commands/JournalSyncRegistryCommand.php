<?php

namespace App\Console\Commands;

use App\Models\JournalSource;
use App\Services\JournalHarvest\DoajJournalDirectory;
use App\Services\OpenAlex\SourceNormaliser;
use App\Services\OpenAlex\SourcesApi;
use Illuminate\Console\Command;
use Illuminate\Support\Str;

/**
 * Populate / refresh the diamond-OA journal registry (journal_sources).
 * Sources come from OpenAlex /sources (OA + in-DOAJ, most-cited first); the
 * diamond determination comes from DOAJ's explicit no-APC flag, because
 * OpenAlex's apc_usd is null for most diamond journals ("unknown", not
 * "free"). See docs/journal-harvest.md.
 */
class JournalSyncRegistryCommand extends Command
{
    protected $signature = 'journal:sync-registry
                            {--issn= : Sync a single journal by ISSN (the pilot path)}
                            {--limit=0 : Stop after storing/refreshing N journals (0 = all; most-cited come first)}
                            {--topic= : Only sources with this OpenAlex topic id (e.g. T10122)}
                            {--include-non-diamond : Also store journals that are not (or not provably) diamond}
                            {--dry-run : Print what would be stored, no writes}';

    protected $description = 'Sync the journal_sources registry of diamond open-access journals from OpenAlex, with DOAJ as the no-APC authority. Ranked by citations so journal:list shows what to harvest next.';

    /** The registry's base population: OA journals that DOAJ indexes. */
    public const SOURCES_FILTER = 'is_oa:true,is_in_doaj:true';

    public function handle(SourcesApi $sourcesApi, SourceNormaliser $normaliser, DoajJournalDirectory $doaj): int
    {
        $issn = trim((string) $this->option('issn')) ?: null;
        $limit = (int) $this->option('limit');
        $topic = trim((string) $this->option('topic')) ?: null;
        $includeNonDiamond = (bool) $this->option('include-non-diamond');
        $dryRun = (bool) $this->option('dry-run');

        if ($issn) {
            return $this->syncSingle($issn, $sourcesApi, $normaliser, $doaj, $includeNonDiamond, $dryRun);
        }

        return $this->syncAll($sourcesApi, $normaliser, $doaj, $limit, $topic, $includeNonDiamond, $dryRun);
    }

    private function syncSingle(string $issn, SourcesApi $sourcesApi, SourceNormaliser $normaliser, DoajJournalDirectory $doaj, bool $includeNonDiamond, bool $dryRun): int
    {
        $raw = $sourcesApi->fetchByIssn($issn);
        if (!$raw) {
            $this->error("OpenAlex has no source for ISSN {$issn}");
            return 1;
        }

        $source = $normaliser->normaliseSource($raw);

        $doajRow = null;
        foreach ($doaj->issnsOf($source) ?: [$issn] as $candidate) {
            $doajRow = $doaj->lookupByIssn($candidate);
            if ($doajRow) {
                break;
            }
        }

        [$isDiamond, $provenance] = $doaj->isDiamond($source, $doajRow);

        $this->line("→ {$source['openalex_source_id']} | {$source['display_name']}");
        $this->line('   issn_l: ' . ($source['issn_l'] ?? '—')
            . ' | apc_usd: ' . ($source['apc_usd'] ?? 'null')
            . ' | doaj: ' . ($doajRow ? ($doajRow['has_apc'] ? 'has APC' : 'no APC') : 'not found'));
        $this->line('   diamond: ' . ($isDiamond === null ? 'unknown' : ($isDiamond ? 'YES' : 'no'))
            . ($provenance ? " ({$provenance})" : ''));

        if ($isDiamond !== true && !$includeNonDiamond) {
            $this->warn('   Not provably diamond — not stored. Use --include-non-diamond to store anyway.');
            return 1;
        }

        if ($dryRun) {
            $this->line('   <fg=yellow>dry-run, not stored</>');
            return 0;
        }

        $journal = $this->upsert($source, $doajRow, $isDiamond === true, $provenance);
        $this->info("   Stored as slug <options=bold>{$journal->slug}</> — page: /j/{$journal->slug} — harvest with: php artisan journal:harvest {$journal->slug}");

        return 0;
    }

    private function syncAll(SourcesApi $sourcesApi, SourceNormaliser $normaliser, DoajJournalDirectory $doaj, int $limit, ?string $topic, bool $includeNonDiamond, bool $dryRun): int
    {
        $this->info('Loading DOAJ journal CSV (the no-APC authority)…');
        $doajIndex = $doaj->loadCsvIndex();
        $this->info('DOAJ index: ' . number_format(count($doajIndex)) . ' ISSN keys');

        $filter = self::SOURCES_FILTER . ($topic ? ',topics.id:' . $topic : '');
        $stats = ['seen' => 0, 'diamond' => 0, 'non_diamond' => 0, 'unknown' => 0, 'stored' => 0, 'refreshed' => 0];

        $cursor = '*';
        $page = 0;
        while ($cursor !== null) {
            $result = $sourcesApi->fetchSourcesPage($filter, $cursor);
            $cursor = $result['next_cursor'];
            $page++;

            if ($page === 1) {
                $this->info('OpenAlex sources matching [' . $filter . ']: ' . number_format((int) $result['count']));
            }

            foreach ($result['sources'] as $raw) {
                $stats['seen']++;
                $source = $normaliser->normaliseSource($raw);
                if (!$source['openalex_source_id'] || !$source['display_name']) {
                    continue;
                }

                $doajRow = null;
                foreach ($doaj->issnsOf($source) as $candidate) {
                    if (isset($doajIndex[$candidate])) {
                        $doajRow = $doajIndex[$candidate];
                        break;
                    }
                }

                [$isDiamond, $provenance] = $doaj->isDiamond($source, $doajRow);
                $bucket = $isDiamond === null ? 'unknown' : ($isDiamond ? 'diamond' : 'non_diamond');
                $stats[$bucket]++;

                if ($isDiamond !== true && !$includeNonDiamond) {
                    continue;
                }

                if ($dryRun) {
                    $stats['stored']++;
                    continue;
                }

                $existing = JournalSource::where('openalex_source_id', $source['openalex_source_id'])->exists();
                $this->upsert($source, $doajRow, $isDiamond === true, $provenance);
                $stats[$existing ? 'refreshed' : 'stored']++;

                if (($stats['stored'] + $stats['refreshed']) % 500 === 0) {
                    $this->line('   … ' . number_format($stats['seen']) . ' seen, '
                        . number_format($stats['stored']) . ' stored, '
                        . number_format($stats['refreshed']) . ' refreshed');
                }

                if ($limit > 0 && ($stats['stored'] + $stats['refreshed']) >= $limit) {
                    break 2;
                }
            }
        }

        $this->newLine();
        $this->info('Summary' . ($dryRun ? ' (dry-run — nothing written)' : '') . ':');
        foreach ($stats as $k => $v) {
            $this->line(sprintf('  %-14s %s', $k, number_format($v)));
        }
        $this->line('Next: php artisan journal:list');

        return 0;
    }

    /**
     * Insert or refresh a registry row. The slug is minted once on first
     * insert and never rewritten — it is (or will be) a public URL.
     */
    private function upsert(array $source, ?array $doajRow, bool $isDiamond, ?string $provenance): JournalSource
    {
        $attributes = [
            'issn_l'                  => $source['issn_l'],
            'issns'                   => $source['issns'],
            'display_name'            => $source['display_name'],
            // OpenAlex leaves host_organization_name null for many society
            // journals; DOAJ's publisher field backfills those.
            'publisher'               => $source['publisher'] ?? ($doajRow['publisher'] ?? null),
            'is_diamond'              => $isDiamond,
            'diamond_provenance'      => $provenance,
            'is_oa'                   => $source['is_oa'],
            'is_in_doaj'              => $source['is_in_doaj'],
            'apc_usd'                 => $source['apc_usd'],
            'works_count'             => $source['works_count'],
            'cited_by_count'          => $source['cited_by_count'],
            'two_year_mean_citedness' => $source['two_year_mean_citedness'],
            'country_code'            => $source['country_code'],
            'languages'               => $doajRow['languages'] ?? null,
            'homepage_url'            => $source['homepage_url'],
            'topics'                  => $source['topics'],
            'last_synced_at'          => now(),
        ];

        $journal = JournalSource::where('openalex_source_id', $source['openalex_source_id'])->first();
        if ($journal) {
            $journal->update($attributes);
            return $journal;
        }

        return JournalSource::create($attributes + [
            'openalex_source_id' => $source['openalex_source_id'],
            'slug'               => $this->uniqueSlug($source['display_name']),
        ]);
    }

    private function uniqueSlug(string $displayName): string
    {
        $base = Str::limit(Str::slug($displayName), 140, '') ?: 'journal';

        $slug = $base;
        $n = 2;
        while (JournalSource::where('slug', $slug)->exists()) {
            $slug = $base . '-' . $n++;
        }

        return $slug;
    }
}
