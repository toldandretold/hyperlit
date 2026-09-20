<?php

namespace App\Console\Commands;

use App\Services\WebContent\WebTextAcquirer;
use App\Services\WebFetchService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * Measure the citation resolver's web acquisition WITHOUT paying for a review.
 *
 * A full citation review costs real money (LLM tokens per claim plus Brave
 * requests), which made "did the resolver get better?" an expensive question
 * and mixed resolver changes in with reviewer changes. This replays a known set
 * of citation URLs through acquire -> extract -> grade only. No LLM, no Brave,
 * no DB writes — so it can be run as often as you like while tuning, and its
 * JSON output diffs cleanly against an earlier run.
 *
 * Sources of URLs (pick one):
 *   --from-run=<dir>   a citation-study run directory (reads *.claims.json and
 *                      pulls the URL out of every unresolved reference's
 *                      bibliography entry — i.e. exactly the citations that
 *                      failed, which is the population worth measuring)
 *   --book=<bookId>    a book's bibliography rows, straight from Postgres
 *   --urls=<file>      a plain text file, one URL per line
 *
 * `--legacy` reproduces the OLD extraction (regex strip + strip_tags, judged on
 * a 200-char floor) over the same pages, so a single invocation can show the
 * before and after side by side.
 */
class CitationWebBenchCommand extends Command
{
    protected $signature = 'citation:web:bench
        {--from-run= : A study run directory containing *.claims.json}
        {--book= : A book ID whose bibliography URLs to replay}
        {--urls= : A text file of URLs, one per line}
        {--limit=0 : Stop after N URLs (0 = all)}
        {--no-browser : Cheap rung only — do not escalate to the headless browser}
        {--respect-cooldown : Honour the per-host cooldown (default: ignore it, so the bench measures the LADDER, not our memory of it)}
        {--legacy : Also run the pre-2026-09 extraction for comparison}
        {--out= : Write the per-URL JSON report here}
        {--compare= : An earlier report to diff this run against}';

    protected $description = 'Bench web acquisition + extraction for citation resolution (no LLM, no Brave, no writes)';

