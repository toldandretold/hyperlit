<?php

/**
 * AmbiguousCitationRegistry — the ledger that lets a converter ASK about an ambiguous citation and
 * lets a human ANSWER once, with the answer surviving every later reconvert.
 *
 * The property that matters most is the round trip: sync() registers the question, resolve()
 * rewrites the stored anchor and records the answer, and a RECONVERT (which mints entirely fresh
 * nodes carrying the ambiguous marker again) has the answer RE-APPLIED by the next sync() instead
 * of surfacing the question twice. Fingerprints are sentence-based, so the identity survives new
 * node ids but honestly breaks when a pipeline fix changes the sentence text.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (afterEach admin deletes deadlock against the
 * open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use App\Services\Citations\AmbiguousCitationRegistry;
use Illuminate\Support\Facades\DB;

const AMBIG_PREFIX = 'book_ambigtest_';

function ambigDb()
{
    return DB::connection('pgsql_admin');
}

function ambigCleanup(): void
{
    foreach (['nodes', 'library', 'citation_resolutions'] as $table) {
        ambigDb()->table($table)->where('book', 'LIKE', AMBIG_PREFIX . '%')->delete();
    }
}

beforeEach(fn () => ambigCleanup());
afterAll(fn () => ambigCleanup());

function ambigBook(string $suffix): string
{
    $book = AMBIG_PREFIX . $suffix;
    ambigDb()->table('library')->insert([
        'book' => $book, 'title' => 'AmbigTest ' . $suffix, 'visibility' => 'public',
        'has_nodes' => true, 'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    return $book;
}

function ambigNode(string $book, int $line, string $html): int
{
    return (int) ambigDb()->table('nodes')->insertGetId([
        'book' => $book, 'chunk_id' => 0, 'startLine' => $line, 'content' => $html,
        'plainText' => trim(strip_tags($html)), 'type' => 'p',
        'node_id' => $book . '_' . $line, 'footnotes' => '[]',
    ]);
}

/** The anchor exactly as the Python linker emits it (bleach serialises attributes sorted). */
function ambigAnchor(string $target, array $candidates, string $year = '2013'): string
{
    return '<a class="in-text-citation" data-candidates="' . implode('|', $candidates)
        . '" data-resolved="ambiguous" href="#' . $target . '">' . $year . '</a>';
}

function ambigParagraph(string $book, int $line = 1): string
{
    $html = '<p>Christopher discusses laundering on the Internet at length. Efforts, she explains ('
        . ambigAnchor('internet2013', ['internet2013', 'christopher2013']) . ': 5), are misguided.</p>';
    ambigNode($book, $line, $html);
    ambigNode($book, $line + 1,
        '<p><a class="bib-entry" id="christopher2013"></a>Christopher, A. (2013). Laundering.</p>');
    ambigNode($book, $line + 2,
        '<p><a class="bib-entry" id="internet2013"></a>Internet Society. (2013). Report.</p>');
    ambigNode($book, $line + 3,
        '<p>Elsewhere Christopher (<a class="in-text-citation" href="#christopher2013">2013</a>) is cited properly.</p>');
    return $html;
}

test('sync registers a pending question with enriched candidates', function () {
    $book = ambigBook('register');
    ambigParagraph($book);

    $r = app(AmbiguousCitationRegistry::class)->sync($book);

    expect($r['ambiguous'])->toBe(1)->and($r['pending'])->toBe(1)->and($r['applied'])->toBe(0);
    $row = ambigDb()->table('citation_resolutions')->where('book', $book)->first();
    expect($row->status)->toBe('pending');
    expect($row->sentence)->toContain('she explains');
    $cands = collect(json_decode($row->candidates, true));
    expect($cands->pluck('target')->all())->toBe(['internet2013', 'christopher2013']);
    // the enrichment a maintainer decides with: the entry text + how often it is PROPERLY cited
    $chris = $cands->firstWhere('target', 'christopher2013');
    expect($chris['entry'])->toContain('Laundering');
    expect($chris['cited_elsewhere'])->toBe(1);
    $net = $cands->firstWhere('target', 'internet2013');
    expect($net['cited_elsewhere'])->toBe(0);
});

test('sync is idempotent and keeps the row id stable', function () {
    $book = ambigBook('idempotent');
    ambigParagraph($book);
    $registry = app(AmbiguousCitationRegistry::class);

    $registry->sync($book);
    $id1 = ambigDb()->table('citation_resolutions')->where('book', $book)->value('id');
    $registry->sync($book);
    $rows = ambigDb()->table('citation_resolutions')->where('book', $book)->get();

    expect($rows)->toHaveCount(1);
    expect($rows[0]->id)->toBe($id1);
});

