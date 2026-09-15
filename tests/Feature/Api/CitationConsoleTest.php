<?php

/**
 * /maintainer/citations — the ambiguous-citation review queue over HTTP.
 *
 * The registry's semantics are locked in AmbiguousCitationRegistryTest; this file locks the
 * console seam: admin-only everywhere (page 404s, API 401/403s), the pending list carries what a
 * maintainer decides FROM (sentence, candidates with entry text, proper-citation counts), and
 * resolve validates its body — `choice` must be PRESENT (null is a meaningful answer, so its
 * absence cannot be its encoding) and must be one of the question's own candidates.
 *
 * Seeds via pgsql_admin, beforeEach-only cleanup (afterEach admin deletes deadlock against the
 * open RefreshDatabase transaction — docs/journal-harvest.md).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function ccDb()
{
    return DB::connection('pgsql_admin');
}

function ccCleanup(): void
{
    foreach (['nodes', 'library', 'citation_resolutions'] as $table) {
        ccDb()->table($table)->where('book', 'LIKE', 'book_cctest_%')->delete();
    }
}

beforeEach(fn () => ccCleanup());
afterAll(fn () => ccCleanup());

function ccSeedQuestion(string $suffix): array
{
    $book = 'book_cctest_' . $suffix;
    ccDb()->table('library')->insert([
        'book' => $book, 'title' => 'CCTest ' . $suffix, 'visibility' => 'public',
        'has_nodes' => true, 'type' => 'book', 'raw_json' => '[]', 'timestamp' => 0,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    ccDb()->table('nodes')->insert([
        'book' => $book, 'chunk_id' => 0, 'startLine' => 1,
        'content' => '<p>Efforts, she explains (<a class="in-text-citation" '
            . 'data-candidates="internet2013|christopher2013" data-resolved="ambiguous" '
            . 'href="#internet2013">2013</a>: 5), are misguided.</p>',
        'plainText' => 'Efforts, she explains (2013: 5), are misguided.',
        'type' => 'p', 'node_id' => $book . '_1', 'footnotes' => '[]',
    ]);
    $id = (string) Str::uuid();
    ccDb()->table('citation_resolutions')->insert([
        'id' => $id, 'book' => $book,
        'fingerprint' => app(\App\Services\Citations\AmbiguousCitationRegistry::class)
            ->fingerprint($book, '2013', 'Efforts, she explains ('),
        'year' => '2013',
        'sentence' => 'Efforts, she explains ( ⟦2013⟧',
        'candidates' => json_encode([
            ['target' => 'internet2013', 'entry' => 'Internet Society. (2013). Report.', 'cited_elsewhere' => 0],
            ['target' => 'christopher2013', 'entry' => 'Christopher, A. (2013). Laundering.', 'cited_elsewhere' => 3],
        ]),
        'href_current' => 'internet2013', 'status' => 'pending',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    return [$book, $id];
}

test('the page and the API are admin-only', function () {
    $this->get('/maintainer/citations')->assertNotFound();          // anonymous: page unadvertised
    $this->getJson('/api/maintainer/citations/ambiguous')->assertUnauthorized();

    $this->loginUser(['is_admin' => false]);
    $this->get('/maintainer/citations')->assertNotFound();
    $this->getJson('/api/maintainer/citations/ambiguous')->assertForbidden();
});

test('an admin sees the page and the pending list with decision evidence', function () {
    [$book, $id] = ccSeedQuestion('list');
    $this->loginUser(['is_admin' => true]);

    $this->get('/maintainer/citations')->assertOk();

    $res = $this->getJson('/api/maintainer/citations/ambiguous')->assertOk()->json();
    $group = collect($res['pending_books'])->firstWhere('book', $book);
    expect($group)->not->toBeNull();
    expect($group['title'])->toBe('CCTest list');
    $item = $group['items'][0];
    expect($item['id'])->toBe($id);
    expect($item['candidates'][1]['entry'])->toContain('Laundering');
    expect($item['candidates'][1]['cited_elsewhere'])->toBe(3);
});

test('resolve records the answer, patches the node, and names the admin', function () {
    [$book, $id] = ccSeedQuestion('resolve');
    $admin = $this->loginUser(['is_admin' => true]);

    $this->postJson("/api/maintainer/citations/ambiguous/{$id}/resolve",
        ['choice' => 'christopher2013'])->assertOk()->assertJson(['patched' => 1]);

    $content = ccDb()->table('nodes')->where('book', $book)->value('content');
    expect($content)->toContain('href="#christopher2013"')
        ->and($content)->toContain('data-resolved="confirmed"');
    $row = ccDb()->table('citation_resolutions')->where('id', $id)->first();
    expect($row->status)->toBe('resolved')->and($row->resolved_by)->toBe($admin->name);
});

test('a body without the choice key is refused — null is an answer, absence is not', function () {
    [, $id] = ccSeedQuestion('nobody');
    $this->loginUser(['is_admin' => true]);

    $this->postJson("/api/maintainer/citations/ambiguous/{$id}/resolve", [])
        ->assertStatus(422)->assertJson(['error' => 'choice_required']);
});

test('choice null unlinks the citation as not-a-citation', function () {
    [$book, $id] = ccSeedQuestion('unlink');
    $this->loginUser(['is_admin' => true]);

    $this->postJson("/api/maintainer/citations/ambiguous/{$id}/resolve", ['choice' => null])
        ->assertOk();

    $content = ccDb()->table('nodes')->where('book', $book)->value('content');
    expect($content)->toContain('she explains (2013: 5)')
        ->and($content)->not->toContain('in-text-citation');
});

test('a choice outside the candidate set is refused with 422', function () {
    [, $id] = ccSeedQuestion('outside');
    $this->loginUser(['is_admin' => true]);

    $this->postJson("/api/maintainer/citations/ambiguous/{$id}/resolve",
        ['choice' => 'unrelated1999'])
        ->assertStatus(422)->assertJson(['error' => 'not_a_candidate']);
});

test('an unknown id is a 404, not a silent success', function () {
    $this->loginUser(['is_admin' => true]);

    $this->postJson('/api/maintainer/citations/ambiguous/' . Str::uuid() . '/resolve',
        ['choice' => null])->assertNotFound();
});
