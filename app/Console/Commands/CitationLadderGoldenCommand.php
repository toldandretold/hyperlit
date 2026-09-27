<?php

namespace App\Console\Commands;

use App\Services\BraveSearchService;
use App\Services\CitationPipeline\Testing\CassetteWebTextAcquirer;
use App\Services\CitationPipeline\Testing\LadderCassette;
use App\Services\CitationPipeline\Testing\LadderHttpCassette;
use App\Services\WebContent\WebTextAcquirer;
use App\Services\WebFetchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;

/**
 * Characterise what the resolution ladder DECIDES, so the wave extraction can be verified instead
 * of hoped about.
 *
 * `CitationScanBibliographyJob::handle()` is 1,596 lines and no test executes it — the fourteen
 * test files that name the job all reach past `handle()` into a private helper by reflection, or
 * read the source as a string. Its failure mode is a citation silently resolving to a DIFFERENT
 * source, after which the review verifies a claim against the wrong work and nothing goes red.
 *
 *   php artisan citation:ladder:golden <book> --record   # once, live, costs money
 *   php artisan citation:ladder:golden <book> --verify   # as often as you like, free and offline
 *
 * Record runs the real scan while taping every outbound call; verify replays the tape and diffs the
 * decisions. Only the NETWORK is frozen — scoring, DOI normalisation, stub creation, the relevance
 * screen and every database write run for real on both passes, so a behaviour change in the ladder
 * shows up and a change in OpenAlex's index does not.
 */
class CitationLadderGoldenCommand extends Command
{
    protected $signature = 'citation:ladder:golden
                            {book : the bookId to characterise}
                            {--record : run live and tape the outbound calls}
                            {--verify : replay the tape and diff against the golden}
                            {--lenient : on verify, report cassette misses instead of failing on the first}
                            {--dir= : override the fixture directory}';

    protected $description = 'Record or verify a characterisation golden of the citation resolution ladder';

    /** The fields that constitute a resolution DECISION — which wave won, and what it resolved to. */
    private const TABLES = [
        'bibliography' => ['key' => 'referenceId', 'canonical' => true],
        'footnotes'    => ['key' => 'footnoteId',  'canonical' => false],
    ];

    public function handle(): int
    {
        $book = (string) $this->argument('book');
        $record = (bool) $this->option('record');
        $verify = (bool) $this->option('verify');

        if ($record === $verify) {
            $this->error('Pass exactly one of --record or --verify.');

            return 1;
        }

        $dir = rtrim((string) ($this->option('dir') ?: base_path("tests/fixtures-local/ladder/{$book}")), '/');
        $cassettePath = "{$dir}/cassette.json";
        $goldenPath = "{$dir}/golden.json";

        $cassette = $record
            ? LadderCassette::recording()
            : LadderCassette::replaying($cassettePath, strict: !$this->option('lenient'));

        $this->installCassette($cassette);
        $this->resetHostMemory();

        $this->info($record ? 'Recording a live scan — this makes real API calls and costs money.' : 'Replaying the cassette — no network.');
        $this->newLine();

        $exit = Artisan::call('citation:scan-bibliography', ['target' => $book, '--force' => true], $this->getOutput());
        if ($exit !== 0) {
            $this->error('The scan failed; not writing anything.');

            return $exit;
        }

        $decisions = $this->captureDecisions($book);
        $this->newLine();

        if ($record) {
            $cassette->save($cassettePath);
            $this->writeGolden($goldenPath, $book, $decisions);

            $stats = $cassette->stats();
            $this->info("Recorded {$stats['entries']} outbound calls → {$cassettePath}");
            $this->info('Golden of ' . count($decisions) . " decisions → {$goldenPath}");
            $this->line('Commit neither by hand — they are local fixtures (tests/fixtures-local is git-ignored).');

            return 0;
        }

        return $this->reportDiff($goldenPath, $decisions, $cassette);
    }

    // ── Wiring ───────────────────────────────────────────────────────────────

    private function installCassette(LadderCassette $cassette): void
    {
        (new LadderHttpCassette($cassette))->install();

        // The browser rungs never touch the Http facade, so the acquirer needs its own proxy.
        $acquirer = app(CassetteWebTextAcquirer::class);
        $acquirer->cassette = $cassette;
        app()->instance(WebTextAcquirer::class, $acquirer);

        // Both of these take the acquirer by constructor injection, so anything already resolved
        // is holding the REAL one. Drop them and let the container rebuild against the proxy.
        app()->forgetInstance(WebFetchService::class);
        app()->forgetInstance(BraveSearchService::class);
    }

    /**
     * A scan REMEMBERS which hosts refused it (`fetch_host_reachability`, written on pgsql_admin so
     * it survives everything), and a remembered host is skipped on cooldown for six hours. Left in
     * place, the recording run teaches the verify run to skip hosts it actually fetched — two
     * citations came back `web_fetch`/`brave_search` on the tape and `null` on replay for exactly
     * this reason, which reads as a ladder regression and is nothing of the kind.
     *
     * `tests/Pest.php` clears the same table for the whole Feature suite, for the same reason.
     */
    private function resetHostMemory(): void
    {
        DB::connection('pgsql_admin')->table('fetch_host_reachability')->delete();
    }

    // ── The golden ───────────────────────────────────────────────────────────

