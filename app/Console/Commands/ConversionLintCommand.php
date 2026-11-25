<?php

namespace App\Console\Commands;

use App\Models\ConversionFlag;
use App\Services\Conversion\BookExport;
use App\Services\Conversion\ConversionLint;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Search a journal (shelf, book, or the whole library) for conversion defects, offline.
 *
 * The point is to stop finding converter bugs one human read at a time. Run it over a journal,
 * read the worst-ranked books first, fix the converter, reconvert, and run it again with
 * --compare against the snapshot from before: the per-detector delta says what the fix moved
 * (and whether it broke something it shouldn't have) across the WHOLE journal, not just the
 * books someone happened to open. Detectors and their provenance: ConversionLint.
 *
 *   php artisan conversion:lint --journal=triplec --save=storage/app/lint/triplec-before.json
 *   … deploy fix, reconvert journal …
 *   php artisan conversion:lint --journal=triplec --compare=storage/app/lint/triplec-before.json
 */
class ConversionLintCommand extends Command
{
    protected $signature = 'conversion:lint
        {--journal= : Journal slug, display-name fragment or journal_sources id}
        {--shelf= : Shelf id}
        {--book= : One book}
        {--detector= : Only report this detector (see ConversionLint)}
        {--limit=0 : Stop after N books (0 = all)}
        {--top=25 : Books to list in the ranking}
        {--sample=3 : Example findings to print per book}
        {--out= : Write the full review list (every finding, with links) to this .md file}
        {--json= : Write every finding as a JSON row (book, title, detector, startLine, url, excerpt) for offline assessment}
        {--save= : Write a JSON snapshot (per-book counts + finding keys) for a later --compare}
        {--compare= : Compare against a snapshot from --save: per-detector and per-book deltas}
        {--base-url=https://hyperlit.io : Reader origin for links in --out}
        {--flag : Raise a conversion_flag for books scoring >= --min-score (shows in /maintainer/conversion)}
        {--min-score=6 : Score threshold for --flag}
        {--unflag : UNDO — delete the flags a previous --flag run raised, and stop}';

    protected $description = 'Lint converted books for structural conversion defects (page-break splits, false blockquotes, footnote twins, chrome leaks…)';

    private const ISSUE_TYPE = 'conversion_lint';

    public function handle(ConversionLint $lint): int
    {
        if ($this->option('unflag')) {
            $deleted = DB::table('conversion_flags')
                ->where('source', ConversionFlag::SOURCE_AUTO_SWEEP)
                ->whereRaw("jsonb_exists(details->'issueTypes', ?)", [self::ISSUE_TYPE])
                ->delete();
            $this->info("Deleted {$deleted} conversion-lint flag(s). Other flags untouched.");
            return self::SUCCESS;
        }

        $db = DB::connection('pgsql_admin');
        $books = $this->scope($db);
        if ($books->isEmpty()) {
            $this->info('No books in scope.');
            return self::SUCCESS;
        }
        $this->line("Linting {$books->count()} book(s)…");

        $perBook = [];
        $chromeCands = [];
        foreach ($books as $row) {
            $nodes = $db->table('nodes')->where('book', $row->book)
                ->orderByRaw('CAST("startLine" AS numeric)')
                ->get(['startLine', 'content'])
                ->map(fn ($n) => ['startLine' => (string) $n->startLine, 'content' => (string) $n->content])
                ->all();
            $footnotes = $db->table('footnotes')->where('book', $row->book)
                ->pluck('content', 'footnoteId')->map(fn ($c) => (string) $c)->all();
            $res = $lint->lintBook($nodes, $footnotes, ConversionLint::evidenceFor((string) $row->book));
            $perBook[$row->book] = ['title' => $row->title, 'findings' => $res['findings']];
            $chromeCands[$row->book] = $res['chrome_candidates'];
        }
        foreach ($lint->chromeLeaks($chromeCands) as $book => $leaks) {
            foreach (array_unique($leaks) as $leak) {
                $perBook[$book]['findings'][] = ['detector' => 'chrome_leak', 'startLine' => '', 'excerpt' => $leak];
            }
        }

        if ($only = $this->option('detector')) {
            foreach ($perBook as &$b) {
                $b['findings'] = array_values(array_filter($b['findings'], fn ($f) => $f['detector'] === $only));
            }
            unset($b);
        }
        foreach ($perBook as &$b) {
            $b['counts'] = array_count_values(array_column($b['findings'], 'detector'));
            $b['score'] = ConversionLint::score($b['counts']);
        }
        unset($b);
        uasort($perBook, fn ($a, $b) => $b['score'] <=> $a['score']);

        $this->printTotals($perBook);
        $this->printRanking($perBook);

        if ($path = $this->option('out')) {
            file_put_contents($path, $this->reviewDocument($perBook));
            $this->info("Full review list → {$path}");
        }
        if ($path = $this->option('json')) {
            $base = rtrim((string) $this->option('base-url'), '/');
            $rows = [];
            foreach ($perBook as $book => $b) {
                foreach ($b['findings'] as $f) {
                    $rows[] = ['book' => $book, 'title' => $b['title'], 'detector' => $f['detector'],
                        'startLine' => $f['startLine'],
                        'url' => $f['startLine'] !== '' ? "{$base}/{$book}#{$f['startLine']}" : "{$base}/{$book}",
                        'excerpt' => $f['excerpt']];
                }
            }
            @mkdir(dirname($path), 0775, true);
            file_put_contents($path, json_encode($rows, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
            $this->info(count($rows) . " finding(s) → {$path}");
        }
        if ($path = $this->option('save')) {
            @mkdir(dirname($path), 0775, true);
            file_put_contents($path, json_encode($this->snapshot($perBook), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
            $this->info("Snapshot → {$path}");
        }
        if ($path = $this->option('compare')) {
            $this->compare($perBook, $path);
        }

        return $this->option('flag') ? $this->flag($perBook) : self::SUCCESS;
    }

    private function scope($db)
    {
        $q = $db->table('library')->where('has_nodes', true)->where('book', 'not like', '%/%')
            ->where(fn ($w) => $w->whereNull('visibility')->orWhere('visibility', '!=', 'deleted'));
        if ($book = $this->option('book')) {
            $q->where('book', $book);
        }
        if ($shelf = $this->option('shelf')) {
            $q->whereIn('book', fn ($s) => $s->select('book')->from('shelf_items')->where('shelf_id', $shelf));
        }
        if ($journal = $this->option('journal')) {
            $isUuid = (bool) preg_match('/^[0-9a-f-]{36}$/i', $journal);
            $src = $db->table('journal_sources')
                ->when($isUuid, fn ($w) => $w->where('id', $journal))
                ->when(!$isUuid, fn ($w) => $w->where('slug', $journal)->orWhere('display_name', 'ilike', "%{$journal}%"))
                ->first(['id', 'display_name']);
            if (!$src) {
                $this->error("No journal_sources row matches '{$journal}'.");
                return collect();
            }
            $this->line("Journal: {$src->display_name}");
            $q->whereIn('canonical_source_id', fn ($s) => $s->select('id')->from('canonical_source')
                ->where('journal_source_id', $src->id));
        }
        if (!$this->option('book') && !$this->option('shelf') && !$this->option('journal')) {
            // Whole library: conversions only (not hand-written books or pseudo-books).
            $q->where(fn ($w) => $w->whereNotNull('conversion_method')->orWhereNotNull('fileType'));
        }
        if (($limit = (int) $this->option('limit')) > 0) {
            $q->limit($limit);
        }
        return $q->orderBy('book')->get(['book', 'title']);
    }

    private function printTotals(array $perBook): void
    {
        $tot = [];
        $booksWith = [];
        foreach ($perBook as $b) {
            foreach ($b['counts'] as $d => $n) {
                $tot[$d] = ($tot[$d] ?? 0) + $n;
                $booksWith[$d] = ($booksWith[$d] ?? 0) + 1;
            }
        }
        arsort($tot);
        $this->newLine();
        $this->line('<comment>Findings by detector</comment> (total · books affected)');
        foreach ($tot as $d => $n) {
            $this->line(sprintf('  %-20s %5d · %d', $d, $n, $booksWith[$d]));
        }
        if (!$tot) {
            $this->line('  none');
        }
    }

    private function printRanking(array $perBook): void
    {
        $this->newLine();
        $this->line('<comment>Worst first</comment>');
        $sample = (int) $this->option('sample');
        foreach (array_slice($perBook, 0, (int) $this->option('top'), true) as $book => $b) {
            if ($b['score'] === 0) {
                break;
            }
            $summary = implode(', ', array_map(fn ($d, $n) => "{$d}×{$n}", array_keys($b['counts']), $b['counts']));
            $this->line(sprintf('<info>%3d</info>  %s  %s', $b['score'], $book, mb_substr((string) $b['title'], 0, 50)));
            $this->line("       {$summary}");
            foreach (array_slice($b['findings'], 0, $sample) as $f) {
                $this->line(sprintf('       · [%s] %s', $f['detector'], mb_substr($f['excerpt'], 0, 140)));
            }
        }
    }

    private function reviewDocument(array $perBook): string
    {
        $base = rtrim((string) $this->option('base-url'), '/');
        $md = "# Conversion lint\n\nGenerated " . now()->toDateTimeString() . ". Worst-ranked first. A finding is a place to look, not a verdict.\n\n";
        foreach ($perBook as $book => $b) {
            if ($b['score'] === 0) {
                continue;
            }
            $md .= "## {$b['title']} (score {$b['score']})\n\n- **Book** — [{$book}]({$base}/{$book}) · [maintainer]({$base}/maintainer/conversion?book={$book})\n";
            foreach ($b['findings'] as $f) {
                $link = $f['startLine'] !== '' ? " ([#{$f['startLine']}]({$base}/{$book}#{$f['startLine']}))" : '';
                $md .= '- **' . $f['detector'] . "**{$link} — " . str_replace("\n", ' ', $f['excerpt']) . "\n";
            }
            $md .= "\n";
        }
        return $md;
    }

    private function snapshot(array $perBook): array
    {
        $out = ['taken_at' => now()->toIso8601String(), 'books' => []];
        foreach ($perBook as $book => $b) {
            $out['books'][$book] = [
                'title'  => $b['title'],
                'counts' => $b['counts'],
                'keys'   => array_values(array_unique(array_map([ConversionLint::class, 'key'], $b['findings']))),
            ];
        }
        return $out;
    }

    private function compare(array $perBook, string $path): void
    {
        $before = json_decode((string) @file_get_contents($path), true);
        if (!is_array($before) || !isset($before['books'])) {
            $this->error("Not a conversion:lint snapshot: {$path}");
            return;
        }
        // One definition of "what changed" — the console's before/after strip uses the same one.
        $diff = ConversionLint::compare($before['books'], $this->snapshot($perBook)['books']);
        $worse = $diff['new'];

        $this->newLine();
        $this->line("<comment>Compared with {$path}</comment> (taken {$before['taken_at']}, {$diff['compared']} book(s) in both)");
        foreach ($diff['detectors'] as $d => [$a, $b]) {
            if ($a !== $b) {
                $this->line(sprintf('  %-20s %5d → %-5d %s', $d, $a, $b, $b > $a ? '<error>▲</error>' : '<info>▼</info>'));
            }
        }
        $this->line("  {$diff['gone']} finding(s) gone; " . array_sum(array_map('count', $worse)) . ' new finding(s) in ' . count($worse) . ' book(s)');
        foreach (array_slice($worse, 0, 20, true) as $book => $keys) {
            $examples = array_filter($perBook[$book]['findings'], fn ($f) => in_array(ConversionLint::key($f), $keys, true));
            $this->line("  <error>NEW</error> {$book}  " . mb_substr((string) $perBook[$book]['title'], 0, 50));
            foreach (array_slice($examples, 0, 3) as $f) {
                $this->line(sprintf('       · [%s] %s', $f['detector'], mb_substr($f['excerpt'], 0, 140)));
            }
        }
    }

    private function flag(array $perBook): int
    {
        $min = (int) $this->option('min-score');
        $n = 0;
        foreach ($perBook as $book => $b) {
            if ($b['score'] < $min) {
                continue;
            }
            $summary = implode(', ', array_map(fn ($d, $c) => "{$d}×{$c}", array_keys($b['counts']), $b['counts']));
            ConversionFlag::raise($book, ConversionFlag::SOURCE_AUTO_SWEEP,
                "Conversion lint (score {$b['score']}): {$summary}",
                [
                    'issueTypes' => [self::ISSUE_TYPE],
                    'counts'     => $b['counts'],
                    'examples'   => array_slice($b['findings'], 0, 8),
                    'case_kind'  => BookExport::KIND_CONVERSION,
                    'linted_at'  => now()->toIso8601String(),
                ]);
            $n++;
        }
        $this->newLine();
        $this->line("{$n} book(s) flagged (score ≥ {$min}) → triage at /maintainer/conversion");
        $this->line('Undo with: php artisan conversion:lint --unflag');
        return self::SUCCESS;
    }
}
