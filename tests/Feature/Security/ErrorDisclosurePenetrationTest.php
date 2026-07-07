<?php

/**
 * Penetration Tests: Error Message Information Disclosure
 *
 * Several controllers return raw $e->getMessage() in error responses, which
 * can leak database internals (SQL syntax errors, table names, column names,
 * file paths) to the client. The global exception handler in bootstrap/app.php
 * sanitises 500 errors in production, but controllers that catch exceptions
 * themselves and return $e->getMessage() bypass that sanitisation.
 *
 * Vulnerable controllers found:
 *  - NodeHistoryController (7 error paths return $e->getMessage())
 *  - ScrapeController (returns $e->getMessage() in server errors)
 */

use Illuminate\Support\Facades\DB;

// =============================================================================
// NodeHistoryController — leaks exception messages in error responses
// =============================================================================

it('NodeHistoryController error responses do not include raw exception messages', function () {
    // Verify the source code pattern: the controller no longer returns $e->getMessage()
    $source = file_get_contents(app_path('Http/Controllers/NodeHistoryController.php'));

    // FIXED: all 8 error response paths now return only a generic 'message',
    // without the raw 'error' => $e->getMessage() that leaked DB internals.
    // (The Log::error() calls still include $e->getMessage() server-side — that's correct.)
    $responseErrorCount = 0;
    // Count 'error' => $e->getMessage() that appear in response()->json blocks,
    // not in Log::error blocks. The pattern in responses was always:
    //   'message' => 'Failed to ...',
    //   'error' => $e->getMessage(),
    // After the fix, the 'error' line is gone from all response blocks.
    preg_match_all("/'message' => 'Failed to[^}]+}/", $source, $matches);
    foreach ($matches[0] ?? [] as $block) {
        if (str_contains($block, "'error' => \$e->getMessage()")) {
            $responseErrorCount++;
        }
    }

    expect($responseErrorCount)->toBe(0);
});

it('NodeHistoryController getSnapshots does not leak DB error on malformed timestamp', function () {
    $user = $this->seedUser();

    $this->seedLibrary([
        'book' => 'error-disclosure-test',
        'title' => 'Test',
        'creator' => $user->name,
        'creator_token' => $user->user_token,
        'visibility' => 'public',
    ]);

    $this->seedNode([
        'book' => 'error-disclosure-test',
        'startLine' => 100,
        'node_id' => 'err_disc_n1',
        'content' => '<p>text</p>',
        'plainText' => 'text',
        'type' => 'p',
    ]);

    // Hit the timemachine-data endpoint with a malformed timestamp that will
    // cause a Postgres error on the ::timestamptz cast.
    $this->actingAs($user);
    $response = $this->getJson('/api/books/error-disclosure-test/timemachine-data?at=INVALID_TIMESTAMP');

    // Should be 500 or 400, but the error message must NOT leak DB internals.
    $content = strtolower($response->getContent());

    // Check for definitive DB-error leak markers.
    // VULNERABILITY: The controller returns $e->getMessage() which for a
    // Postgres timestamp cast error includes the raw SQL error.
    expect($content)->not->toContain('sqlstate')
        ->not->toContain('syntax error')
        ->not->toContain('pdoexception')
        ->not->toContain('timestamptz')
        ->not->toContain('pg_')
        ->not->toContain('postgres');
});

it('NodeHistoryController restore error does not leak DB internals', function () {
    $user = $this->seedUser();

    $this->seedLibrary([
        'book' => 'restore-error-test',
        'title' => 'Test',
        'creator' => $user->name,
        'creator_token' => $user->user_token,
        'visibility' => 'public',
    ]);

    $this->actingAs($user);

    // Try to restore with a malformed history_id that could trigger a DB error
    $response = $this->postJson('/api/nodes/restore-error-test/n1/restore', [
        'history_id' => "'; DROP TABLE nodes;--",
    ]);

    $content = strtolower($response->getContent());

    expect($content)->not->toContain('sqlstate')
        ->not->toContain('syntax error')
        ->not->toContain('pdoexception')
        ->not->toContain('drop table')
        ->not->toContain('pg_');
});

// =============================================================================
// ScrapeController — leaks exception message in server error
// =============================================================================

it('ScrapeController server error does not include exception message', function () {
    $source = file_get_contents(app_path('Http/Controllers/ScrapeController.php'));

    // FIXED: serverError() calls now pass only a generic message.
    // The $e->getMessage() is logged server-side but NOT returned to the client.
    expect($source)->not->toContain("serverError('Failed to fetch chapter list: ' . \$e->getMessage())")
        ->not->toContain("serverError('Failed to fetch chapter: ' . \$e->getMessage())");
});

// =============================================================================
// Global exception handler — verify production sanitisation works
// =============================================================================

it('global exception handler sanitises 500 errors in production', function () {
    $source = file_get_contents(base_path('bootstrap/app.php'));

    // The handler replaces the message with a generic one for 500 errors
    // when APP_DEBUG is false.
    expect($source)->toContain("'An unexpected error occurred'")
        ->and($source)->toContain('config(\'app.debug\')');
});

it('validation errors are safe to expose (422 responses)', function () {
    $user = $this->seedUser();
    $this->actingAs($user);

    // Send a request with missing required fields to trigger a 422.
    $response = $this->postJson('/api/db/library/upsert', [
        'data' => 'not-an-array',
    ]);

    // 422 validation errors SHOULD include field names and validation rules —
    // that's safe and helpful. They should NOT include DB internals.
    expect($response->status())->toBe(422);

    $content = strtolower($response->getContent());
    expect($content)->not->toContain('sqlstate')
        ->not->toContain('pdoexception')
        ->not->toContain('pg_');
});
