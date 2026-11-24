<?php

namespace App\Services\Conversion;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * The conversion lint for a SET of books, served from storage — what /maintainer/journal-import
 * shows beside each lane, and the before/after comparison around a corpus reconvert.
 *
 * ConversionLint is the pure detector; this is the part that makes it affordable on a page load.
 * A book's lint is stored in `conversion_lint_results` against the content clock it was computed
 * at (`library.timestamp`, which every reconvert bumps) and recomputed only when that moves — so
 * ranking a 960-article journal is one query, and after a reconvert_all only the books that have
 * actually drained are re-read.
 *
 * Two things here are easy to get wrong:
 *
 *  - Computing is BUDGETED, not all-or-nothing. A cold journal is ~1000 books of nodes; doing that
 *    in one request would outlive the web server's timeout. `forBooks` computes until the budget
 *    is spent, reports how many are still `pending`, and the page simply asks again.
 *
 *  - Page-furniture leaks are a property of the JOURNAL, not the book (a string is chrome because
 *    it recurs across articles), so they are decided at read time from every book's stored
 *    candidates and only once nothing is pending — a verdict from half a journal would flicker.
 *
 * Operator-only tables, read and written through pgsql_admin.
 */
class ConversionLintReport
{
    /** Findings sent to the page per book; the counts always describe all of them. */
    public const FINDINGS_CAP = 60;

    public const VERDICT_REAL = 'real';
    public const VERDICT_FALSE_ALARM = 'false_alarm';

    public function __construct(private ConversionLint $lint)
    {
    }

    /**
     * @param array<string, int> $books book => library.timestamp, for every book with content
     * Reviewed findings are applied here, so every consumer (the page, a snapshot, a comparison)
     * sees the same thing: a finding judged a FALSE ALARM is moved out of `findings` into
     * `dismissed` and no longer counts; one judged REAL stays and carries `confirmed`.
     *
     * @return array{pending: int, books: array<string, array{score: int, counts: array<string, int>,
     *               findings: list<array{detector: string, startLine: string, excerpt: string, key: string, confirmed: bool}>,
     *               dismissed: list<array{detector: string, startLine: string, excerpt: string, key: string}>}>}
     */
    public function forBooks(array $books, float $budgetSeconds = 6.0): array
    {
        $db = DB::connection('pgsql_admin');
        $deadline = microtime(true) + $budgetSeconds;

        $stored = [];
        foreach (array_chunk(array_keys($books), 500) as $chunk) {
            $rows = $db->table('conversion_lint_results')->whereIn('book', $chunk)
                ->where('lint_version', ConversionLint::VERSION)
                ->get(['book', 'library_timestamp', 'findings']);
            foreach ($rows as $row) {
                if ((int) $row->library_timestamp === (int) $books[$row->book]) {
                    $stored[$row->book] = json_decode((string) $row->findings, true) ?: [];
                }
            }
        }

        $pending = 0;
        foreach ($books as $book => $timestamp) {
            if (isset($stored[$book])) {
                continue;
            }
            if (microtime(true) > $deadline) {
                $pending++;
                continue;
            }
            // No nodes = a book cleared by a queued reconvert (the clear leaves `has_nodes` and the
            // content clock alone). Nothing to lint and nothing to store: left out, it reads as
            // "still converting" rather than as a book whose every problem was fixed.
            $computed = $this->compute($db, (string) $book, (int) $timestamp);
            if ($computed !== null) {
                $stored[$book] = $computed;
            }
        }

        $leaks = $pending === 0 ? $this->chromeLeaks($db, $books) : [];

        $reviews = $this->reviews(array_keys($stored));

        $out = [];
        foreach ($stored as $book => $findings) {
            foreach ($leaks[$book] ?? [] as $leak) {
                $findings[] = ['detector' => 'chrome_leak', 'startLine' => '', 'excerpt' => $leak];
            }
            $kept = [];
            $dismissed = [];
            foreach ($findings as $f) {
                $f['key'] = ConversionLint::key($f);
                $verdict = $reviews[$book][$f['key']] ?? null;
                if ($verdict === self::VERDICT_FALSE_ALARM) {
                    $dismissed[] = $f;
                    continue;
                }
                $f['confirmed'] = $verdict === self::VERDICT_REAL;
                $kept[] = $f;
            }
            $counts = array_count_values(array_column($kept, 'detector'));
            $out[$book] = ['score' => ConversionLint::score($counts), 'counts' => $counts,
                           'findings' => $kept, 'dismissed' => $dismissed];
        }

        return ['pending' => $pending, 'books' => $out];
    }

