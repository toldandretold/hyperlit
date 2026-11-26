<?php

namespace App\Http\Controllers\Maintainer\Concerns;

use App\Console\Commands\BookExport;
use App\Models\ConversionFlag;
use App\Services\Conversion\ConversionLint;
use App\Services\Conversion\ConversionLintReport;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;

/**
 * The conversion-lint endpoints of an import console — "search this journal / shelf for problems"
 * and the before/after around a reconvert — written against an ImportConsoleScope so both
 * consoles serve them from one implementation.
 *
 * Used alongside BuildsImportLanes, which supplies `consoleScope()` and `scopeNotFound()`. The
 * first route parameter is the scope key (a journal slug or a shelf uuid).
 */
trait ServesConversionLint
{
    /** The reason on a flag opened by confirming a lint finding (and nothing else). */
    private const LINT_FLAG_REASON = 'Confirmed conversion-lint finding';

    /**
     * GET …/{key}/lint — "search this scope for problems".
     *
     * Every lane with content, ranked by the structural defects its stored nodes show
     * (ConversionLint), plus the before/after against the scope's snapshot when one was taken.
     * Separate from /articles on purpose: that payload is what the page needs to draw at all,
     * and this one can be slow the first time (a cold corpus is computed across several
     * requests — `pending` says how many lanes are still to do, and the page asks again).
     */
    public function lint(Request $request, string $key, ConversionLintReport $report)
    {
        $scope = $this->consoleScope($key);
        if (! $scope) {
            return $this->scopeNotFound();
        }

        $books = $scope->lintableBooks();
        $result = $report->forBooks($books);
        $compare = $result['pending'] === 0
            ? $report->compareWithSnapshot($scope->id, $books, $result)
            : null;

        $payload = [];
        foreach ($result['books'] as $book => $b) {
            $newKeys = array_flip($compare['new'][$book] ?? []);
            $findings = array_map(
                fn ($f) => $f + ['is_new' => isset($newKeys[$f['key']])],
                $b['findings'],
            );
            // New findings first: with the list capped, the ones a reconvert INTRODUCED are the
            // ones that must never be cut off.
            usort($findings, fn ($x, $y) => $y['is_new'] <=> $x['is_new']);
            $payload[$book] = [
                'score'          => $b['score'],
                'counts'         => $b['counts'],
                'findings'       => array_slice($findings, 0, ConversionLintReport::FINDINGS_CAP),
                'findings_total' => count($findings),
                'new'            => count($newKeys),
                'confirmed'      => count(array_filter($findings, fn ($f) => $f['confirmed'])),
                // Judged false alarms: out of every count above, kept so the verdict can be undone.
                'dismissed'      => array_slice($b['dismissed'], 0, ConversionLintReport::FINDINGS_CAP),
            ];
        }

        if ($compare) {
            // Per-book keys were only needed to mark the findings above.
            $compare['new_books'] = count($compare['new']);
            unset($compare['new']);
        }

        return response()->json([
            'pending' => $result['pending'],
            'total'   => count($books),
            'books'   => (object) $payload,
            'compare' => $compare,
            // Any verdict at all makes the cases download worth offering.
            'reviewed' => count($report->reviewRows(array_keys($books))),
        ]);
    }

