<?php

/**
 * ReferenceSourceVerificationController — the owner-gated seam for the reference-level (bibliography)
 * confirm/reject of a canonical match found by the citation pipeline. Pins: auth gating (owner-only),
 * that a decision persists to the bibliography row via pgsql_admin (so it works for an authenticated,
 * token-less owner the RLS connection could not UPDATE), and the guards (missing ref/canonical, stale
 * canonical). The match itself must already exist — this only stamps a human decision on it.
 */

use Illuminate\Support\Facades\DB;

afterEach(function () {
    DB::connection('pgsql_admin')->table('bibliography')->where('book', 'like', 'apitest\_%')->delete();
    $this->cleanupApiFixtures();
});

/** Seed a bibliography row (via BYPASSRLS admin, like the pipeline does). */
function seedReference(string $book, string $refId, array $attrs = []): void
{
    DB::connection('pgsql_admin')->table('bibliography')->insert(array_merge([
        'book'        => $book,
        'referenceId' => $refId,
        'content'     => 'Some reference text.',
        'created_at'  => now(),
        'updated_at'  => now(),
    ], $attrs));
}

function readReference(string $book, string $refId): ?object
{
    return DB::connection('pgsql_admin')->table('bibliography')
        ->where('book', $book)->where('referenceId', $refId)->first();
}

test('owner verifies a matched reference → persists user_verified via pgsql_admin', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    seedReference($book, 'ref1', ['canonical_source_id' => '11111111-1111-1111-1111-111111111111', 'match_method' => 'openalex_doi']);

    $this->postJson("/api/library/{$book}/reference/ref1/source/verify")
        ->assertOk()
        ->assertJson(['success' => true, 'referenceId' => 'ref1', 'reference_match_method' => 'user_verified']);

    $row = readReference($book, 'ref1');
    expect($row->reference_match_method)->toBe('user_verified');
    expect($row->reference_verified_at)->not->toBeNull();
    expect($row->reference_verified_by)->toBe($user->name);
    // The pipeline's own match_method is untouched.
    expect($row->match_method)->toBe('openalex_doi');
});

test('owner rejects a matched reference → persists user_rejected', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    seedReference($book, 'ref1', ['canonical_source_id' => '11111111-1111-1111-1111-111111111111']);

    $this->postJson("/api/library/{$book}/reference/ref1/source/reject")
        ->assertOk()
        ->assertJson(['success' => true, 'reference_match_method' => 'user_rejected']);

    expect(readReference($book, 'ref1')->reference_match_method)->toBe('user_rejected');
});

test('a non-owner is forbidden', function () {
    $owner = $this->apiUser();                                   // not authenticated
    $book  = $this->makeBook($owner, ['visibility' => 'public']); // public → RLS-visible to others
    seedReference($book, 'ref1', ['canonical_source_id' => '11111111-1111-1111-1111-111111111111']);
    $this->loginUser();                                          // a different, authenticated user

    $this->postJson("/api/library/{$book}/reference/ref1/source/verify")->assertStatus(403);
    expect(readReference($book, 'ref1')->reference_match_method)->toBeNull();
});

test('an unauthenticated request is rejected', function () {
    $owner = $this->apiUser();
    $book  = $this->makeBook($owner, ['visibility' => 'public']);
    seedReference($book, 'ref1', ['canonical_source_id' => '11111111-1111-1111-1111-111111111111']);

    // No session, no anon token → invalid session.
    $this->postJson("/api/library/{$book}/reference/ref1/source/verify")->assertStatus(401);
});

test('404 for a missing book', function () {
    $this->loginUser();
    $this->postJson('/api/library/apitest_missing/reference/ref1/source/verify')->assertStatus(404);
});

test('404 for a missing reference', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);

    $this->postJson("/api/library/{$book}/reference/nope/source/verify")->assertStatus(404);
});

test('422 when the reference has no canonical match to verify', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    seedReference($book, 'ref1'); // no canonical_source_id

    $this->postJson("/api/library/{$book}/reference/ref1/source/verify")->assertStatus(422);
});