    /** Freeze the current findings as the "before" of a later comparison. */
    public function saveSnapshot(string $journalId, array $books, array $report, ?string $by): array
    {
        $payload = [];
        foreach ($report['books'] as $book => $b) {
            $payload[$book] = [
                'timestamp' => (int) ($books[$book] ?? 0),
                'counts'    => $b['counts'],
                'keys'      => array_values(array_unique(array_column($b['findings'], 'key'))),
            ];
        }
        $row = ['taken_by' => $by, 'taken_at' => now(), 'books' => json_encode($payload)];
        DB::connection('pgsql_admin')->table('conversion_lint_snapshots')
            ->updateOrInsert(['journal_source_id' => $journalId], $row);

        return ['taken_at' => $row['taken_at']->toIso8601String(), 'taken_by' => $by, 'books' => count($payload)];
    }

    public function deleteSnapshot(string $journalId): void
    {
        DB::connection('pgsql_admin')->table('conversion_lint_snapshots')
            ->where('journal_source_id', $journalId)->delete();
    }

    /**
     * The journal's snapshot against the current report, or null when none was taken.
     *
     * `waiting` is the number that keeps the comparison honest mid-drain: a reconvert_all clears
     * every book at ENQUEUE, so a queued book has no content and therefore no findings — counting
     * it would report every one of its problems as fixed. Those books are left out until they are
     * back. `changed` is how many books' content clock has moved since the snapshot, i.e. how much
     * of the journal the comparison is actually about.
     *
     * @param array<string, int> $books book => library.timestamp (books with content only)
     * @return array<string, mixed>|null
     */
    public function compareWithSnapshot(string $journalId, array $books, array $report): ?array
    {
        $row = DB::connection('pgsql_admin')->table('conversion_lint_snapshots')
            ->where('journal_source_id', $journalId)->first();
        if (! $row) {
            return null;
        }
        $before = json_decode((string) $row->books, true) ?: [];

        // A finding dismissed AFTER the snapshot was taken is still in the snapshot. Left there it
        // would read as "gone" — a problem the reconvert fixed — when all that happened is that a
        // human called it a false alarm. Take it out of the "before" side as well.
        foreach ($this->reviews(array_keys($before), self::VERDICT_FALSE_ALARM) as $book => $keys) {
            foreach (array_intersect($before[$book]['keys'] ?? [], array_keys($keys)) as $key) {
                $detector = explode(':', $key, 2)[0];
                if (($before[$book]['counts'][$detector] ?? 0) > 0) {
                    $before[$book]['counts'][$detector]--;
                }
            }
            $before[$book]['keys'] = array_values(array_diff($before[$book]['keys'] ?? [], array_keys($keys)));
            $before[$book]['counts'] = array_filter($before[$book]['counts'] ?? []);
        }

        $waiting = 0;
        $changed = 0;
        foreach ($before as $book => $b) {
            if (! isset($report['books'][$book])) {
                $waiting++;
            } elseif ((int) ($books[$book] ?? 0) !== (int) ($b['timestamp'] ?? 0)) {
                $changed++;
            }
        }

        $now = [];
        foreach ($report['books'] as $book => $b) {
            $now[$book] = ['counts' => $b['counts'], 'keys' => array_column($b['findings'], 'key')];
        }
        $diff = ConversionLint::compare($before, $now);

        return [
            'taken_at'  => \Illuminate\Support\Carbon::parse($row->taken_at)->toIso8601String(),
            'taken_by'  => $row->taken_by,
            'books'     => count($before),
            'compared'  => $diff['compared'],
            'changed'   => $changed,
            'waiting'   => $waiting,
            'detectors' => $diff['detectors'],
            'gone'      => $diff['gone'],
            'new'       => $diff['new'],
            'new_total' => array_sum(array_map('count', $diff['new'])),
        ];
    }