    /**
     * POST …/{key}/lint/review — a human's verdict on one finding.
     *
     * `source` says the SOURCE is wrong here: the finding stays listed, marked as the source's,
     * and stops counting towards the lane's score.
     * `false_alarm` takes it out of the lane's count for good (keyed by detector + excerpt, so it
     * stays dismissed across reconverts). `real` confirms it AND writes it into the lane's
     * maintainer note — the note already opens a case and already rides the case bundle, so a
     * confirmed finding reaches whoever fixes the converter by the road that exists. A null
     * verdict withdraws either.
     */
    public function lintReview(Request $request, string $key, ConversionLintReport $report)
    {
        $scope = $this->consoleScope($key);
        if (! $scope) {
            return $this->scopeNotFound();
        }
        $data = $request->validate([
            'book'      => 'required|string|max:255',
            'detector'  => 'required|string|max:40|regex:/^[a-z_]+$/',
            'excerpt'   => 'required|string|max:400',
            'startLine' => 'nullable|string|max:40',
            'verdict'   => 'present|nullable|in:' . implode(',', ConversionLintReport::VERDICTS),
        ]);
        if (! array_key_exists($data['book'], $scope->lintableBooks())) {
            return response()->json(['message' => "That book is not a lane of this {$scope->noun()}."], 404);
        }

        $finding = ['detector' => $data['detector'], 'excerpt' => $data['excerpt'],
                    'startLine' => (string) ($data['startLine'] ?? '')];
        $report->review($data['book'], $finding, $data['verdict'], $request->user()?->name);
        $this->syncConfirmedFindingNote(
            $data['book'], $finding, $data['verdict'] === ConversionLintReport::VERDICT_REAL, $request->user()?->name);

        return response()->json(['ok' => true, 'key' => ConversionLint::key($finding)]);
    }

