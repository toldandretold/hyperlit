<?php

/**
 * Security Tests: XSS (Cross-Site Scripting) Validation
 *
 * Tests for XSS prevention in user input fields.
 * Documents vulnerabilities in fields missing SafeString validation.
 */

use App\Models\User;
use App\Models\PgLibrary;
use App\Models\PgHyperlight;
use App\Models\PgNodeChunk;
use Illuminate\Support\Str;
use Illuminate\Support\Facades\DB;

dataset('xss_payloads', [
    'script_tag' => '<script>alert(1)</script>',
    'script_tag_encoded' => '&lt;script&gt;alert(1)&lt;/script&gt;',
    'img_onerror' => '<img src=x onerror=alert(1)>',
    'img_onerror_no_quotes' => '<img src=x onerror=alert(document.cookie)>',
    'svg_onload' => '<svg onload=alert(1)>',
    'svg_script' => '<svg><script>alert(1)</script></svg>',
    'javascript_url' => 'javascript:alert(1)',
    'javascript_url_encoded' => 'javascript&#58;alert(1)',
    'data_uri_xss' => 'data:text/html,<script>alert(1)</script>',
    'event_handler_onclick' => '<div onclick=alert(1)>click</div>',
    'event_handler_onmouseover' => '<a onmouseover=alert(1)>hover</a>',
    'event_handler_onfocus' => '<input onfocus=alert(1) autofocus>',
    'style_expression' => '<div style="background:url(javascript:alert(1))">',
    'body_onload' => '<body onload=alert(1)>',
    'iframe_src' => '<iframe src="javascript:alert(1)">',
    'object_data' => '<object data="javascript:alert(1)">',
    'embed_src' => '<embed src="javascript:alert(1)">',
    'form_action' => '<form action="javascript:alert(1)"><input type=submit>',
    'meta_refresh' => '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    'link_import' => '<link rel="import" href="javascript:alert(1)">',
    'base_href' => '<base href="javascript:alert(1)">',
    'math_xss' => '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    'template_xss' => '<template><script>alert(1)</script></template>',
]);

// =============================================================================
// LIBRARY METADATA XSS TESTS (VULNERABILITY: Missing SafeString validation)
// =============================================================================

test('library upsert should reject xss in title field', function (string $payload) {
    $user = User::factory()->create();

    $response = $this->actingAs($user)
        ->postJson('/api/db/library/upsert', [
            'data' => [
                'book' => 'xss-title-' . md5($payload),
                'title' => $payload,
            ],
        ]);

    // VULNERABILITY: Currently this passes (422 or 200)
    // After adding SafeString rule: Should return 422 for dangerous content
    if ($response->status() === 200 || $response->status() === 201) {
        $library = PgLibrary::where('book', 'xss-title-' . md5($payload))->first();
        if ($library) {
            // Dangerous content was stored - this is the vulnerability
            expect($library->title)->not->toMatch('/<script|onerror|onload|onclick|javascript:/i');
            // Clean up
            $library->delete();
        }
    }
})->with('xss_payloads');

test('library upsert should reject xss in author field', function (string $payload) {
    $user = User::factory()->create();

    $response = $this->actingAs($user)
        ->postJson('/api/db/library/upsert', [
            'data' => [
                'book' => 'xss-author-' . md5($payload),
                'title' => 'Safe Title',
                'author' => $payload,
            ],
        ]);

    if ($response->status() === 200 || $response->status() === 201) {
        $library = PgLibrary::where('book', 'xss-author-' . md5($payload))->first();
        if ($library) {
            expect($library->author)->not->toMatch('/<script|onerror|onload|onclick|javascript:/i');
            $library->delete();
        }
    }
})->with('xss_payloads');

test('library upsert should reject xss in journal field', function (string $payload) {
    $user = User::factory()->create();

    $response = $this->actingAs($user)
        ->postJson('/api/db/library/upsert', [
            'data' => [
                'book' => 'xss-journal-' . md5($payload),
                'title' => 'Safe Title',
                'journal' => $payload,
            ],
        ]);

    if ($response->status() === 200 || $response->status() === 201) {
        $library = PgLibrary::where('book', 'xss-journal-' . md5($payload))->first();
        if ($library) {
            expect($library->journal)->not->toMatch('/<script|onerror|onload|onclick|javascript:/i');
            $library->delete();
        }
    }
})->with('xss_payloads');

test('library upsert should reject xss in publisher field', function (string $payload) {
    $user = User::factory()->create();

    $response = $this->actingAs($user)
        ->postJson('/api/db/library/upsert', [
            'data' => [
                'book' => 'xss-publisher-' . md5($payload),
                'title' => 'Safe Title',
                'publisher' => $payload,
            ],
        ]);

    if ($response->status() === 200 || $response->status() === 201) {
        $library = PgLibrary::where('book', 'xss-publisher-' . md5($payload))->first();
        if ($library) {
            expect($library->publisher)->not->toMatch('/<script|onerror|onload|onclick|javascript:/i');
            $library->delete();
        }
    }
})->with('xss_payloads');