    /**
     * Record (or, with a null verdict, withdraw) a human's verdict on one finding.
     *
     * @param array{detector: string, startLine?: string, excerpt: string} $finding
     */
    public function review(string $book, array $finding, ?string $verdict, ?string $by): void
    {
        $table = DB::connection('pgsql_admin')->table('conversion_lint_reviews');
        $key = ConversionLint::key($finding);
        if ($verdict === null) {
            $table->where('book', $book)->where('key', $key)->delete();

            return;
        }
        $table->updateOrInsert(['book' => $book, 'key' => $key], [
            'verdict'     => $verdict,
            'detector'    => $finding['detector'],
            'excerpt'     => $finding['excerpt'],
            'start_line'  => ($finding['startLine'] ?? '') !== '' ? (string) $finding['startLine'] : null,
            'reviewed_by' => $by,
            'reviewed_at' => now(),
        ]);
    }

    /**
     * Every verdict recorded for these books, whether or not the finding still exists — the
     * dismissed ones are evidence about a DETECTOR, and stay useful after the text has moved on.
     *
     * @return list<array{book: string, key: string, verdict: string, detector: string, excerpt: string, start_line: ?string}>
     */
    public function reviewRows(array $books): array
    {
        $out = [];
        foreach (array_chunk($books, 500) as $chunk) {
            $rows = DB::connection('pgsql_admin')->table('conversion_lint_reviews')->whereIn('book', $chunk)
                ->orderBy('reviewed_at')->get(['book', 'key', 'verdict', 'detector', 'excerpt', 'start_line']);
            foreach ($rows as $row) {
                $out[] = (array) $row;
            }
        }

        return $out;
    }

    /** @return array<string, array<string, string>> book => key => verdict */
    private function reviews(array $books, ?string $verdict = null): array
    {
        $out = [];
        foreach ($this->reviewRows($books) as $row) {
            if ($verdict === null || $row['verdict'] === $verdict) {
                $out[$row['book']][$row['key']] = $row['verdict'];
            }
        }

        return $out;
    }

    private function compute($db, string $book, int $timestamp): ?array
    {
        $nodes = $db->table('nodes')->where('book', $book)->orderBy('startLine')
            ->get(['startLine', 'content'])
            ->map(fn ($n) => ['startLine' => (string) $n->startLine, 'content' => (string) $n->content])
            ->all();
        if ($nodes === []) {
            return null;
        }
        $footnotes = $db->table('footnotes')->where('book', $book)
            ->pluck('content', 'footnoteId')->map(fn ($c) => (string) $c)->all();

        $result = $this->lint->lintBook($nodes, $footnotes, ConversionLint::evidenceFor($book));
        $counts = array_count_values(array_column($result['findings'], 'detector'));

        $db->table('conversion_lint_results')->upsert([[
            'book'              => $book,
            'library_timestamp' => $timestamp,
            'lint_version'      => ConversionLint::VERSION,
            'score'             => ConversionLint::score($counts),
            'findings'          => json_encode($result['findings'], JSON_INVALID_UTF8_SUBSTITUTE),
            'chrome'            => json_encode(
                (object) array_count_values($result['chrome_candidates']), JSON_INVALID_UTF8_SUBSTITUTE),
            'computed_at'       => now(),
        ]], ['book'], ['library_timestamp', 'lint_version', 'score', 'findings', 'chrome', 'computed_at']);

        return $result['findings'];
    }

    /**
     * Which stored candidates are page furniture across this set of books. Cached against the
     * set's content clocks, because deciding it means loading every book's candidate list — fine
     * once per corpus change, wasteful on every poll.
     *
     * @return array<string, list<string>> book => leaked strings
     */
    private function chromeLeaks($db, array $books): array
    {
        ksort($books);
        $signature = sha1(ConversionLint::VERSION . '|' . json_encode($books));

        return Cache::remember("conversion-lint:chrome:{$signature}", now()->addDays(14), function () use ($db, $books) {
            $counts = [];
            foreach (array_chunk(array_keys($books), 200) as $chunk) {
                foreach ($db->table('conversion_lint_results')->whereIn('book', $chunk)->get(['book', 'chrome']) as $row) {
                    $counts[$row->book] = json_decode((string) $row->chrome, true) ?: [];
                }
            }
            return $this->lint->chromeLeaksFromCounts($counts);
        });
    }
}