    /**
     * GET …/{key}/lint/cases — the cases worth taking to a dev machine.
     *
     * NOT every lane with a confirmed problem: a converter fix is per KIND of defect, and a bundle
     * is the whole PDF plus its OCR, so a corpus's worth would be hundreds of megabytes of the
     * same bug. One example lane per confirmed kind — the lane with the most confirmed findings of
     * that kind — plus `lint-review.json`, which lists EVERY verdict (the confirmed ones the fix
     * should clear, and the false alarms, which are evidence for tightening a detector).
     * One outer tar of ordinary book:export bundles; `book:import-cases --downloads` unpacks it.
     */
    public function lintCases(Request $request, string $key, ConversionLintReport $report)
    {
        $scope = $this->consoleScope($key);
        if (! $scope) {
            return $this->scopeNotFound();
        }

        $books = $scope->lintableBooks();
        $rows = $report->reviewRows(array_keys($books));
        $sample = $request->boolean('sample');
        if ($rows === [] && ! $sample) {
            return response()->json(['message' => 'Nothing reviewed yet — confirm or dismiss a problem first.'], 422);
        }

        // detector => book => confirmed count; the busiest lane is that kind's example.
        $tally = [];
        foreach ($rows as $row) {
            if ($row['verdict'] === ConversionLintReport::VERDICT_REAL) {
                $tally[$row['detector']][$row['book']] = ($tally[$row['detector']][$row['book']] ?? 0) + 1;
            }
        }
        $examples = [];   // book => kinds it stands for
        foreach ($tally as $detector => $perBook) {
            arsort($perBook);
            // Prefer a lane already chosen for another kind when it ties for the lead — fewer bundles.
            $best = array_key_first($perBook);
            foreach ($perBook as $book => $n) {
                if ($n === $perBook[$best] && isset($examples[$book])) {
                    $best = $book;
                    break;
                }
            }
            $examples[$best][] = $detector;
        }

        // ?sample=1 — nobody has reviewed anything (or not every kind): take examples straight
        // from the lint. One lane per kind, and for a kind the last reconvert made WORSE the two
        // lanes with the most NEW findings of it, because those are the regression to diagnose.
        $sampled = [];
        $sampledFindings = [];
        if ($sample) {
            $result = $report->forBooks($books);
            if ($result['pending'] > 0) {
                return response()->json(['message' => "Still checking this {$scope->noun()} for problems — try again in a moment."], 409);
            }
            $compare = $report->compareWithSnapshot($scope->id, $books, $result);
            $perKind = [];   // detector => book => [new, all]
            foreach ($result['books'] as $book => $b) {
                $newKeys = array_flip($compare['new'][$book] ?? []);
                foreach ($b['findings'] as $f) {
                    $perKind[$f['detector']][$book] ??= [0, 0];
                    $perKind[$f['detector']][$book][0] += isset($newKeys[$f['key']]) ? 1 : 0;
                    $perKind[$f['detector']][$book][1] += 1;
                }
            }
            foreach ($perKind as $detector => $perBook) {
                uasort($perBook, fn ($x, $y) => [$y[0], $y[1]] <=> [$x[0], $x[1]]);
                $top = array_key_first($perBook);
                $take = $perBook[$top][0] > 0
                    ? array_keys(array_filter(array_slice($perBook, 0, 2, true), fn ($n) => $n[0] > 0))
                    : [$top];
                foreach ($take as $book) {
                    $sampled[$book][] = $detector;
                }
            }
            foreach ($sampled as $book => $kinds) {
                $newKeys = array_flip($compare['new'][$book] ?? []);
                foreach ($result['books'][$book]['findings'] as $f) {
                    if (in_array($f['detector'], $kinds, true)) {
                        $sampledFindings[] = ['book' => $book, 'detector' => $f['detector'],
                            'startLine' => $f['startLine'], 'excerpt' => $f['excerpt'],
                            'is_new' => isset($newKeys[$f['key']])];
                    }
                }
            }
        }

        $dir = storage_path('app/book-exports/lint-cases-' . Str::random(12));
        File::ensureDirectoryExists($dir);
        $members = ['lint-review.json'];
        $failed = [];
        foreach (array_unique(array_merge(array_keys($examples), array_keys($sampled))) as $book) {
            $out = "{$dir}/{$book}.tar.gz";
            $exit = Artisan::call('book:export', [
                'book' => $book, '--out' => $out, '--origin' => $scope->origin(),
                // A lint finding is about what the CONVERTER did with a fetch that was fine.
                // Left to auto-detect, every harvested article exports as a `harvest`
                // (acquisition) case: import-cases then prints "the fetch was wrong", captures
                // no regression fixture, and reconvert-queue suggests retracting the book.
                '--kind' => BookExport::KIND_CONVERSION,
            ]);
            if ($exit === 0 && is_file($out)) {
                $members[] = "{$book}.tar.gz";
            } else {
                $failed[] = $book;
            }
        }

        $verdict = fn (string $v) => array_values(array_map(
            fn ($r) => ['book' => $r['book'], 'detector' => $r['detector'], 'startLine' => $r['start_line'], 'excerpt' => $r['excerpt']],
            array_filter($rows, fn ($r) => $r['verdict'] === $v)));
        file_put_contents("{$dir}/lint-review.json", json_encode([
            // `journal` is the key the file has always carried; for a shelf it holds the shelf's
            // name, and `scope` says which of the two it is.
            'journal'       => $scope->label,
            'slug'          => $scope->slug,
            'scope'         => $scope->kind,
            'exported_at'   => now()->toIso8601String(),
            'lint_version'  => ConversionLint::VERSION,
            'examples'      => $examples,
            // Unreviewed lanes picked by the lint itself (?sample=1) and what it found in them.
            'sampled'          => $sampled,
            'sampled_findings' => $sampledFindings,
            'export_failed' => $failed,
            'confirmed'     => $verdict(ConversionLintReport::VERDICT_REAL),
            'false_alarms'  => $verdict(ConversionLintReport::VERDICT_FALSE_ALARM),
            // Real and visible, but the source's own error — nothing here for a converter fix.
            'source_faults' => $verdict(ConversionLintReport::VERDICT_SOURCE),
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));

        $outer = "{$dir}.tar";
        $tar = new Process(array_merge(['tar', '-cf', $outer, '-C', $dir], $members));
        $tar->run();
        File::deleteDirectory($dir);
        if (! $tar->isSuccessful() || ! is_file($outer)) {
            return response()->json(['message' => 'Could not build the cases archive — see logs.'], 500);
        }

        return response()->download($outer, "lint-cases-{$scope->slug}.tar")->deleteFileAfterSend(true);
    }

    /**
     * POST …/{key}/lint/snapshot — freeze "before".
     *
     * Refused while the scope is not in a state worth freezing: lanes still to lint (the
     * snapshot would be partial), or conversions still queued (a reconvert_all clears each book at
     * enqueue, so a mid-drain snapshot records gutted books as clean and every later comparison
     * reads as a regression).
     */
    public function lintSnapshot(Request $request, string $key, ConversionLintReport $report)
    {
        $scope = $this->consoleScope($key);
        if (! $scope) {
            return $this->scopeNotFound();
        }

        if (($queued = $scope->pendingConversionJobs()) > 0) {
            return response()->json([
                'message' => "{$queued} conversion(s) are still queued for this {$scope->noun()} — snapshot once they have run.",
            ], 409);
        }

        $books = $scope->lintableBooks();
        $result = $report->forBooks($books);
        if ($result['pending'] > 0) {
            return response()->json([
                'message' => "{$result['pending']} lane(s) are still being checked — try again in a moment.",
                'pending' => $result['pending'],
            ], 409);
        }

        return response()->json([
            'snapshot' => $report->saveSnapshot($scope->id, $books, $result, $request->user()?->name),
        ]);
    }

    /** DELETE …/{key}/lint/snapshot — stop comparing. */
    public function lintSnapshotDelete(Request $request, string $key, ConversionLintReport $report)
    {
        $scope = $this->consoleScope($key);
        if (! $scope) {
            return $this->scopeNotFound();
        }
        $report->deleteSnapshot($scope->id);

        return response()->json(['ok' => true]);
    }

    /**
     * Keep the lane's maintainer note in step with its confirmed findings: one line per finding,
     * tagged with the finding's key so the same line can be found and removed again. Opens a
     * `manual` flag when the lane has none (as MaintainerController::note does — a confirmed
     * problem with no case is a problem nobody will pick up), and closes that flag again if
     * un-confirming leaves it with nothing to say.
     */
    private function syncConfirmedFindingNote(string $book, array $finding, bool $confirmed, ?string $by): void
    {
        $key = ConversionLint::key($finding);
        $flags = ConversionFlag::where('book', $book)->where('status', 'open')->get();
        if ($flags->isEmpty()) {
            if (! $confirmed) {
                return;
            }
            $flags = collect([ConversionFlag::create([
                'book'    => $book,
                'source'  => ConversionFlag::SOURCE_MANUAL,
                'reason'  => self::LINT_FLAG_REASON,
                'status'  => 'open',
                'details' => [],
            ])]);
        }

        $where = $finding['startLine'] !== '' ? " (node {$finding['startLine']})" : '';
        $line = "✓ [{$key}]{$where} " . Str::limit(preg_replace('/\s+/u', ' ', $finding['excerpt']), 170);

        foreach ($flags as $flag) {
            $details = $flag->details ?? [];
            $lines = array_values(array_filter(
                preg_split('/\R/u', (string) ($details['maintainer_note'] ?? '')),
                fn ($l) => ! str_contains($l, "[{$key}]"),
            ));
            if ($confirmed) {
                $lines[] = $line;
            }
            $note = trim(implode("\n", $lines));

            if ($note === '') {
                if ($flag->reason === self::LINT_FLAG_REASON && $flag->source === ConversionFlag::SOURCE_MANUAL) {
                    $flag->delete();     // we opened it for this, and nothing is left of it
                    continue;
                }
                unset($details['maintainer_note'], $details['noted_by'], $details['noted_at']);
            } else {
                $details['maintainer_note'] = Str::limit($note, 3990, '');
                $details['noted_by'] = $by;
                $details['noted_at'] = now()->toIso8601String();
            }
            $flag->details = $details;
            $flag->save();
        }
    }
}
