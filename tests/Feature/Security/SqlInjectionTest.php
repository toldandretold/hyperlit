<?php

/**
 * Security Tests: SQL Injection Prevention
 *
 * Tests for SQL injection prevention in database queries.
 * Verifies parameterized queries and input sanitization.
 */

use App\Models\User;
use App\Models\PgLibrary;
use Illuminate\Support\Facades\DB;

dataset('sql_injection_payloads', [
    'single_quote' => "test' OR '1'='1",
    'double_quote' => 'test" OR "1"="1',
    'semicolon_drop' => 'test; DROP TABLE library;--',
    'union_select' => "test' UNION SELECT * FROM users--",
    'union_all' => "' UNION ALL SELECT null,null,password FROM users--",
    'comment' => 'test--comment',
    'hash_comment' => 'test#comment',
    'multiline_comment' => 'test/**/OR/**/1=1',
    'null_byte' => "test\x00injection",
    'backslash' => 'test\\injection',
    'stacked_queries' => "test'; INSERT INTO users VALUES('hacked');--",
    'time_based_blind' => "test' AND SLEEP(5)--",
    'postgres_sleep' => "test'; SELECT pg_sleep(5);--",
    'boolean_blind_true' => "test' AND 1=1--",
    'boolean_blind_false' => "test' AND 1=2--",
    'error_based' => "test' AND CAST((SELECT version()) AS int)--",
    'hex_encoded' => "0x27204f522027313d2731",
]);

dataset('tsquery_injection_payloads', [
    'tsquery_and' => '& test',
    'tsquery_or' => '| test',
    'tsquery_not' => '! test',
    'tsquery_parens' => '( test )',
    'tsquery_followed_by' => '<-> test',
    'tsquery_distance' => '<3> test',
    'tsquery_weight' => 'test:*A',
    'tsquery_prefix' => ':* test',
    'tsquery_wildcard' => '*:*',
    'tsquery_empty' => '',
    'tsquery_special' => '& | ! ( ) <->',
]);

// =============================================================================
// SEARCH ENDPOINT SQL INJECTION TESTS
// =============================================================================

test('search library is immune to sql injection', function (string $payload) {
    $response = $this->getJson('/api/search/library?' . http_build_query(['q' => $payload]));

    // Should return valid response (200) or validation error, never 500 server error
    expect($response->status())->toBeLessThan(500);

    // Should not expose database errors in response
    $content = $response->getContent();
    expect(strtolower($content))->not->toContain('sql')
        ->not->toContain('syntax error')
        ->not->toContain('pgsql')
        ->not->toContain('postgresql');
})->with('sql_injection_payloads');

test('search nodes is immune to sql injection', function (string $payload) {
    $response = $this->getJson('/api/search/nodes?' . http_build_query(['q' => $payload]));

    expect($response->status())->toBeLessThan(500);

    $content = $response->getContent();
    expect(strtolower($content))->not->toContain('sql')
        ->not->toContain('syntax error')
        ->not->toContain('pgsql');
})->with('sql_injection_payloads');

test('search handles tsquery special characters safely', function (string $payload) {
    $response = $this->getJson('/api/search/library?' . http_build_query(['q' => $payload]));

    // tsquery operators should be handled without crashing
    expect($response->status())->toBeLessThan(500);
})->with('tsquery_injection_payloads');

test('search handles tsquery injection in nodes endpoint', function (string $payload) {
    $response = $this->getJson('/api/search/nodes?' . http_build_query(['q' => $payload]));

    expect($response->status())->toBeLessThan(500);
})->with('tsquery_injection_payloads');

// =============================================================================
// BOOK ID PARAMETER INJECTION TESTS
// =============================================================================

test('book id parameter is sanitized against injection', function () {
    $maliciousIds = [
        "test'; DROP TABLE library;--",
        'test" OR 1=1--',
        "test' UNION SELECT * FROM users--",
        '../../../etc/passwd',
        'test<script>alert(1)</script>',
        "test\x00injection",
        'test; SELECT pg_sleep(5);--',
    ];

    foreach ($maliciousIds as $id) {
        $response = $this->getJson("/api/database-to-indexeddb/books/{$id}/data");

        // Should return 404 (not found), 422 (validation), or 400 (bad request)
        // Never 500 (server error indicating injection worked)
        expect($response->status())->toBeIn([400, 404, 422]);

        // Should not leak database error details
        $content = $response->getContent();
        expect(strtolower($content))->not->toContain('syntax error')
            ->not->toContain('pgsql');
    }
});

// =============================================================================
// LIBRARY UPSERT SQL INJECTION TESTS
// =============================================================================

test('library upsert book id is sanitized', function (string $payload) {
    $user = User::factory()->create();

    $response = $this->actingAs($user)
        ->postJson('/api/db/library/upsert', [
            'data' => [
                'book' => $payload,
                'title' => 'Test Title',
            ],
        ]);

    // Should either reject with validation error or sanitize
    // Should not cause server error
    expect($response->status())->toBeLessThan(500);
})->with('sql_injection_payloads');

test('library title field uses parameterized queries', function () {
    $user = User::factory()->create();

    $payload = "Test'; DELETE FROM library;--";

    $response = $this->actingAs($user)
        ->postJson('/api/db/library/upsert', [
            'data' => [
                'book' => 'sql-test-title',
                'title' => $payload,
            ],
        ]);

    // The title should be stored literally, not executed as SQL
    if ($response->status() === 200) {
        $library = PgLibrary::where('book', 'sql-test-title')->first();
        if ($library) {
            expect($library->title)->toBe($payload);
            $library->delete();
        }
    }
});