    /** @return array<string, array<string, mixed>> "table:key" => decision */
    private function captureDecisions(string $book): array
    {
        $out = [];

        foreach (self::TABLES as $table => $meta) {
            $columns = ['match_method', 'match_score', 'source_id'];
            if ($meta['canonical']) {
                $columns[] = 'canonical_source_id';
            }
            if ($table === 'footnotes') {
                $columns[] = 'is_citation';
            }

            $rows = DB::connection('pgsql_admin')
                ->table($table)
                ->where('book', $book)
                ->orderBy($meta['key'])
                ->get(array_merge([$meta['key']], $columns));

            foreach ($rows as $row) {
                $decision = [];
                foreach ($columns as $column) {
                    $decision[$column] = $row->{$column};
                }
                $decision['source_id'] = $this->stableSourceId($decision['source_id'] ?? null);

                $out["{$table}:{$row->{$meta['key']}}"] = self::normalise($decision);
            }
        }

        ksort($out);

        return $out;
    }

    /**
     * Both sides of the diff go through this, and the golden goes through it AGAIN after being
     * read back, because JSON does not preserve PHP's numeric type: a score of exactly 1.0 is
     * written as `1`, decodes as int, and `!==` then separates it from the float the database
     * hands back. That alone reported eleven citations as changed with the two values printing
     * identically — a diff nobody would trust twice.
     *
     * Rounding is the other half: a scoring function that moves in the sixth decimal place has not
     * changed which source won, and a golden that says otherwise is noise.
     */
    private static function normalise(array $decision): array
    {
        if (array_key_exists('match_score', $decision)) {
            $decision['match_score'] = $decision['match_score'] === null
                ? null
                : round((float) $decision['match_score'], 4);
        }

        if (array_key_exists('is_citation', $decision)) {
            $decision['is_citation'] = $decision['is_citation'] === null
                ? null
                : (bool) $decision['is_citation'];
        }

        return $decision;
    }

    /**
     * A web stub's book id is minted with a random suffix (`web_SsBefEfsDVxGRlpim2dR`), so two runs
     * that resolve a citation to the SAME source disagree on the id and the golden reports a change
     * where there is none. The id is not the decision — the source is. Substitute the stub's URL,
     * which is stable across mintings and is the thing worth diffing: if that moves, the ladder
     * really did choose a different source.
     */
    private function stableSourceId(?string $sourceId): ?string
    {
        if ($sourceId === null || !str_starts_with($sourceId, 'web_')) {
            return $sourceId;
        }

        $url = DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', $sourceId)
            ->where('type', 'web_source')
            ->value('url');

        // No row means the stub is gone (a later run re-minted and the old id is dangling). Keep the
        // raw id rather than inventing one — a vanished source IS a difference worth seeing.
        return $url ? 'web_source:' . $url : $sourceId;
    }

    private function writeGolden(string $path, string $book, array $decisions): void
    {
        if (!is_dir(dirname($path))) {
            mkdir(dirname($path), 0775, true);
        }

        file_put_contents($path, json_encode([
            'book'      => $book,
            'decisions' => $decisions,
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
    }

    // ── The diff ─────────────────────────────────────────────────────────────

    private function reportDiff(string $goldenPath, array $current, LadderCassette $cassette): int
    {
        if (!is_file($goldenPath)) {
            $this->error("No golden at {$goldenPath} — record one first.");

            return 1;
        }

        $golden = array_map(
            self::normalise(...),
            json_decode((string) file_get_contents($goldenPath), true)['decisions'] ?? []
        );

        $gone = array_diff_key($golden, $current);
        $new = array_diff_key($current, $golden);
        $changed = [];
        foreach (array_intersect_key($golden, $current) as $id => $was) {
            if ($was !== $current[$id]) {
                $changed[$id] = ['was' => $was, 'now' => $current[$id]];
            }
        }

        $stats = $cassette->stats();
        $this->line("Cassette: {$stats['hits']} hits, {$stats['misses']} misses, "
            . "{$stats['fallthroughs']} ran live by design.");

        foreach ($cassette->misses() as $miss) {
            $this->warn("  miss  {$miss['method']}  {$miss['key']}");
        }
        foreach ($cassette->fallthroughs() as $live) {
            $this->line("  <fg=gray>live  {$live['method']}  {$live['key']}</>");
        }

        if (!$gone && !$new && !$changed) {
            $this->info('No change: ' . count($current) . ' decisions identical to the golden.');

            return $stats['misses'] > 0 ? 1 : 0;
        }

        $this->newLine();
        $this->error(count($changed) . ' changed, ' . count($new) . ' new, ' . count($gone) . ' disappeared.');

        foreach ($changed as $id => $delta) {
            $this->newLine();
            $this->line("<fg=yellow>{$id}</>");
            foreach ($delta['was'] as $field => $wasValue) {
                $nowValue = $delta['now'][$field] ?? null;
                if ($wasValue !== $nowValue) {
                    $this->line("    {$field}: " . json_encode($wasValue) . ' → ' . json_encode($nowValue));
                }
            }
        }

        foreach (array_keys($new) as $id) {
            $this->line("<fg=green>+ {$id}</>");
        }
        foreach (array_keys($gone) as $id) {
            $this->line("<fg=red>- {$id}</>");
        }

        return 1;
    }
}
