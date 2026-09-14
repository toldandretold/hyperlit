<?php

/**
 * Carrying citation resolution across a reconvert — App\Services\Citations\ResolutionSnapshotService.
 *
 * THE COST THIS REMOVES: `BookContentClearer` deletes a book's `bibliography` and `footnotes`, and
 * the import job re-inserts them from the conversion artifacts with every resolution column NULL.
 * So a `⟲ reconvert all` over a journal made the next hypercite detect re-buy the whole bibliography
 * scan — an LLM extraction per reference plus the OpenAlex/Crossref waves, minutes per article — to
 * re-derive answers the reconvert never invalidated, only deleted. A reference resolves on the
 * strength of its own text, which is exactly what a converter change does not alter.
 *
 * The tests below simulate a reconvert the way the real one runs: snapshot → clear → re-insert bare
 * rows → restore.
 */

use App\Services\Citations\ResolutionSnapshotService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

function resDb()
{
    return DB::connection('pgsql_admin');
}

function resBook(): string
{
    return 'book_ressnap_' . Str::random(8);
}

function resCleanup(string $book): void
{
    resDb()->table('bibliography')->where('book', $book)->delete();
    resDb()->table('footnotes')->where('book', $book)->delete();
    File::deleteDirectory(resource_path("markdown/{$book}"));
}

/** Insert a bibliography row; pass only what the test cares about. */
function resBib(string $book, string $refId, array $cols = []): void
{
    resDb()->table('bibliography')->insert(array_merge([
        'book'        => $book,
        'referenceId' => $refId,
        'content'     => '<p>Generic reference text.</p>',
        'created_at'  => now(),
        'updated_at'  => now(),
    ], $cols));
}

/** Re-insert the row the way ProcessDocumentImportJob::saveReferencesToDatabase does: bare. */
function resReconvertBibliography(string $book, array $entries): void
{
    resDb()->table('bibliography')->where('book', $book)->delete();
    foreach ($entries as $refId => $cols) {
        resBib($book, $refId, $cols);
    }
}

// ── The round trip ──

test('a resolved bibliography survives the clear-and-reinsert a reconvert performs', function () {
    $book = resBook();
    $canonical = (string) Str::uuid();

    resBib($book, 'amin1982', [
        'content'                => '<p><a class="bib-entry" id="amin1982"></a>Amin, S. (1982). After the New International Economic Order.</p>',
        'canonical_source_id'    => $canonical,
        'source_id'              => 'book_stub_amin',
        'foundation_source'      => 'book_stub_amin',
        'match_method'           => 'library',
        'match_score'            => 0.93,
        'llm_metadata'           => json_encode(['type' => 'book', 'title' => 'After the NIEO']),
        'reference_match_method' => 'doi',
    ]);
    // "We looked and found nothing" is a RESULT. Dropping it re-buys the search that produced it —
    // and it is what keeps CandidateDetector::needsBibliographyScan from firing again.
    resBib($book, 'unknown1999', ['match_method' => 'no_match']);

    $svc = app(ResolutionSnapshotService::class);
    expect($svc->snapshot($book, resDb()))->toBeTrue();

    resReconvertBibliography($book, [
        'amin1982'    => ['content' => '<p><a class="bib-entry" id="amin1982"></a>Amin, S. (1982). After the New International Economic Order.</p>'],
        'unknown1999' => [],
    ]);
    // Precondition: the reconvert really did strip it.
    expect(resDb()->table('bibliography')->where('book', $book)->where('referenceId', 'amin1982')->value('canonical_source_id'))->toBeNull();

    $report = $svc->restore($book);
    expect($report['bibliography']['restored'])->toBe(2);
    expect($report['bibliography']['by_key'])->toBe(2);
    expect($report['bibliography']['unmatched'])->toBe(0);

    $row = resDb()->table('bibliography')->where('book', $book)->where('referenceId', 'amin1982')->first();
    expect($row->canonical_source_id)->toBe($canonical);
    expect($row->foundation_source)->toBe('book_stub_amin');
    expect($row->match_method)->toBe('library');
    expect((float) $row->match_score)->toBe(0.93);
    expect($row->reference_match_method)->toBe('doi');
    expect(json_decode((string) $row->llm_metadata, true)['title'])->toBe('After the NIEO');

    expect(resDb()->table('bibliography')->where('book', $book)->where('referenceId', 'unknown1999')->value('match_method'))
        ->toBe('no_match');

    // The payoff, stated as the predicate CandidateDetector::needsBibliographyScan actually runs:
    // no entry is left "never attempted", so the next detect skips the scan entirely.
    $unattempted = resDb()->table('bibliography')->where('book', $book)
        ->whereNull('match_method')->whereNull('canonical_source_id')
        ->whereNull('source_id')->whereNull('foundation_source')
        ->exists();
    expect($unattempted)->toBeFalse();

    resCleanup($book);
});

