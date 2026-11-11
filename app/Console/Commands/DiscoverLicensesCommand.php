<?php

namespace App\Console\Commands;

use App\Services\Licensing\LicenseDiscovery;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Finds the real licence of third-party works whose stored licence is a guess, by asking
 * local artefacts and then Crossref / DataCite / OpenAlex / Europe PMC / Semantic Scholar /
 * arXiv / Internet Archive. See App\Services\Licensing\LicenseDiscovery for the ladder and the
 * decision rules.
 *
 *   php artisan library:discover-licenses --report            what is even reachable (no requests)
 *   php artisan library:discover-licenses --limit=200         dry run: asks, records evidence, writes no licence
 *   php artisan library:discover-licenses --apply             writes (reuses a dry run's fresh evidence offline)
 *
 * Dry runs write `license_evidence` (that's the audit) but never `library`.
 */
class DiscoverLicensesCommand extends Command
{
    protected $signature = 'library:discover-licenses
        {--apply : write licence changes (default is a dry run)}
        {--limit=0 : stop after this many rows (0 = all in scope)}
        {--scope=all : unknown | open-unspecified | versionless | status-inferred | all}
        {--source=* : only these sources (e.g. --source=crossref --source=datacite)}
        {--book=* : only these book ids (ignores the cooldown)}
        {--fetch-pages : also fetch hosted works\' landing pages live (plain HTTP)}
        {--fresh : ignore stored evidence and ask the sources again}
        {--max-seconds=0 : stop cleanly after this long (for the queued runner)}
        {--report : print the reachability breakdown of the scope and exit}';

    protected $description = 'Find the real licence of harvested/imported works stored as Unknown, open-unspecified, version-less or status-inferred';

    public function handle(): int
    {
        $scope = (string) $this->option('scope');
        if (! in_array($scope, LicenseDiscovery::SCOPES, true)) {
            $this->error('--scope must be one of: ' . implode(', ', LicenseDiscovery::SCOPES));

            return self::INVALID;
        }
        $apply = (bool) $this->option('apply');
        $books = array_values(array_filter((array) $this->option('book')));
        $limit = (int) $this->option('limit');
        $maxSeconds = (int) $this->option('max-seconds');

        $candidates = LicenseDiscovery::candidateBooks($scope, $books, $apply, $limit);

        if ($this->option('report')) {
            $this->report($candidates);

            return self::SUCCESS;
        }

        $sources = LicenseDiscovery::defaultSources((bool) $this->option('fetch-pages'));
        if ($only = array_values(array_filter((array) $this->option('source')))) {
            $sources = array_values(array_filter($sources, fn ($s) => in_array($s->name(), $only, true)));
        }
        $discovery = new LicenseDiscovery($sources);

        $this->info(sprintf('%d row(s) in scope "%s" — %s.', count($candidates), $scope, $apply ? 'APPLYING' : 'dry run'));

        $started = time();
        $breakerTripped = false;
        $tally = [];
        $reasons = [];
        $bySource = [];
        $arxivHosted = 0;
        $changed = 0;
        $processed = 0;
        $bar = $this->output->createProgressBar(count($candidates));

        foreach (array_chunk($candidates, 200) as $chunk) {
            $rows = LicenseDiscovery::loadRows($chunk);
            foreach ($chunk as $book) {
                if ($maxSeconds > 0 && time() - $started >= $maxSeconds) {
                    break 2;
                }
                $row = $rows[$book] ?? null;
                if (! $row) {
                    continue;
                }

                $result = $this->option('fresh') ? null : $discovery->fromStoredEvidence($book);
                if ($result === null) {
                    $disabledBefore = count($discovery->disabled);
                    $result = $discovery->discover($row);
                    if ($apply && count($discovery->disabled) > $disabledBefore) {
                        // A source just went down. Stop rather than stamp rows "checked" that
                        // it never got to answer — they'd sit out a whole cooldown unasked.
                        $breakerTripped = true;
                        break 2;
                    }
                    LicenseDiscovery::recordEvidence($book, $result['evidence']);
                }
                $decision = $result['decision'];

                if (LicenseDiscovery::changes($row, $decision)) {
                    $key = $decision['license'] === $row->license
                        ? "{$row->license} (terms link added)"
                        : "{$row->license} → {$decision['license']}";
                    $tally[$key] = ($tally[$key] ?? 0) + 1;
                    $bySource[$decision['source']] = ($bySource[$decision['source']] ?? 0) + 1;
                    $changed++;
                    if ($decision['license'] === \App\Support\Licenses::ARXIV_NONEXCLUSIVE && $row->has_nodes) {
                        $arxivHosted++;
                    }
                } else {
                    $why = $decision ? 'confirmed as stored' : $result['reason'];
                    $reasons[$why] = ($reasons[$why] ?? 0) + 1;
                }
                if ($apply) {
                    LicenseDiscovery::apply($row, $decision);
                }
                $processed++;
                $bar->advance();
            }
        }
        $bar->finish();
        $this->newLine(2);

        arsort($tally);
        arsort($bySource);
        arsort($reasons);
        if ($tally) {
            $this->line('<options=bold>Changes</>');
            foreach ($tally as $k => $n) {
                $this->line("  {$k}: {$n}");
            }
            $this->line('<options=bold>Decided by</>');
            foreach ($bySource as $k => $n) {
                $this->line("  {$k}: {$n}");
            }
        }
        if ($reasons) {
            $this->line('<options=bold>Unchanged</>');
            foreach ($reasons as $k => $n) {
                $this->line("  {$k}: {$n}");
            }
        }
        if ($discovery->disabled) {
            $this->warn('Sources switched off after repeated failures: ' . implode(', ', array_keys($discovery->disabled)));
        }
        if ($arxivHosted) {
            $this->warn("{$arxivHosted} HOSTED work(s) carry only arXiv's non-exclusive licence, which grants distribution to arXiv alone.");
        }

        $this->info(sprintf('%s %d of %d processed row(s).%s', $apply ? 'Changed' : 'Would change', $changed, $processed, $apply ? '' : ' Re-run with --apply to write (stored evidence is reused, no new requests).'));
        if ($processed < count($candidates)) {
            $this->line(sprintf('Stopped after %d s; %d row(s) left.', time() - $started, count($candidates) - $processed));
        }

        // Exit code 2 = stopped because a source went down: the queued runner must not chain.
        return $breakerTripped ? 2 : self::SUCCESS;
    }

    /** What the scope looks like and which identifiers we hold — no requests. */
    private function report(array $candidates): void
    {
        $this->info(count($candidates) . ' row(s) in scope.');
        $t = [];
        foreach (array_chunk($candidates, 2000) as $chunk) {
            $rows = DB::connection('pgsql_admin')->table('library as l')
                ->leftJoin('canonical_source as c', 'c.id', '=', 'l.canonical_source_id')
                ->whereIn('l.book', $chunk)
                ->selectRaw("l.license, l.has_nodes,
                    (coalesce(l.doi, c.doi) is not null) as has_doi,
                    (coalesce(l.openalex_id, c.openalex_id) is not null) as has_openalex,
                    (coalesce(l.open_library_key, c.open_library_key) is not null or l.url ilike '%openlibrary.org/%') as has_ol,
                    (coalesce(l.doi, '') ilike '10.48550/arxiv%' or coalesce(l.url, '') ~* '(arxiv|ar5iv)') as has_arxiv,
                    (c.oa_locations is not null) as has_oa_locations")
                ->get();
            foreach ($rows as $r) {
                $ids = array_keys(array_filter([
                    'DOI' => $r->has_doi, 'OpenAlex' => $r->has_openalex, 'OpenLibrary' => $r->has_ol,
                    'arXiv' => $r->has_arxiv, 'oa_locations' => $r->has_oa_locations,
                ]));
                $key = sprintf('%-18s %-7s %s', $r->license, $r->has_nodes ? 'hosted' : 'stub', $ids ? implode('+', $ids) : 'NO IDENTIFIER');
                $t[$key] = ($t[$key] ?? 0) + 1;
            }
        }
        arsort($t);
        foreach ($t as $k => $n) {
            $this->line(sprintf('  %6d  %s', $n, $k));
        }
    }
}
