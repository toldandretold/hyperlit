<?php

/**
 * Bibliography-pointer footnotes — the third citation style: the book has a
 * bibliography AND footnotes that are author-date POINTERS into it
 * ("Chapman (2009), p. 6"). matchBibliographyPointers resolves these against
 * the book's OWN bibliography (already externally resolved by the bib scan),
 * never externally — surname+year without a title is exactly the input that
 * mis-matches to the wrong work.
 */

use App\Jobs\CitationScanBibliographyJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function bpDb()
{
    return DB::connection('pgsql_admin');
}

function bpSeed(array $bibRows, array $footnotes): string
{
    $book = 'book_canonv_bp_' . Str::random(8);
    bpDb()->table('library')->insert([
        'book' => $book, 'title' => 'BP Test Book', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    foreach ($bibRows as $r) {
        bpDb()->table('bibliography')->insert([
            'book' => $book, 'referenceId' => $r['referenceId'],
            'content' => $r['content'] ?? 'bib entry',
            'llm_metadata' => json_encode($r['meta']),
            'foundation_source' => $r['foundation_source'] ?? null,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
    foreach ($footnotes as $fn) {
        bpDb()->table('footnotes')->insert([
            'book' => $book, 'footnoteId' => $fn['id'],
            'content' => '<p>' . ($fn['text'] ?? 'fn') . '</p>',
            'is_citation' => true,
            'llm_metadata' => json_encode($fn['meta']),
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
    return $book;
}

function bpCleanup(string $book): void
{
    foreach (['footnotes', 'bibliography', 'library'] as $t) {
        bpDb()->table($t)->where('book', $book)->delete();
    }
}

function bpJob(string $book): array
{
    $rc = new ReflectionClass(CitationScanBibliographyJob::class);
    $job = $rc->newInstanceWithoutConstructor();
    foreach (['bookId' => $book, 'sourceTable' => 'footnotes'] as $prop => $val) {
        $p = $rc->getProperty($prop);
        $p->setAccessible(true);
        $p->setValue($job, $val);
    }
    $m = $rc->getMethod('matchBibliographyPointers');
    $m->setAccessible(true);
    return [$job, $m];
}

$chapmanBib = [
    'referenceId' => 'chapman2009',
    'meta' => ['title' => 'Good faith in European contract law', 'authors' => ['Chapman, J.'], 'year' => 2009, 'type' => 'book'],
    'foundation_source' => 'book_chapman_real',
];

test('an author-date pointer footnote inherits the bibliography entry resolution', function () use ($chapmanBib) {
    $book = bpSeed([$chapmanBib], [
        ['id' => 'fn1', 'text' => 'Chapman (2009), p. 6.', 'meta' => ['type' => 'book', 'authors' => ['Chapman'], 'year' => 2009, 'title' => null]],
    ]);
    try {
        [$job, $m] = bpJob($book);
        $needs = [(object) ['referenceId' => 'fn1']];
        $m->invokeArgs($job, [bpDb(), &$needs]);

        $row = bpDb()->table('footnotes')->where('book', $book)->where('footnoteId', 'fn1')
            ->first(['foundation_source', 'match_method', 'llm_metadata']);
        expect($row->foundation_source)->toBe('book_chapman_real');
        expect($row->match_method)->toBe('bibliography_pointer');
        expect(json_decode($row->llm_metadata, true)['bibliography_ref'])->toBe('chapman2009');
        // never resolved externally
        expect($needs)->toBe([]);
    } finally {
        bpCleanup($book);
    }
});

test('an AMBIGUOUS pointer (two works, same surname+year) stays unlinked — honest over guessed', function () use ($chapmanBib) {
    $other = [
        'referenceId' => 'chapman2009b',
        'meta' => ['title' => 'Remedies and restitution', 'authors' => ['Chapman, J.'], 'year' => 2009, 'type' => 'book'],
        'foundation_source' => 'book_chapman_other',
    ];
    $book = bpSeed([$chapmanBib, $other], [
        ['id' => 'fn1', 'meta' => ['type' => 'book', 'authors' => ['Chapman'], 'year' => 2009, 'title' => null]],
    ]);
    try {
        [$job, $m] = bpJob($book);
        $needs = [(object) ['referenceId' => 'fn1']];
        $m->invokeArgs($job, [bpDb(), &$needs]);

        $row = bpDb()->table('footnotes')->where('book', $book)->where('footnoteId', 'fn1')
            ->first(['foundation_source', 'match_method']);
        expect($row->foundation_source)->toBeNull();
        expect($row->match_method)->not->toBe('bibliography_pointer');
        expect(count($needs))->toBe(1); // left for the normal flow
    } finally {
        bpCleanup($book);
    }
});

test('a footnote carrying a FULL reference is left for the normal resolution waves', function () use ($chapmanBib) {
    $book = bpSeed([$chapmanBib], [
        ['id' => 'fn1', 'meta' => [
            'type' => 'book', 'authors' => ['Chapman, J.'], 'year' => 2009,
            'title' => 'A completely different self-contained cited monograph title',
        ]],
    ]);
    try {
        [$job, $m] = bpJob($book);
        $needs = [(object) ['referenceId' => 'fn1']];
        $m->invokeArgs($job, [bpDb(), &$needs]);

        expect(count($needs))->toBe(1); // full citations resolve through the waves
        $row = bpDb()->table('footnotes')->where('book', $book)->where('footnoteId', 'fn1')->first(['match_method']);
        expect($row->match_method)->not->toBe('bibliography_pointer');
    } finally {
        bpCleanup($book);
    }
});

test('pointer to an UNRESOLVED bibliography entry still links (and skips external resolution)', function () {
    $unresolved = [
        'referenceId' => 'smith2010',
        'meta' => ['title' => 'Obscure work', 'authors' => ['Smith, A.'], 'year' => 2010, 'type' => 'book'],
        'foundation_source' => null, // bib scan could not resolve it externally
    ];
    $book = bpSeed([$unresolved], [
        ['id' => 'fn1', 'meta' => ['type' => 'book', 'authors' => ['Smith'], 'year' => 2010, 'title' => null]],
    ]);
    try {
        [$job, $m] = bpJob($book);
        $needs = [(object) ['referenceId' => 'fn1']];
        $m->invokeArgs($job, [bpDb(), &$needs]);

        $row = bpDb()->table('footnotes')->where('book', $book)->where('footnoteId', 'fn1')
            ->first(['foundation_source', 'match_method']);
        expect($row->match_method)->toBe('bibliography_pointer'); // the pointer itself is known
        expect($row->foundation_source)->toBeNull();              // nothing to inherit
        expect($needs)->toBe([]);                                  // but never resolved alone either
    } finally {
        bpCleanup($book);
    }
});
