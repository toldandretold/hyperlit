<?php

/**
 * Fixture-driven footnote-routing regression — the footnote analogue of the
 * paste fixtures-smoke suite and the conversion regression suite.
 *
 * Fixtures under tests/Fixtures/footnotes/ are REAL books' footnotes with
 * their CAPTURED LLM extractions (see the README there for regeneration), so
 * this suite runs the deterministic half — classification + the antecedent /
 * bibliography-pointer matchers — with no LLM in the loop. If routing logic
 * or the type taxonomy regresses, these exact baselines drift.
 *
 * Baselines (legal-pointer-style = book_1781243002465, EU copyright article):
 *   142 extracted footnotes → 126 citations
 *   93 pointers → 89 linked to the bibliography (4 ambiguous/absent: honest)
 *   16 legislation + 4 case-law (counted, excluded from external resolution)
 *   2 short-form antecedent links
 */

use App\Jobs\CitationScanBibliographyJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

const FRR_CITABLE = ['book', 'journal-article', 'book-chapter', 'conference-paper', 'thesis', 'report', 'web_page', 'chapter'];
const FRR_REFERENCE_STYLE = ['short-form', 'ibid', 'pointer', 'legislation', 'case-law'];

function frrDb()
{
    return DB::connection('pgsql_admin');
}

function frrFixture(string $name): array
{
    return json_decode(file_get_contents(dirname(__DIR__) . "/Fixtures/footnotes/{$name}.json"), true);
}

