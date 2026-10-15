<?php

/**
 * A deleted book's URL answers honestly: HTTP 410 + a tombstone page, served
 * from the soft-deleted library row (visibility='deleted') that account/book
 * deletion keeps precisely so the address stays reserved. The unknown-book 200
 * noindex shell is pinned as the NEGATIVE control — the local-first create
 * flow renders into that shell, and the 410 discriminator must never widen to
 * swallow it.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(function () {
    DB::connection('pgsql_admin')->table('library')->where('book', 'like', 'tombstone_test_%')->delete();
});

test('a soft-deleted book serves a 410 tombstone page', function () {
    $book = 'tombstone_test_'.strtolower(Str::random(6));
    DB::connection('pgsql_admin')->table('library')->insert([
        'book' => $book,
        'visibility' => 'deleted',
        'raw_json' => '{}',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $this->get('/'.$book)
        ->assertStatus(410)
        ->assertSee('This book was deleted by its author', false)
        ->assertSee('noindex', false);
});

test('an unknown book still serves the 200 noindex shell (local-first contract)', function () {
    $this->get('/tombstone_test_never_existed'.strtolower(Str::random(6)))
        ->assertStatus(200)
        ->assertSee('noindex', false);
});
