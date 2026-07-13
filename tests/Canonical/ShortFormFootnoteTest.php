<?php

/**
 * Short-form footnote antecedent linking — the fix for the "H. L. A. Hart bug":
 * scholarly footnotes give a full reference once, then short forms
 * ("Hart, Justice, pp. 66–7"). Extracted in isolation the LLM confabulated the
 * missing details (linked H. L. A. Hart 1955 instead of J. S. Hart 1991).
 *
 * matchShortFormAntecedents links short forms DETERMINISTICALLY (surname +
 * short-title prefix vs earlier full citations, document order from node
 * markers); ibid → preceding citation; ambiguity → callable (LLM in prod,
 * fake here); inheritance copies the antecedent's resolution after the waves.
 */

use App\Jobs\CitationScanBibliographyJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function sfDb()
{
    return DB::connection('pgsql_admin');
}

/** Seed a book with nodes (marker order) + citation footnotes with metadata. */
function sfSeedBook(array $footnotes): string
{
    $book = 'book_canonv_sf_' . Str::random(8);
    sfDb()->table('library')->insert([
        'book' => $book, 'title' => 'SF Test Book', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);

    $markerJson = [];
    foreach ($footnotes as $i => $fn) {
        $markerJson[] = ['id' => $fn['id'], 'marker' => (string) ($i + 1)];
    }
    sfDb()->table('nodes')->insert([
        'book' => $book, 'node_id' => $book . '_n1', 'chunk_id' => 1, 'startLine' => 1,
        'content' => '<p>body</p>', 'plainText' => 'body', 'type' => 'p',
        'footnotes' => json_encode($markerJson),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    foreach ($footnotes as $fn) {
        sfDb()->table('footnotes')->insert([
            'book' => $book, 'footnoteId' => $fn['id'],
            'content' => '<p>' . ($fn['text'] ?? 'fn') . '</p>',
            'is_citation' => true,
            'llm_metadata' => json_encode($fn['meta']),
            'foundation_source' => $fn['foundation_source'] ?? null,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    return $book;
}

function sfCleanup(string $book): void
{
    foreach (['footnotes', 'nodes', 'library'] as $t) {
        sfDb()->table($t)->where('book', $book)->delete();
    }
}

/** Build a job instance pointed at $book without running its constructor. */
function sfJob(string $book): array
{
    $rc = new ReflectionClass(CitationScanBibliographyJob::class);
    $job = $rc->newInstanceWithoutConstructor();
    foreach (['bookId' => $book, 'sourceTable' => 'footnotes'] as $prop => $val) {
        $p = $rc->getProperty($prop);
        $p->setAccessible(true);
        $p->setValue($job, $val);
    }
    $m = $rc->getMethod('matchShortFormAntecedents');
    $m->setAccessible(true);
    $inh = $rc->getMethod('inheritShortFormResolutions');
    $inh->setAccessible(true);
    return [$job, $m, $inh];
}

$hartFull = [
    'title' => 'Justice upon petition: the House of Lords and the reformation of justice',
    'authors' => ['Hart, J. S.'], 'year' => 1991, 'type' => 'book',
];

test('the Hart case: short form links to the earlier full citation, never a confabulation', function () use ($hartFull) {
    $book = sfSeedBook([
        ['id' => 'fnA', 'text' => 'J. S. Hart, Justice upon petition (London, 1991), pp. 64-5.', 'meta' => $hartFull],
        ['id' => 'fnB', 'text' => 'Hart, Justice, pp. 66-7.', 'meta' => ['type' => 'short-form', 'surname' => 'Hart', 'short_title' => 'Justice']],
    ]);
    try {
        [$job, $m] = sfJob($book);
        $needs = [(object) ['referenceId' => 'fnB']];
        $map = $m->invokeArgs($job, [sfDb(), &$needs, null]);

        expect($map)->toBe(['fnB' => 'fnA']);
        // metadata inherited from the REAL antecedent (1991, J. S. Hart)
        $meta = json_decode(sfDb()->table('footnotes')->where('book', $book)->where('footnoteId', 'fnB')->value('llm_metadata'), true);
        expect($meta['year'])->toBe(1991);
        expect($meta['authors'][0])->toBe('Hart, J. S.');
        expect($meta['short_form_of'])->toBe('fnA');
        // removed from independent resolution
        expect($needs)->toBe([]);
    } finally {
        sfCleanup($book);
    }
});

test('ibid follows the chain: ibid after a linked short form reaches the original full citation', function () use ($hartFull) {
    $book = sfSeedBook([
        ['id' => 'fnA', 'meta' => $hartFull],
        ['id' => 'fnB', 'meta' => ['type' => 'short-form', 'surname' => 'Hart', 'short_title' => 'Justice']],
        ['id' => 'fnC', 'meta' => ['type' => 'ibid']],
    ]);
    try {
        [$job, $m] = sfJob($book);
        $needs = [(object) ['referenceId' => 'fnB'], (object) ['referenceId' => 'fnC']];
        $map = $m->invokeArgs($job, [sfDb(), &$needs, null]);

        expect($map['fnB'] ?? null)->toBe('fnA');
        expect($map['fnC'] ?? null)->toBe('fnA'); // chain collapses to the full citation
        expect($needs)->toBe([]);
    } finally {
        sfCleanup($book);
    }
});

test('ambiguous short form goes to the disambiguator with the KNOWN candidates', function () use ($hartFull) {
    $other = ['title' => 'Justice and the law in early modern England', 'authors' => ['Hart, J. S.'], 'year' => 2003, 'type' => 'book'];
    $book = sfSeedBook([
        ['id' => 'fnA', 'meta' => $hartFull],
        ['id' => 'fnB', 'meta' => $other],
        ['id' => 'fnC', 'text' => 'Hart, Justice, p. 12.', 'meta' => ['type' => 'short-form', 'surname' => 'Hart', 'short_title' => 'Justice']],
    ]);
    try {
        [$job, $m] = sfJob($book);
        $needs = [(object) ['referenceId' => 'fnC']];
        $captured = null;
        // Fake LLM: capture the candidates, pick #2 (candidates are nearest-first,
        // so #1 = fnB (2003), #2 = fnA (1991)).
        $fake = function (array $items) use (&$captured) {
            $captured = $items;
            return array_map(fn($i) => 2, $items);
        };
        $map = $m->invokeArgs($job, [sfDb(), &$needs, $fake]);

        expect($captured)->not->toBeNull();
        expect(count($captured['fnC']['candidates']))->toBe(2);
        expect($map['fnC'] ?? null)->toBe('fnA');
    } finally {
        sfCleanup($book);
    }
});

test('a short form with NO antecedent stays unlinked AND out of resolution (honest unknown beats wrong link)', function () {
    $book = sfSeedBook([
        ['id' => 'fnA', 'meta' => ['type' => 'short-form', 'surname' => 'Millstone', 'short_title' => 'Manuscript circulation']],
    ]);
    try {
        [$job, $m] = sfJob($book);
        $needs = [(object) ['referenceId' => 'fnA']];
        $map = $m->invokeArgs($job, [sfDb(), &$needs, null]);

        expect($map)->toBe([]);
        expect($needs)->toBe([]); // never resolved independently — that is the hallucination path
        $meta = json_decode(sfDb()->table('footnotes')->where('book', $book)->where('footnoteId', 'fnA')->value('llm_metadata'), true);
        expect($meta['type'])->toBe('short-form'); // metadata untouched, no invented year/title
    } finally {
        sfCleanup($book);
    }
});

test('ibid after an UNLINKED short form stays unlinked (does not skip back to the wrong work)', function () use ($hartFull) {
    $book = sfSeedBook([
        ['id' => 'fnA', 'meta' => $hartFull],
        ['id' => 'fnB', 'meta' => ['type' => 'short-form', 'surname' => 'Nomatch', 'short_title' => 'Ghost work']],
        ['id' => 'fnC', 'meta' => ['type' => 'ibid']],
    ]);
    try {
        [$job, $m] = sfJob($book);
        $needs = [(object) ['referenceId' => 'fnB'], (object) ['referenceId' => 'fnC']];
        $map = $m->invokeArgs($job, [sfDb(), &$needs, null]);

        expect($map)->toBe([]); // fnC must NOT link to fnA past the unknown fnB
    } finally {
        sfCleanup($book);
    }
});

test('inheritance: short form inherits the antecedent resolution after the waves', function () use ($hartFull) {
    $book = sfSeedBook([
        ['id' => 'fnA', 'meta' => $hartFull, 'foundation_source' => 'book_hart_real'],
        ['id' => 'fnB', 'meta' => ['type' => 'short-form', 'surname' => 'Hart', 'short_title' => 'Justice']],
    ]);
    try {
        [$job, , $inh] = sfJob($book);
        $inh->invokeArgs($job, [sfDb(), ['fnB' => 'fnA']]);

        $row = sfDb()->table('footnotes')->where('book', $book)->where('footnoteId', 'fnB')
            ->first(['foundation_source', 'match_method']);
        expect($row->foundation_source)->toBe('book_hart_real');
        expect($row->match_method)->toBe('short_form_antecedent');
    } finally {
        sfCleanup($book);
    }
});

test('the extraction prompt forbids inventing short-form completions', function () {
    $src = file_get_contents(base_path('app/Services/LlmService.php'));
    expect($src)->toContain('"type": "short-form"');
    expect($src)->toContain('NEVER guess or complete the title');
});

test('the extraction taxonomy names every footnote citation kind (no more "other" black hole)', function () {
    $src = file_get_contents(base_path('app/Services/LlmService.php'));
    // Author-date pointers ("Chapman (2009), p. 6.") route to the bibliography matcher
    expect($src)->toContain('"type": "pointer"');
    // Legal texts: legislation + case law ARE citations
    expect($src)->toContain('"type": "legislation"');
    expect($src)->toContain('"type": "case-law"');

    // And the scan routes them: reference-style types count as citations
    $job = file_get_contents(base_path('app/Jobs/CitationScanBibliographyJob.php'));
    expect($job)->toContain("REFERENCE_STYLE_TYPES = ['short-form', 'ibid', 'pointer', 'legislation', 'case-law']");
});