    public function handle(WebFetchService $webFetch, WebTextAcquirer $acquirer): int
    {
        // A bench that skipped every known-bad host would report an
        // "improvement" that is really just FetchHostHealth remembering. The
        // point here is to measure the ladder, so cooldowns are off unless
        // asked for.
        if (! $this->option('respect-cooldown')) {
            app(\App\Services\WebContent\FetchHostHealth::class)->ignoreCooldowns();
        }

        $urls = $this->collectUrls();
        if ($urls === []) {
            $this->error('No URLs to bench. Pass --from-run, --book or --urls.');

            return 1;
        }

        $limit = (int) $this->option('limit');
        if ($limit > 0) {
            $urls = array_slice($urls, 0, $limit);
        }

        $allowBrowser = ! $this->option('no-browser');
        $this->line(sprintf(
            '  %d URL(s); browser escalation %s.',
            count($urls),
            $allowBrowser ? 'ON' : 'OFF',
        ));
        $this->newLine();

        $rows = [];
        foreach (array_values($urls) as $i => $entry) {
            $url = $entry['url'];
            $t0 = microtime(true);
            $result = $acquirer->acquire($url, $allowBrowser);
            $elapsed = microtime(true) - $t0;

            $row = [
                'ref'        => $entry['ref'] ?? null,
                'url'        => $url,
                'host'       => parse_url($url, PHP_URL_HOST),
                'grade'      => $result['grade'],
                'reason'     => $result['reason'],
                'channel'    => $result['channel'],
                'extraction' => $result['extraction'],
                'chars'      => $result['chars'],
                'blocks'     => $result['prose_blocks'],
                'status'     => $result['http_status'],
                'seconds'    => round($elapsed, 2),
                'head'       => $result['text'] !== null ? Str::limit($result['text'], 160, '…') : null,
            ];

            if ($this->option('legacy')) {
                $row['legacy_chars'] = $this->legacyChars($url);
            }

            $rows[] = $row;

            $this->line(sprintf(
                '  [%d/%d] <fg=%s>%-16s</> %-8s %-13s %6d ch  %5.1fs  %s',
                $i + 1,
                count($urls),
                in_array($result['grade'], WebTextAcquirer::USABLE_GRADES, true) ? 'green' : 'yellow',
                $result['grade'],
                $result['channel'],
                $result['extraction'],
                $result['chars'],
                $elapsed,
                Str::limit((string) $row['host'], 28),
            ));
        }

        $this->summarise($rows);

        $out = $this->option('out');
        if ($out) {
            File::ensureDirectoryExists(dirname($out));
            File::put($out, json_encode($rows, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            $this->line("  Report: {$out}");
        }

        if ($compare = $this->option('compare')) {
            $this->compare($rows, $compare);
        }

        return 0;
    }

    /** @return list<array{url: string, ref: ?string}> */
    private function collectUrls(): array
    {
        if ($file = $this->option('urls')) {
            if (! File::exists($file)) {
                $this->error("No such file: {$file}");

                return [];
            }
            $lines = preg_split('/\R/', File::get($file)) ?: [];

            return $this->dedupe(array_map(
                fn ($l) => ['url' => trim($l), 'ref' => null],
                array_filter($lines, fn ($l) => Str::startsWith(trim($l), 'http')),
            ));
        }

        if ($bookId = $this->option('book')) {
            $webFetch = app(WebFetchService::class);
            $rows = DB::connection('pgsql_admin')->table('bibliography')
                ->where('book', $bookId)
                ->select(['referenceId', 'content'])
                ->get();

            $out = [];
            foreach ($rows as $row) {
                $url = $webFetch->extractUrl($row->content ?? '');
                if ($url) {
                    $out[] = ['url' => $url, 'ref' => $row->referenceId];
                }
            }

            return $this->dedupe($out);
        }

        if ($dir = $this->option('from-run')) {
            return $this->dedupe($this->urlsFromRun($dir));
        }

        return [];
    }

    /**
     * Pull URLs out of a study run's claims, restricted to the references that
     * did NOT resolve. Those are the ones the bench exists to move.
     *
     * @return list<array{url: string, ref: ?string}>
     */
    private function urlsFromRun(string $dir): array
    {
        $files = glob(rtrim($dir, '/') . '/*.claims.json') ?: [];
        if ($files === []) {
            $this->error("No *.claims.json in {$dir}");

            return [];
        }

        $webFetch = app(WebFetchService::class);
        $out = [];

        foreach ($files as $file) {
            $claims = json_decode(File::get($file), true);
            if (! is_array($claims)) {
                continue;
            }
            foreach ($claims as $claim) {
                // evidence_type 'none' is the pipeline's own marker for "no
                // source content of any kind reached the reviewer".
                if (($claim['evidence_type'] ?? null) !== 'none') {
                    continue;
                }
                $url = $webFetch->extractUrl((string) ($claim['bib_citation'] ?? ''));
                if ($url) {
                    $out[] = ['url' => $url, 'ref' => $claim['referenceId'] ?? null];
                }
            }
        }

        return $out;
    }

    /**
     * @param  iterable<array{url: string, ref: ?string}>  $rows
     * @return list<array{url: string, ref: ?string}>
     */
    private function dedupe(iterable $rows): array
    {
        $seen = [];
        $out = [];
        foreach ($rows as $row) {
            if ($row['url'] === '' || isset($seen[$row['url']])) {
                continue;
            }
            $seen[$row['url']] = true;
            $out[] = $row;
        }

        return $out;
    }

    /**
     * The extraction this replaced: strip seven tags, strip_tags the rest,
     * collapse all whitespace, require 200 chars. Reproduced here (rather than
     * kept in the service) purely so the bench can show what it was costing.
     */
    private function legacyChars(string $url): int
    {
        $page = app(\App\Services\ContentFetchService::class)->acquirePageHtml($url, false);
        if (($page['html'] ?? null) === null) {
            return 0;
        }

        $cleaned = preg_replace([
            '/<script\b[^>]*>.*?<\/script>/is',
            '/<style\b[^>]*>.*?<\/style>/is',
            '/<nav\b[^>]*>.*?<\/nav>/is',
            '/<header\b[^>]*>.*?<\/header>/is',
            '/<footer\b[^>]*>.*?<\/footer>/is',
            '/<aside\b[^>]*>.*?<\/aside>/is',
            '/<svg\b[^>]*>.*?<\/svg>/is',
        ], '', (string) $page['html']);
        $cleaned = trim((string) preg_replace('/\s+/', ' ', html_entity_decode(strip_tags((string) $cleaned), ENT_QUOTES, 'UTF-8')));

        return strlen($cleaned) < 200 ? 0 : strlen($cleaned);
    }

    /** @param list<array<string, mixed>> $rows */
    private function summarise(array $rows): void
    {
        $byGrade = [];
        foreach ($rows as $row) {
            $byGrade[$row['grade']] = ($byGrade[$row['grade']] ?? 0) + 1;
        }
        arsort($byGrade);

        $usable = count(array_filter($rows, fn ($r) => in_array($r['grade'], WebTextAcquirer::USABLE_GRADES, true)));
        $viaBrowser = count(array_filter($rows, fn ($r) => $r['channel'] === 'browser' && in_array($r['grade'], WebTextAcquirer::USABLE_GRADES, true)));

        $this->newLine();
        $this->info(sprintf('  %d/%d usable (%.0f%%) — %d of them only via the browser',
            $usable, count($rows), count($rows) ? $usable / count($rows) * 100 : 0, $viaBrowser));
        foreach ($byGrade as $grade => $n) {
            $this->line("    {$grade}: {$n}");
        }

        if ($this->option('legacy')) {
            $legacyUsable = count(array_filter($rows, fn ($r) => ($r['legacy_chars'] ?? 0) > 0));
            $this->line(sprintf('    legacy extraction would have yielded text for %d of %d', $legacyUsable, count($rows)));
        }
        $this->newLine();
    }

    /** @param list<array<string, mixed>> $rows */
    private function compare(array $rows, string $priorPath): void
    {
        if (! File::exists($priorPath)) {
            $this->error("No such report: {$priorPath}");

            return;
        }
        $prior = json_decode(File::get($priorPath), true);
        if (! is_array($prior)) {
            $this->error("Unreadable report: {$priorPath}");

            return;
        }

        $priorByUrl = [];
        foreach ($prior as $row) {
            $priorByUrl[$row['url'] ?? ''] = $row;
        }

        $gained = $lost = $changed = 0;
        foreach ($rows as $row) {
            $was = $priorByUrl[$row['url']] ?? null;
            if ($was === null) {
                continue;
            }
            $nowUsable = in_array($row['grade'], WebTextAcquirer::USABLE_GRADES, true);
            $wasUsable = in_array($was['grade'] ?? '', WebTextAcquirer::USABLE_GRADES, true);

            if ($nowUsable && ! $wasUsable) {
                $gained++;
                $this->line("    <fg=green>+ {$row['host']}</> {$was['grade']} → {$row['grade']}");
            } elseif ($wasUsable && ! $nowUsable) {
                $lost++;
                $this->line("    <fg=red>- {$row['host']}</> {$was['grade']} → {$row['grade']}");
            } elseif (($was['grade'] ?? null) !== $row['grade']) {
                $changed++;
            }
        }

        $this->newLine();
        $this->info("  vs {$priorPath}: +{$gained} newly readable, -{$lost} regressed, {$changed} regraded");
    }
}