test('library upsert should reject xss in school field', function (string $payload) {
    $user = User::factory()->create();

    $response = $this->actingAs($user)
        ->postJson('/api/db/library/upsert', [
            'data' => [
                'book' => 'xss-school-' . md5($payload),
                'title' => 'Safe Title',
                'school' => $payload,
            ],
        ]);

    if ($response->status() === 200 || $response->status() === 201) {
        $library = PgLibrary::where('book', 'xss-school-' . md5($payload))->first();
        if ($library) {
            expect($library->school)->not->toMatch('/<script|onerror|onload|onclick|javascript:/i');
            $library->delete();
        }
    }
})->with('xss_payloads');

test('library upsert should reject xss in note field', function (string $payload) {
    $user = User::factory()->create();

    $response = $this->actingAs($user)
        ->postJson('/api/db/library/upsert', [
            'data' => [
                'book' => 'xss-note-' . md5($payload),
                'title' => 'Safe Title',
                'note' => $payload,
            ],
        ]);

    if ($response->status() === 200 || $response->status() === 201) {
        $library = PgLibrary::where('book', 'xss-note-' . md5($payload))->first();
        if ($library) {
            expect($library->note)->not->toMatch('/<script|onerror|onload|onclick|javascript:/i');
            $library->delete();
        }
    }
})->with('xss_payloads');

// =============================================================================
// HYPERLIGHT (HIGHLIGHT) XSS TESTS
// =============================================================================

test('hyperlight upsert validates highlighted text with SafeString', function (string $payload) {
    $user = User::factory()->create();

    // Create a test book first
    PgLibrary::firstOrCreate(
        ['book' => 'xss-highlight-test-book'],
        ['title' => 'Test Book', 'creator' => $user->name, 'visibility' => 'public']
    );

    $response = $this->actingAs($user)
        ->postJson('/api/db/hyperlights/upsert', [
            'data' => [[
                'book' => 'xss-highlight-test-book',
                'hyperlight_id' => 'xss-hl-' . md5($payload),
                'node_id' => 'n1',
                'highlightedText' => $payload,
            ]],
        ]);

    // HyperlightRequest uses SafeString (50,000 char limit)
    // Should reject dangerous content with 422
    if ($response->status() !== 422) {
        $highlight = PgHyperlight::where('hyperlight_id', 'xss-hl-' . md5($payload))->first();
        if ($highlight) {
            // If stored, should be sanitized
            expect($highlight->highlightedText)->not->toMatch('/<script|onerror|onload|onclick|javascript:/i');
            $highlight->delete();
        }
    }

    // Clean up book
    PgLibrary::where('book', 'xss-highlight-test-book')->delete();
})->with('xss_payloads');

test('hyperlight annotation field validates with SafeString', function (string $payload) {
    $user = User::factory()->create();

    PgLibrary::firstOrCreate(
        ['book' => 'xss-annotation-test-book'],
        ['title' => 'Test Book', 'creator' => $user->name, 'visibility' => 'public']
    );

    $response = $this->actingAs($user)
        ->postJson('/api/db/hyperlights/upsert', [
            'data' => [[
                'book' => 'xss-annotation-test-book',
                'hyperlight_id' => 'xss-annot-' . md5($payload),
                'node_id' => 'n1',
                'highlightedText' => 'Safe text',
                'annotation' => $payload,
            ]],
        ]);

    // Annotation uses SafeString (10,000 char limit)
    if ($response->status() !== 422) {
        $highlight = PgHyperlight::where('hyperlight_id', 'xss-annot-' . md5($payload))->first();
        if ($highlight) {
            expect($highlight->annotation)->not->toMatch('/<script|onerror|onload|onclick|javascript:/i');
            $highlight->delete();
        }
    }

    PgLibrary::where('book', 'xss-annotation-test-book')->delete();
})->with('xss_payloads');

// =============================================================================
// NODE CHUNK XSS TESTS (VULNERABILITY: No SafeString on content field)
// =============================================================================

test('node chunk content field should be sanitized', function (string $payload) {
    $user = User::factory()->create();

    PgLibrary::firstOrCreate(
        ['book' => 'xss-nodechunk-test'],
        ['title' => 'Test Book', 'creator' => $user->name, 'visibility' => 'public']
    );

    $response = $this->actingAs($user)
        ->postJson('/api/db/node-chunks/upsert', [
            'book' => 'xss-nodechunk-test',
            'nodes' => [[
                'node_id' => 'xss-node-' . md5($payload),
                'startLine' => 100,
                'content' => $payload,
                'plainText' => 'plain text version',
            ]],
        ]);

    // VULNERABILITY: NodeChunkUpsertRequest doesn't validate content with SafeString
    if ($response->status() === 200 || $response->status() === 201) {
        $chunk = PgNodeChunk::where('node_id', 'xss-node-' . md5($payload))->first();
        if ($chunk) {
            // Documents vulnerability: dangerous content may be stored
            expect($chunk->content)->not->toMatch('/<script|onerror|onload|onclick|javascript:/i');
            $chunk->delete();
        }
    }

    PgLibrary::where('book', 'xss-nodechunk-test')->delete();
})->with('xss_payloads');

