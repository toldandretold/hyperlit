<?php

/**
 * content:strip-no-delete-markers — the retired last-node marker sweep.
 *
 * The marker (`no-delete-id="please"`) is app state that was stamped inside
 * user content; nothing reads it anymore (runtime lastNodeGuard replaced it),
 * and this command strips the stale copies. The contract under test: nodes
 * cleaned, preview_nodes blobs cleaned, library.timestamp advanced for
 * touched books, and E2EE (encrypted) books left completely untouched.
 */

use Illuminate\Support\Facades\DB;

const STRIP_BOOK = 'rls_strip_marker_book';
const STRIP_ENC_BOOK = 'rls_strip_marker_enc';

afterEach(function () {
    // footnotes is not in SeedsRlsFixtures' cleanup table list — remove ours.
    DB::connection('pgsql_admin')->table('footnotes')
        ->whereIn('book', [STRIP_BOOK, STRIP_ENC_BOOK])->delete();
});

it('strips markers from nodes and preview blobs, bumps the timestamp, and skips encrypted books', function () {
    $marker = ' no-delete-id="please"';

    $this->seedLibrary(['book' => STRIP_BOOK, 'timestamp' => 1000]);
    $this->seedLibrary(['book' => STRIP_ENC_BOOK, 'encrypted' => true, 'timestamp' => 1000]);

    $this->seedNode([
        'book' => STRIP_BOOK, 'startLine' => 1,
        'content' => '<p id="1" data-node-id="x"' . $marker . ' style="min-height:1.5em;">hello</p>',
    ]);
    $this->seedNode([
        'book' => STRIP_BOOK, 'startLine' => 2,
        'content' => '<p id="2" data-node-id="y">already clean</p>',
    ]);
    $this->seedNode([
        'book' => STRIP_ENC_BOOK, 'startLine' => 1,
        'content' => '<p id="1"' . $marker . '>pretend-ciphertext</p>',
    ]);

    DB::connection('pgsql_admin')->table('footnotes')->updateOrInsert(
        ['book' => STRIP_BOOK, 'footnoteId' => 'Fn_strip_test'],
        [
            'content' => '<p>fn body</p>',
            'is_citation' => false,
            'preview_nodes' => json_encode([
                ['content' => '<p data-node-id="z"' . $marker . '>fn node</p>'],
            ]),
            'created_at' => now(), 'updated_at' => now(),
        ]
    );

    $this->artisan('content:strip-no-delete-markers', ['book' => STRIP_BOOK])
        ->expectsConfirmation('Strip markers across 1 book(s)?', 'yes')
        ->assertExitCode(0);

    $admin = DB::connection('pgsql_admin');

    $node1 = $admin->table('nodes')->where('book', STRIP_BOOK)->where('startLine', 1)->value('content');
    expect($node1)->not->toContain('no-delete-id')
        ->and($node1)->toContain('hello')
        ->and($node1)->toContain('data-node-id="x"');

    $fnPreview = $admin->table('footnotes')->where('book', STRIP_BOOK)->where('footnoteId', 'Fn_strip_test')->value('preview_nodes');
    expect($fnPreview)->not->toContain('no-delete-id')
        ->and($fnPreview)->toContain('fn node');

    expect((int) $admin->table('library')->where('book', STRIP_BOOK)->value('timestamp'))
        ->toBeGreaterThan(1000);

    // Encrypted book: content AND timestamp untouched, even when targeted.
    $this->artisan('content:strip-no-delete-markers', ['book' => STRIP_ENC_BOOK])
        ->assertExitCode(0);
    expect($admin->table('nodes')->where('book', STRIP_ENC_BOOK)->where('startLine', 1)->value('content'))
        ->toContain('no-delete-id');
    expect((int) $admin->table('library')->where('book', STRIP_ENC_BOOK)->value('timestamp'))->toBe(1000);
});

it('reports cleanly when there is nothing to strip', function () {
    $this->seedLibrary(['book' => STRIP_BOOK, 'timestamp' => 1000]);
    $this->seedNode(['book' => STRIP_BOOK, 'startLine' => 1, 'content' => '<p id="1">clean</p>']);

    $this->artisan('content:strip-no-delete-markers', ['book' => STRIP_BOOK])
        ->expectsOutputToContain('No no-delete-id markers found')
        ->assertExitCode(0);
});
