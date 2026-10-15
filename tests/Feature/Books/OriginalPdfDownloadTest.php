<?php

use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

// Feature/Books isn't in tests/Pest.php's SeedsRlsFixtures binding — attach the
// admin-connection seeding helpers (seedUser/seedLibrary) to this file alone.
uses(\Tests\Support\SeedsRlsFixtures::class);

/**
 * GET /{book}/original.pdf — the "PDF phile" button's route. Serves the PDF a
 * book was imported from (resources/markdown/{book}/original.pdf) as an
 * attachment to anyone who may read the book. The same route doubles as the
 * button's availability probe (HEAD), so these lock BOTH contracts:
 * 200 = show the button and serve the file; 403/404 = no button.
 *
 * PDF only, by decision: an original .epub/.docx would read as a confusing
 * duplicate of our epub/docx exports (those stay in the download-all zip).
 *
 * The access gate deliberately reads the library row on pgsql_admin
 * (BookMediaController::canAccessLegacy pattern): under RLS a stranger cannot
 * SELECT a private book's row, and canAccessBookContent's "no visible row →
 * allow" default would then have served the whole private PDF. The
 * private-book cases below are what pin that.
 */

// Pest loads every test file into one process — helper names cannot collide.
function opdfBook(): string
{
    return 'opdfrls_'.Str::lower(Str::random(10));
}

function opdfPutOriginal(string $book, string $name = 'original.pdf'): string
{
    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    File::put("{$dir}/{$name}", '%PDF-1.4 FAKE ORIGINAL');

    return "{$dir}/{$name}";
}

afterEach(function () {
    foreach (File::directories(resource_path('markdown')) as $dir) {
        if (str_starts_with(basename($dir), 'opdfrls_')) {
            File::deleteDirectory($dir);
        }
    }
});

it('serves a public book\'s original PDF as an attachment named after the book', function () {
    $owner = $this->seedUser();
    $book = opdfBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token,
        'visibility' => 'public', 'title' => 'A Grand Title', 'author' => 'Some Author',
    ]);
    opdfPutOriginal($book);

    $response = $this->get("/{$book}/original.pdf");
    $response->assertOk();
    expect($response->headers->get('content-type'))->toContain('application/pdf');
    expect($response->headers->get('content-disposition'))
        ->toContain('attachment')
        ->toContain('Some Author - A Grand Title.pdf');
    // A private, no-store posture: the owner's session may be in play and a
    // shared cache must never retain the body. `public` is what Symfony merges
    // in by default — its absence is the point (applyCachePosture's trap).
    expect($response->headers->get('cache-control'))->toContain('no-store')
        ->not->toContain('public');
});

it('answers the HEAD availability probe with 200 when the file exists', function () {
    $owner = $this->seedUser();
    $book = opdfBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    opdfPutOriginal($book);

    $this->call('HEAD', "/{$book}/original.pdf")->assertOk();
});

it('404s when the book has no original PDF on disk', function () {
    $owner = $this->seedUser();
    $book = opdfBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);

    $this->get("/{$book}/original.pdf")->assertNotFound();
});

it('404s when only a non-PDF original exists — the button is PDF-only by design', function () {
    $owner = $this->seedUser();
    $book = opdfBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    opdfPutOriginal($book, 'original.epub');

    $this->get("/{$book}/original.pdf")->assertNotFound();
});

it('refuses a private book\'s original PDF to a stranger', function () {
    // THE case that forbids gating on canAccessBookContent: RLS hides the
    // private row from a stranger, and "no visible row" must not mean "allow".
    $owner = $this->seedUser();
    $book = opdfBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);
    opdfPutOriginal($book);

    $this->get("/{$book}/original.pdf")->assertForbidden();
});

it('serves a private book\'s original PDF to its owner', function () {
    $owner = $this->seedUser();
    $book = opdfBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);
    opdfPutOriginal($book);

    $this->actingAs($owner)->get("/{$book}/original.pdf")->assertOk();
});

it('404s an orphaned markdown dir with no library row rather than serving it', function () {
    $book = opdfBook();
    opdfPutOriginal($book);

    $this->get("/{$book}/original.pdf")->assertNotFound();
});

it('is inert against path traversal in the book segment', function () {
    // The route constraint only admits [a-zA-Z0-9-_], so an encoded ../
    // never reaches the closure.
    $this->get('/'.urlencode('../../config').'/original.pdf')->assertNotFound();
});
