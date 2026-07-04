<?php

use Illuminate\Support\Facades\DB;

/**
 * hyperlights.annotation was varchar(1000); ciphertext of a legal 1000-char
 * annotation is ~1.4k chars. The column is now text — pin that long envelope
 * values are accepted.
 */
it('accepts an annotation envelope longer than the old varchar(1000) limit', function () {
    $user = $this->seedUser();
    $this->seedLibrary([
        'book' => 'e2ee_longnote',
        'creator' => $user->name,
        'creator_token' => $user->user_token,
        'visibility' => 'private',
    ]);

    $longAnnotation = 'hlenc.v1.aBcD-_12.'.str_repeat('Y3Q-_9aZ', 200); // ~1.6k chars

    $this->seedHyperlight([
        'book' => 'e2ee_longnote',
        'hyperlight_id' => 'hl_long',
        'node_id' => ['n1'],
        'charData' => [],
        'creator' => $user->name,
        'annotation' => $longAnnotation,
        'highlightedText' => 'x',
        'highlightedHTML' => 'x',
    ]);

    $stored = DB::connection('pgsql_admin')->table('hyperlights')
        ->where('book', 'e2ee_longnote')->where('hyperlight_id', 'hl_long')->value('annotation');
    expect($stored)->toBe($longAnnotation)
        ->and(strlen($stored))->toBeGreaterThan(1000);
});