// =============================================================================
// HIGHLIGHT/HYPERCITE SQL INJECTION TESTS
// =============================================================================

test('hyperlight upsert uses parameterized queries', function (string $payload) {
    $user = User::factory()->create();

    PgLibrary::firstOrCreate(
        ['book' => 'sql-highlight-test'],
        ['title' => 'Test', 'creator' => $user->name, 'visibility' => 'public']
    );

    $response = $this->actingAs($user)
        ->postJson('/api/db/hyperlights/upsert', [
            'data' => [[
                'book' => 'sql-highlight-test',
                'hyperlight_id' => 'sql-hl-test',
                'node_id' => 'n1',
                'highlightedText' => $payload,
            ]],
        ]);

    expect($response->status())->toBeLessThan(500);

    // Clean up
    DB::table('hyperlights')->where('hyperlight_id', 'sql-hl-test')->delete();
    PgLibrary::where('book', 'sql-highlight-test')->delete();
})->with('sql_injection_payloads');

test('hypercite upsert uses parameterized queries', function (string $payload) {
    $user = User::factory()->create();

    PgLibrary::firstOrCreate(
        ['book' => 'sql-cite-test'],
        ['title' => 'Test', 'creator' => $user->name, 'visibility' => 'public']
    );

    $response = $this->actingAs($user)
        ->postJson('/api/db/hypercites/upsert', [
            'data' => [[
                'book' => 'sql-cite-test',
                'hypercite_id' => 'sql-cite-id',
                'node_id' => 'n1',
                'hypercitedText' => $payload,
            ]],
        ]);

    expect($response->status())->toBeLessThan(500);

    // Clean up
    DB::table('hypercites')->where('hypercite_id', 'sql-cite-id')->delete();
    PgLibrary::where('book', 'sql-cite-test')->delete();
})->with('sql_injection_payloads');

// =============================================================================
// SECOND ORDER SQL INJECTION TESTS
// =============================================================================

test('stored data is safe when used in subsequent queries', function () {
    $user = User::factory()->create();

    // Store potentially dangerous data
    $maliciousTitle = "Test'; DROP TABLE users;--";

    PgLibrary::create([
        'book' => 'second-order-test',
        'title' => $maliciousTitle,
        'creator' => $user->name,
        'visibility' => 'public',
    ]);

    // Use that stored data in a search
    $response = $this->getJson('/api/search/library?q=' . urlencode($maliciousTitle));

    // Should not cause server error
    expect($response->status())->toBeLessThan(500);

    // Verify users table still exists
    expect(User::count())->toBeGreaterThan(0);

    // Clean up
    PgLibrary::where('book', 'second-order-test')->delete();
});

// =============================================================================
// ORDER BY / COLUMN NAME INJECTION TESTS
// =============================================================================

test('search config parameter uses whitelist validation', function () {
    $maliciousConfigs = [
        'english; DROP TABLE library;--',
        "simple' OR '1'='1",
        'german', // Valid language but not in whitelist
        '../../../etc/passwd',
    ];

    foreach ($maliciousConfigs as $config) {
        $response = $this->getJson('/api/search/library?q=test&config=' . urlencode($config));

        // Should use default config or reject, not crash
        expect($response->status())->toBeLessThan(500);
    }
});

// =============================================================================
// LIMIT / OFFSET INJECTION TESTS
// =============================================================================

test('pagination parameters are validated', function () {
    $maliciousValues = [
        'limit' => ["1; DROP TABLE library;--", "-1", "999999999", "abc"],
        'offset' => ["0; SELECT * FROM users;--", "-1", "999999999", "abc"],
    ];

    foreach ($maliciousValues['limit'] as $limit) {
        $response = $this->getJson("/api/search/library?q=test&limit={$limit}");
        expect($response->status())->toBeLessThan(500);
    }

    foreach ($maliciousValues['offset'] as $offset) {
        $response = $this->getJson("/api/search/library?q=test&offset={$offset}");
        expect($response->status())->toBeLessThan(500);
    }
});

// =============================================================================
// ERROR MESSAGE INFORMATION DISCLOSURE
// =============================================================================

test('database errors do not leak sensitive information', function () {
    // Force a potential error with invalid data
    $response = $this->getJson('/api/search/library?q=' . str_repeat('a', 10000));

    $content = $response->getContent();

    // Should not leak database details
    expect(strtolower($content))->not->toContain('pgsql')
        ->not->toContain('postgresql')
        ->not->toContain('pg_')
        ->not->toContain('column')
        ->not->toContain('relation')
        ->not->toContain('table')
        ->not->toContain('/var/')
        ->not->toContain('vendor/')
        ->not->toContain('.php');
});

test('api errors return generic messages', function () {
    $user = User::factory()->create();

    // Try to upsert with invalid structure
    $response = $this->actingAs($user)
        ->postJson('/api/db/library/upsert', [
            'data' => 'not-an-array',
        ]);

    $content = $response->json();

    // Error messages should be generic
    if (isset($content['message'])) {
        expect(strtolower($content['message']))->not->toContain('pgsql')
            ->not->toContain('sql');
    }
});