test('resolving to a candidate rewrites the anchor as confirmed and bumps the timestamp', function () {
    $book = ambigBook('choose');
    ambigParagraph($book);
    $registry = app(AmbiguousCitationRegistry::class);
    $registry->sync($book);
    $id = ambigDb()->table('citation_resolutions')->where('book', $book)->value('id');

    $r = $registry->resolve($id, 'christopher2013', 'the-maintainer');

    expect($r['patched'])->toBe(1);
    $content = ambigDb()->table('nodes')->where('book', $book)->where('startLine', 1)->value('content');
    expect($content)->toContain('data-resolved="confirmed"')
        ->and($content)->toContain('href="#christopher2013"')
        ->and($content)->not->toContain('data-candidates')
        ->and($content)->not->toContain('ambiguous');
    $row = ambigDb()->table('citation_resolutions')->where('id', $id)->first();
    expect($row->status)->toBe('resolved')->and($row->chosen)->toBe('christopher2013')
        ->and($row->resolved_by)->toBe('the-maintainer');
    expect((int) ambigDb()->table('library')->where('book', $book)->value('timestamp'))
        ->toBeGreaterThan(0);
});

test('resolving as not-a-citation unlinks the anchor back to plain text', function () {
    $book = ambigBook('unlink');
    ambigParagraph($book);
    $registry = app(AmbiguousCitationRegistry::class);
    $registry->sync($book);
    $id = ambigDb()->table('citation_resolutions')->where('book', $book)->value('id');

    $r = $registry->resolve($id, null, 'the-maintainer');

    expect($r['patched'])->toBe(1);
    $content = ambigDb()->table('nodes')->where('book', $book)->where('startLine', 1)->value('content');
    expect($content)->toContain('she explains (2013: 5)')
        ->and($content)->not->toContain('data-resolved');
});

test('an answer that is not one of the candidates is refused', function () {
    $book = ambigBook('refuse');
    ambigParagraph($book);
    $registry = app(AmbiguousCitationRegistry::class);
    $registry->sync($book);
    $id = ambigDb()->table('citation_resolutions')->where('book', $book)->value('id');

    $r = $registry->resolve($id, 'somethingelse1999', 'the-maintainer');

    expect($r['error'])->toBe('not_a_candidate');
    expect(ambigDb()->table('citation_resolutions')->where('id', $id)->value('status'))->toBe('pending');
});

test('THE POINT: a reconvert re-applies the human answer instead of re-asking', function () {
    $book = ambigBook('survive');
    ambigParagraph($book);
    $registry = app(AmbiguousCitationRegistry::class);
    $registry->sync($book);
    $id = ambigDb()->table('citation_resolutions')->where('book', $book)->value('id');
    $registry->resolve($id, 'christopher2013', 'the-maintainer');

    // Reconvert: nodes wiped, fresh ones minted with NEW ids and the ambiguous marker back.
    ambigDb()->table('nodes')->where('book', $book)->delete();
    ambigParagraph($book, 11);

    $r = $registry->sync($book);

    expect($r['applied'])->toBe(1)->and($r['pending'])->toBe(0);
    $content = ambigDb()->table('nodes')->where('book', $book)->where('startLine', 11)->value('content');
    expect($content)->toContain('href="#christopher2013"')
        ->and($content)->toContain('data-resolved="confirmed"');
    // and no second question was minted
    expect(ambigDb()->table('citation_resolutions')->where('book', $book)->count())->toBe(1);
});

test('a pipeline fix that changes the sentence honestly re-opens the question', function () {
    $book = ambigBook('reopen');
    ambigParagraph($book);
    $registry = app(AmbiguousCitationRegistry::class);
    $registry->sync($book);
    $registry->resolve(
        ambigDb()->table('citation_resolutions')->where('book', $book)->value('id'),
        'christopher2013', 'the-maintainer');

    // Reconvert with DIFFERENT sentence text (an OCR fix upstream).
    ambigDb()->table('nodes')->where('book', $book)->delete();
    ambigNode($book, 21, '<p>A wholly rewritten sentence about enforcement, she explains ('
        . ambigAnchor('internet2013', ['internet2013', 'christopher2013']) . ': 5).</p>');

    $r = $registry->sync($book);

    expect($r['applied'])->toBe(0)->and($r['pending'])->toBe(1);
    expect(ambigDb()->table('citation_resolutions')->where('book', $book)
        ->where('status', 'pending')->count())->toBe(1);
});

test('a pending question about text the conversion no longer produces is dropped', function () {
    $book = ambigBook('stale');
    ambigParagraph($book);
    $registry = app(AmbiguousCitationRegistry::class);
    $registry->sync($book);

    // Reconvert resolves the ambiguity upstream (better keying) — no marker at all now.
    ambigDb()->table('nodes')->where('book', $book)->delete();
    ambigNode($book, 31, '<p>Efforts, she explains (<a class="in-text-citation" '
        . 'href="#christopher2013">2013</a>: 5), are misguided.</p>');

    $r = $registry->sync($book);

    expect($r['stale_dropped'])->toBe(1);
    expect(ambigDb()->table('citation_resolutions')->where('book', $book)->count())->toBe(0);
});