// =============================================================================
// BULK CREATE XSS TESTS
// =============================================================================

test('library bulk create should validate all entries for xss', function () {
    $user = User::factory()->create();

    $response = $this->actingAs($user)
        ->postJson('/api/db/library/bulk-create', [
            'data' => [
                [
                    'book' => 'bulk-xss-test-1',
                    'title' => '<script>alert(1)</script>',
                ],
                [
                    'book' => 'bulk-xss-test-2',
                    'title' => 'Safe Title',
                    'author' => '<img onerror=alert(1) src=x>',
                ],
            ],
        ]);

    // Should reject the entire batch if any entry contains XSS
    expect($response->status())->toBeIn([400, 422]);

    // Clean up in case it passed
    PgLibrary::whereIn('book', ['bulk-xss-test-1', 'bulk-xss-test-2'])->delete();
});

// =============================================================================
// SPECIAL ENCODING BYPASS TESTS
// =============================================================================

test('xss detection handles unicode encoding bypass attempts', function () {
    $user = User::factory()->create();

    $unicodePayloads = [
        "\u003cscript\u003ealert(1)\u003c/script\u003e",
        "&#60;script&#62;alert(1)&#60;/script&#62;",
        "&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;",
        "\x3cscript\x3ealert(1)\x3c/script\x3e",
    ];

    foreach ($unicodePayloads as $payload) {
        $response = $this->actingAs($user)
            ->postJson('/api/db/library/upsert', [
                'data' => [
                    'book' => 'xss-unicode-' . md5($payload),
                    'title' => $payload,
                ],
            ]);

        if ($response->status() === 200) {
            $library = PgLibrary::where('book', 'xss-unicode-' . md5($payload))->first();
            if ($library) {
                // After decoding, should not contain script
                $decoded = html_entity_decode($library->title);
                expect(strtolower($decoded))->not->toContain('<script');
                $library->delete();
            }
        }
    }
});

test('xss detection handles case variation bypass attempts', function () {
    $user = User::factory()->create();

    $casePayloads = [
        '<ScRiPt>alert(1)</sCrIpT>',
        '<SCRIPT>alert(1)</SCRIPT>',
        '<sCRIPT>alert(1)</SCRipt>',
        '<IMG SRC=x ONERROR=alert(1)>',
        '<iMg OnErRoR=alert(1) sRc=x>',
    ];

    foreach ($casePayloads as $payload) {
        $response = $this->actingAs($user)
            ->postJson('/api/db/library/upsert', [
                'data' => [
                    'book' => 'xss-case-' . md5($payload),
                    'title' => $payload,
                ],
            ]);

        // SafeString patterns use /i flag for case-insensitive matching
        // But these fields don't use SafeString (vulnerability)
        if ($response->status() === 200) {
            $library = PgLibrary::where('book', 'xss-case-' . md5($payload))->first();
            if ($library) {
                expect($library->title)->not->toMatch('/<script|onerror|onload|onclick|javascript:/i');
                $library->delete();
            }
        }
    }
});

test('xss detection handles null byte injection', function () {
    $user = User::factory()->create();

    $nullBytePayloads = [
        "safe\x00<script>alert(1)</script>",
        "<script\x00>alert(1)</script>",
        "<img src=x\x00 onerror=alert(1)>",
    ];

    foreach ($nullBytePayloads as $payload) {
        $response = $this->actingAs($user)
            ->postJson('/api/db/library/upsert', [
                'data' => [
                    'book' => 'xss-null-' . md5($payload),
                    'title' => $payload,
                ],
            ]);

        if ($response->status() === 200) {
            $library = PgLibrary::where('book', 'xss-null-' . md5($payload))->first();
            if ($library) {
                $library->delete();
            }
        }
    }
});

// =============================================================================
// SEARCH QUERY XSS TESTS
// =============================================================================

test('search query is sanitized and does not reflect xss', function () {
    $xssQueries = [
        '<script>alert(1)</script>',
        '"><script>alert(1)</script>',
        "'-alert(1)-'",
        'javascript:alert(1)',
    ];

    foreach ($xssQueries as $query) {
        $response = $this->getJson('/api/search/library?' . http_build_query(['q' => $query]));

        // Response should not reflect the XSS payload unescaped
        $content = $response->getContent();
        expect($content)->not->toContain('<script>alert');
    }
});