/** Seed a temp book from a fixture; returns [bookId, citationFootnoteIds]. */
function frrSeed(array $fx): array
{
    $book = 'book_canonv_frr_' . Str::random(8);
    frrDb()->table('library')->insert([
        'book' => $book, 'title' => 'FRR Test', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $markers = [];
    $citationIds = [];
    foreach ($fx['footnotes'] as $fn) {
        if ($fn['marker'] !== null) {
            $markers[] = ['id' => $fn['footnoteId'], 'marker' => (string) $fn['marker']];
        }
        $type = $fn['meta']['type'] ?? null;
        $isCitation = in_array($type, FRR_CITABLE, true) || in_array($type, FRR_REFERENCE_STYLE, true);
        if ($isCitation) {
            $citationIds[] = $fn['footnoteId'];
        }
        frrDb()->table('footnotes')->insert([
            'book' => $book, 'footnoteId' => $fn['footnoteId'],
            'content' => '<p>' . e($fn['text']) . '</p>',
            'is_citation' => $isCitation,
            'llm_metadata' => json_encode($fn['meta']),
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
    frrDb()->table('nodes')->insert([
        'book' => $book, 'node_id' => $book . '_n1', 'chunk_id' => 1, 'startLine' => 1,
        'content' => '<p>body</p>', 'plainText' => 'body', 'type' => 'p',
        'footnotes' => json_encode($markers),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    foreach ($fx['bibliography'] as $bibRow) {
        frrDb()->table('bibliography')->insert([
            'book' => $book, 'referenceId' => $bibRow['referenceId'], 'content' => 'bib',
            'llm_metadata' => json_encode($bibRow['meta']),
            'foundation_source' => $bibRow['resolved'] ? ('book_resolved_' . $bibRow['referenceId']) : null,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    return [$book, $citationIds];
}

function frrCleanup(string $book): void
{
    foreach (['footnotes', 'bibliography', 'nodes', 'library'] as $t) {
        frrDb()->table($t)->where('book', $book)->delete();
    }
}

function frrRunMatchers(string $book, array $citationIds): array
{
    $rc = new ReflectionClass(CitationScanBibliographyJob::class);
    $job = $rc->newInstanceWithoutConstructor();
    foreach (['bookId' => $book, 'sourceTable' => 'footnotes'] as $prop => $val) {
        $p = $rc->getProperty($prop);
        $p->setAccessible(true);
        $p->setValue($job, $val);
    }
    $needs = array_map(fn($id) => (object) ['referenceId' => $id], $citationIds);

    $sf = $rc->getMethod('matchShortFormAntecedents');
    $sf->setAccessible(true);
    $sf->invokeArgs($job, [frrDb(), &$needs, null]); // no LLM disambiguator: deterministic only

    $bp = $rc->getMethod('matchBibliographyPointers');
    $bp->setAccessible(true);
    $bp->invokeArgs($job, [frrDb(), &$needs]);

    $ex = $rc->getMethod('excludeLegalFromResolution');
    $ex->setAccessible(true);
    $ex->invokeArgs($job, [frrDb(), &$needs]);

    return $needs;
}

test('self-contained short-form corpus: taxonomy snapshot + the Hart bug stays dead', function () {
    $fx = frrFixture('selfcontained-shortform-style');

    $types = array_count_values(array_map(fn($f) => $f['meta']['type'] ?? 'null', $fx['footnotes']));
    expect($types['other'] ?? 0)->toBe(0);
    expect($types['archival-source'] ?? 0)->toBeGreaterThan(30); // CJ/TNA codes correctly non-citable

    // Linked short forms carry their antecedent's metadata + short_form_of.
    $linked = array_filter($fx['footnotes'], fn($f) => !empty($f['meta']['short_form_of']));
    expect(count($linked))->toBeGreaterThanOrEqual(30);

    // THE HART BUG STAYS DEAD: "Hart, Justice" must be J. S. Hart 1991 via its
    // antecedent — never H. L. A. Hart 1955 (the confabulation this system exists
    // to prevent).
    $hart = array_values(array_filter($fx['footnotes'], fn($f) => str_starts_with($f['text'], 'Hart, Justice')));
    expect($hart)->not->toBeEmpty();
    expect($hart[0]['meta']['year'])->toBe(1991);
    expect($hart[0]['meta']['short_form_of'])->not->toBeEmpty();
    foreach ($fx['footnotes'] as $f) {
        expect(($f['meta']['year'] ?? null) === 1955 && str_contains($f['text'], 'Hart'))->toBeFalse();
    }
});

test('legal-pointer-style corpus: classification + routing baselines hold', function () {
    $fx = frrFixture('legal-pointer-style');

    // Taxonomy baselines (pure fixture assertions — drift = the prompt changed
    // the captured shape, recapture deliberately)
    $types = array_count_values(array_map(fn($f) => $f['meta']['type'] ?? 'null', $fx['footnotes']));
    expect($types['pointer'] ?? 0)->toBe(93);
    expect($types['legislation'] ?? 0)->toBe(16);
    expect($types['case-law'] ?? 0)->toBe(4);
    expect($types['other'] ?? 0)->toBe(0); // the black hole stays closed

    [$book, $citationIds] = frrSeed($fx);
    try {
        expect(count($citationIds))->toBe(126); // citations of 142

        $needs = frrRunMatchers($book, $citationIds);

        $pointerLinks = frrDb()->table('footnotes')->where('book', $book)
            ->where('match_method', 'bibliography_pointer')->count();
        expect($pointerLinks)->toBe(89);

        // Short-form links were made at live-scan time; the fixture is captured
        // POST-link (substituted metadata carries short_form_of), so a re-run
        // creates no NEW links — the captured state itself is the baseline.
        $capturedShortFormLinks = count(array_filter($fx['footnotes'], fn($f) => !empty($f['meta']['short_form_of'])));
        expect($capturedShortFormLinks)->toBe(2);

        // Nothing reference-style may remain in external resolution:
        // pointers/legal/short-form resolving alone is the mis-match path.
        $metaById = [];
        foreach ($fx['footnotes'] as $f) {
            $metaById[$f['footnoteId']] = $f['meta']['type'] ?? null;
        }
        foreach ($needs as $entry) {
            $type = $metaById[$entry->referenceId] ?? null;
            expect(in_array($type, ['legislation', 'case-law'], true))->toBeFalse(
                "legal citation {$entry->referenceId} must not reach external resolution"
            );
        }
    } finally {
        frrCleanup($book);
    }
});
