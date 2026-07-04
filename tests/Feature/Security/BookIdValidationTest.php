<?php

use Illuminate\Support\Facades\DB;

/**
 * /api/validate-book-id must see PAST RLS: library.book is a GLOBAL primary
 * key, but the old RLS-scoped existence check couldn't see other users'
 * private rows — a taken id validated as "available" and the import's insert
 * 500'd on library_pkey. Regression + the privacy counterpart: a stranger's
 * private book reads as taken WITHOUT leaking its title/author/url.
 */

it('reports another user\'s PRIVATE book id as taken — without leaking its metadata', function () {
    $owner = $this->seedUser();
    $this->seedLibrary([
        'book' => 'rls_val_private',
        'creator' => $owner->name,
        'creator_token' => $owner->user_token,
        'visibility' => 'private',
        'title' => 'Sensitive Private Title',
        'author' => 'Secret Author',
    ]);

    $stranger = $this->seedUser();
    $this->actingAs($stranger);

    $response = $this->postJson('/api/validate-book-id', ['book' => 'rls_val_private'])
        ->assertOk()
        ->assertJsonPath('exists', true);

    expect($response->json('book_title'))->toBeNull()
        ->and($response->json('book_author'))->toBeNull()
        ->and($response->json('book_url'))->toBeNull()
        ->and($response->getContent())->not->toContain('Sensitive Private Title');
});

it('still returns metadata for a book the caller CAN see (own private book)', function () {
    $owner = $this->seedUser();
    $this->seedLibrary([
        'book' => 'rls_val_own',
        'creator' => $owner->name,
        'creator_token' => $owner->user_token,
        'visibility' => 'private',
        'title' => 'My Own Book',
    ]);

    $this->actingAs($owner);
    $this->postJson('/api/validate-book-id', ['book' => 'rls_val_own'])
        ->assertOk()
        ->assertJsonPath('exists', true)
        ->assertJsonPath('book_title', 'My Own Book');
});

it('reports a genuinely free id as available', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    $this->postJson('/api/validate-book-id', ['book' => 'rls_val_free_'.uniqid()])
        ->assertOk()
        ->assertJsonPath('exists', false);
});
