<?php

/**
 * SourceVerificationController — the owner-gated HTTP seam for the [check source] flow. The matcher
 * is mocked here (its logic is covered in tests/Canonical/SourcePreviewVerifyTest); these tests pin
 * the controller contract: auth gating, that lookup returns the preview, that verify re-resolves the
 * chosen identifier and links it, and that reject stamps.
 */

use App\Models\CanonicalSource;
use App\Services\CanonicalSourceMatcher;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(function () {
    DB::connection('pgsql_admin')->table('canonical_source')->where('title', 'like', 'APITEST %')->delete();
    $this->cleanupApiFixtures();
});

function spvPreview(array $candidate): array
{
    return [
        'status'        => 'linked_new',
        'method'        => 'openalex_doi',
        'score'         => 1.0,
        'candidate'     => $candidate,
        'alternates'    => [],
        'alreadyLinked' => false,
        'current'       => null,
    ];
}

test('lookup returns the matcher preview for the owner', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['doi' => '10.1/x']);

    $this->mock(CanonicalSourceMatcher::class, function ($m) {
        $m->shouldReceive('preview')->once()
            ->andReturn(spvPreview(['title' => 'Found Work', 'doi' => '10.1/x', 'openalex_id' => 'W1']));
    });

    $this->postJson("/api/library/{$book}/source/lookup")
        ->assertOk()
        ->assertJson([
            'success'   => true,
            'status'    => 'linked_new',
            'candidate' => ['title' => 'Found Work'],
        ]);
});

test('lookup is forbidden for a non-owner', function () {
    $owner = $this->apiUser();           // not authenticated
    $book  = $this->makeBook($owner, ['visibility' => 'public']); // public → RLS-visible to others
    $this->loginUser();                  // a different, authenticated user
    $this->mock(CanonicalSourceMatcher::class); // must not be called

    $this->postJson("/api/library/{$book}/source/lookup")->assertStatus(403);
});

test('lookup 404s for a missing book', function () {
    $this->loginUser();
    $this->mock(CanonicalSourceMatcher::class);

    $this->postJson('/api/library/apitest_does_not_exist/source/lookup')->assertStatus(404);
});

test('verify re-resolves the chosen identifier and links it', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['doi' => '10.1/x']);

    $candidate = ['title' => 'Found Work', 'doi' => '10.1/x', 'openalex_id' => 'W1', 'source' => 'openalex'];
    $canonical = new CanonicalSource();
    $canonical->id = 'canon-uuid-1';

    $this->mock(CanonicalSourceMatcher::class, function ($m) use ($candidate, $canonical) {
        $m->shouldReceive('preview')->andReturn(spvPreview($candidate));
        $m->shouldReceive('verifyAndLink')->once()
            ->withArgs(fn ($lib, $norm, $by) => ($norm['openalex_id'] ?? null) === 'W1')
            ->andReturn($canonical);
    });

    $this->postJson("/api/library/{$book}/source/verify", ['identifier' => ['openalex_id' => 'W1']])
        ->assertOk()
        ->assertJson(['success' => true, 'canonical_source_id' => 'canon-uuid-1']);
});

test('verify requires an identifier', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $this->mock(CanonicalSourceMatcher::class);

    $this->postJson("/api/library/{$book}/source/verify", [])->assertStatus(422);
});

test('the library read returns provenance fields + the linked canonical', function () {
    $cid = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('canonical_source')->insert([
        'id' => $cid, 'title' => 'APITEST Canon', 'foundation_source' => 'openalex_ingest',
        'openalex_id' => 'W1', 'auto_version_book' => null,
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $user = $this->loginUser();
    $book = $this->makeBook($user, [
        'visibility' => 'public',
        'canonical_source_id' => $cid,
        'canonical_match_method' => 'openalex_doi',
        'conversion_method' => 'pdf_ocr',
        'foundation_source' => 'epub_import',
        'openalex_id' => 'W1',
    ]);

    $lib = $this->getJson("/api/database-to-indexeddb/books/{$book}/library")->assertOk()->json('library');

    expect($lib['conversion_method'])->toBe('pdf_ocr');
    expect($lib['foundation_source'])->toBe('epub_import');
    expect($lib['openalex_id'])->toBe('W1');
    expect($lib['canonical']['id'])->toBe($cid);
    expect($lib['canonical']['openalex_id'])->toBe('W1');
});

test('reject stamps via the matcher', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);

    $this->mock(CanonicalSourceMatcher::class, function ($m) {
        $m->shouldReceive('stampUserRejected')->once();
    });

    $this->postJson("/api/library/{$book}/source/reject")
        ->assertOk()
        ->assertJson(['success' => true]);
});