test('409 when the client-supplied canonical no longer matches the stored one', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    seedReference($book, 'ref1', ['canonical_source_id' => '11111111-1111-1111-1111-111111111111']);

    $this->postJson("/api/library/{$book}/reference/ref1/source/verify", ['canonical_source_id' => 'STALE'])
        ->assertStatus(409);
    expect(readReference($book, 'ref1')->reference_match_method)->toBeNull();
});

// ── Live lookup (read-only) + verify-from-candidate ──────────────────────────

function refPreview(array $candidate): array
{
    return ['status' => 'linked_new', 'method' => 'openalex_full', 'score' => 0.9,
            'candidate' => $candidate, 'alternates' => [], 'alreadyLinked' => false, 'current' => null];
}

test('lookup returns candidates for the owner', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    seedReference($book, 'ref1');

    $this->mock(\App\Services\BibliographySourceLookupService::class, function ($m) {
        $m->shouldReceive('previewReference')->once()
            ->andReturn(refPreview(['title' => 'Darker Nations', 'openalex_id' => 'W1']));
    });

    $this->postJson("/api/library/{$book}/reference/ref1/source/lookup")
        ->assertOk()
        ->assertJson(['success' => true, 'status' => 'linked_new', 'candidate' => ['title' => 'Darker Nations']]);
});

test('lookup is forbidden for a non-owner (owner-only action, keeps the paid LLM owner-only)', function () {
    $owner = $this->apiUser();
    $book  = $this->makeBook($owner, ['visibility' => 'public']);
    seedReference($book, 'ref1');
    $this->loginUser(); // a DIFFERENT, non-owner user
    $this->mock(\App\Services\BibliographySourceLookupService::class); // must not be called

    $this->postJson("/api/library/{$book}/reference/ref1/source/lookup")->assertStatus(403);
});

test('lookup rejects an unauthenticated request', function () {
    $owner = $this->apiUser();
    $book  = $this->makeBook($owner, ['visibility' => 'public']);
    seedReference($book, 'ref1');
    $this->mock(\App\Services\BibliographySourceLookupService::class); // must not be called

    $this->postJson("/api/library/{$book}/reference/ref1/source/lookup")->assertStatus(401);
});

test('verify with an identifier links the picked candidate on a previously-unmatched reference', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    seedReference($book, 'ref1'); // no canonical yet

    $candidate = ['title' => 'Darker Nations', 'openalex_id' => 'W1'];
    $this->mock(\App\Services\BibliographySourceLookupService::class, function ($m) use ($candidate, $book) {
        $m->shouldReceive('previewReference')->andReturn(refPreview($candidate));
        $m->shouldReceive('pickByIdentifier')->once()
            ->withArgs(fn ($preview, $id) => ($id['openalex_id'] ?? null) === 'W1')
            ->andReturn($candidate);
        $m->shouldReceive('linkCanonical')->once()
            ->withArgs(fn ($b, $r, $cand, $by) => $b === $book && $r === 'ref1' && ($cand['openalex_id'] ?? null) === 'W1')
            ->andReturn('canon-linked-1');
    });

    $this->postJson("/api/library/{$book}/reference/ref1/source/verify", ['identifier' => ['openalex_id' => 'W1']])
        ->assertOk()
        ->assertJson(['success' => true, 'canonical_source_id' => 'canon-linked-1', 'reference_match_method' => 'user_verified']);
});

test('verify with an identifier is forbidden for a non-owner', function () {
    $owner = $this->apiUser();
    $book  = $this->makeBook($owner, ['visibility' => 'public']);
    seedReference($book, 'ref1');
    $this->loginUser(); // different user
    $this->mock(\App\Services\BibliographySourceLookupService::class); // must not be called

    $this->postJson("/api/library/{$book}/reference/ref1/source/verify", ['identifier' => ['openalex_id' => 'W1']])
        ->assertStatus(403);
});