test('an entry whose key drifted is re-matched on its normalized text', function () {
    $book = resBook();
    $content = '<p><a class="bib-entry" id="cox1979"></a>Cox, R. W. (1979). Ideologies and the New International Economic Order.</p>';

    resBib($book, 'cox1979', [
        'content'           => $content,
        'foundation_source' => 'book_stub_cox',
        'match_method'      => 'library',
    ]);

    $svc = app(ResolutionSnapshotService::class);
    $svc->snapshot($book, resDb());

    // A reconvert that splits a glued blob shifts the a/b/c collision suffixes, so the SAME entry
    // comes back under a different key. The key pass misses it; the text pass must not.
    resReconvertBibliography($book, [
        'cox1979a' => ['content' => str_replace('id="cox1979"', 'id="cox1979a"', $content)],
    ]);

    $report = $svc->restore($book);
    expect($report['bibliography']['by_key'])->toBe(0);
    expect($report['bibliography']['by_text'])->toBe(1);
    expect(resDb()->table('bibliography')->where('book', $book)->where('referenceId', 'cox1979a')->value('foundation_source'))
        ->toBe('book_stub_cox');

    resCleanup($book);
});

test('a column the new conversion already filled is never overwritten by the snapshot', function () {
    $book = resBook();
    resBib($book, 'r1', ['source_id' => 'book_old_stub', 'match_method' => 'library']);

    $svc = app(ResolutionSnapshotService::class);
    $svc->snapshot($book, resDb());

    // references.json can carry its own source_id, and it is the fresher fact — the snapshot is
    // filling gaps, not asserting authority over this conversion's output.
    resReconvertBibliography($book, ['r1' => ['source_id' => 'book_new_stub']]);
    $svc->restore($book);

    $row = resDb()->table('bibliography')->where('book', $book)->where('referenceId', 'r1')->first();
    expect($row->source_id)->toBe('book_new_stub');
    expect($row->match_method)->toBe('library');   // the gap IS filled

    resCleanup($book);
});

// ── Footnotes: the dead-end this closes ──

test('footnote classification survives, which is what keeps a footnote-only book detectable', function () {
    $book = resBook();
    resDb()->table('footnotes')->insert([
        'book' => $book, 'footnoteId' => '1', 'content' => 'Cox 1979, p. 12.',
        'is_citation' => true, 'foundation_source' => 'book_stub_cox', 'match_method' => 'library',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    // A classified NON-citation. Nothing to carry: `is_citation` is NOT NULL DEFAULT false, so the
    // re-inserted row already says false — and a reverse carry would let stale data un-classify
    // something a new conversion had established.
    resDb()->table('footnotes')->insert([
        'book' => $book, 'footnoteId' => '2', 'content' => 'See the appendix.',
        'is_citation' => false,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $svc = app(ResolutionSnapshotService::class);
    expect($svc->snapshot($book, resDb()))->toBeTrue();

    resDb()->table('footnotes')->where('book', $book)->delete();
    foreach ([['1', 'Cox 1979, p. 12.'], ['2', 'See the appendix.']] as [$id, $text]) {
        resDb()->table('footnotes')->insert([
            'book' => $book, 'footnoteId' => $id, 'content' => $text,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    $svc->restore($book);

    $one = resDb()->table('footnotes')->where('book', $book)->where('footnoteId', '1')->first();
    // `is_citation` cannot use the gap-fill rule — NOT NULL DEFAULT false means the fresh row reads
    // false, not "unset", so a null test would never fire and the classification would be lost.
    expect((bool) $one->is_citation)->toBeTrue();
    // Without this column the detector's refId → held-work map comes back EMPTY for a footnote-only
    // book — and `citation_scans` survives the clear, so its one-scan-ever budget is already spent
    // and no later detect can rebuild it. That is the dead-end this carry closes.
    expect($one->foundation_source)->toBe('book_stub_cox');
    expect((bool) resDb()->table('footnotes')->where('book', $book)->where('footnoteId', '2')->value('is_citation'))
        ->toBeFalse();

    resCleanup($book);
});

// ── No-ops, which is most of the time ──

test('a book with nothing resolved writes no snapshot, and a fresh import restores nothing', function () {
    $book = resBook();
    resBib($book, 'r1');   // never attempted — nothing to carry

    $svc = app(ResolutionSnapshotService::class);
    expect($svc->snapshot($book, resDb()))->toBeFalse();
    expect(ResolutionSnapshotService::pathFor($book))->toBeNull();
    expect($svc->restore($book))->toBe(['skipped' => 'no snapshot']);

    resCleanup($book);
});

test('a consumed snapshot is retired, so a re-run of the import cannot replay stale resolution', function () {
    $book = resBook();
    resBib($book, 'r1', ['match_method' => 'library', 'foundation_source' => 'book_stub']);

    $svc = app(ResolutionSnapshotService::class);
    $svc->snapshot($book, resDb());
    resReconvertBibliography($book, ['r1' => []]);

    expect($svc->restore($book)['bibliography']['restored'])->toBe(1);

    // Renamed rather than deleted — the same contract as the annotation snapshot, so a better
    // matcher can still be pointed at the material later.
    expect(ResolutionSnapshotService::pathFor($book))->toBeNull();
    expect(File::exists(resource_path("markdown/{$book}/citation_resolution_snapshot.used.json")))->toBeTrue();
    expect($svc->restore($book))->toBe(['skipped' => 'no snapshot']);

    resCleanup($book);
});
