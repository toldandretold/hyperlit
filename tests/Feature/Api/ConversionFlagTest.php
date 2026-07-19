<?php

/**
 * The bad-conversion queue (conversion_flags): user reports land on it,
 * the garbage sweep fills it, the queue command resolves it, and the
 * book:export/book:import case bundle round-trips a book losslessly.
 * This is the maintainer human-in-the-loop pipeline's Phase 1 plumbing.
 */

use App\Models\ConversionFlag;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;

function cfAdmin()
{
    return DB::connection('pgsql_admin');
}

afterEach(function () {
    ConversionFlag::query()->where('book', 'like', 'apitest%')->delete();
    $this->cleanupApiFixtures();
});

// ── User reports feed the queue ──

test('conversion-feedback rating=bad raises an open user_report flag', function () {
    Mail::fake();
    $user = $this->loginUser();
    $book = $this->makeBook($user);

    $this->postJson('/api/integrity/conversion-feedback', [
        'bookId'     => $book,
        'rating'     => 'bad',
        'issueTypes' => ['footnotes_not_matched'],
        'comment'    => 'footnotes point at the wrong definitions',
    ])->assertStatus(200);

    $flag = ConversionFlag::where('book', $book)->where('status', 'open')->first();
    expect($flag)->not->toBeNull();
    expect($flag->source)->toBe('user_report');
    expect($flag->reason)->toBe('footnotes point at the wrong definitions');
    expect($flag->details['issueTypes'])->toBe(['footnotes_not_matched']);
    expect($flag->details['report_count'])->toBe(1);
});

test('repeat bad reports UPSERT the one open flag (report_count bumps)', function () {
    Mail::fake();
    $user = $this->loginUser();
    $book = $this->makeBook($user);

    foreach (['first complaint', 'second complaint'] as $comment) {
        $this->postJson('/api/integrity/conversion-feedback', [
            'bookId' => $book, 'rating' => 'bad', 'comment' => $comment,
        ])->assertStatus(200);
    }

    $open = ConversionFlag::where('book', $book)->where('status', 'open')->get();
    expect($open)->toHaveCount(1);
    expect($open[0]->details['report_count'])->toBe(2);
    expect($open[0]->reason)->toBe('second complaint'); // freshest complaint wins
});

test('conversion-feedback rating=good raises NO flag', function () {
    Mail::fake();
    $user = $this->loginUser();
    $book = $this->makeBook($user);

    $this->postJson('/api/integrity/conversion-feedback', [
        'bookId' => $book, 'rating' => 'good',
    ])->assertStatus(200);

    expect(ConversionFlag::where('book', $book)->exists())->toBeFalse();
});

// ── The garbage sweep ──

test('flag-sweep flags a block-page book and skips a healthy one', function () {
    $user = $this->loginUser();
    // A "converted" book whose content is a CAPTCHA wall (the JSTOR case).
    $garbage = $this->makeBook($user, ['visibility' => 'public', 'conversion_method' => 'pdf_ocr_mistral']);
    cfAdmin()->table('nodes')->insert([
        ['book' => $garbage, 'node_id' => "{$garbage}_g1", 'chunk_id' => 0, 'startLine' => 1,
         'content' => '<p>Access Check</p>', 'plainText' => 'Access Check'],
        ['book' => $garbage, 'node_id' => "{$garbage}_g2", 'chunk_id' => 0, 'startLine' => 2,
         'content' => '<p>x</p>', 'plainText' => 'Our systems have detected unusual traffic activity from your network. Please complete this reCAPTCHA.'],
    ]);

    // A healthy converted book: plenty of prose, no block phrases.
    $healthy = $this->makeBook($user, ['visibility' => 'public', 'conversion_method' => 'pdf_ocr_mistral']);
    $rows = [];
    foreach (range(1, 12) as $i) {
        $text = "Paragraph {$i}: " . Str::random(30) . ' the political economy of scholarly publishing considered at length, '
            . 'with sustained argument and citations to the relevant literature across several pages of continuous prose.';
        $rows[] = ['book' => $healthy, 'node_id' => "{$healthy}_h{$i}", 'chunk_id' => 0, 'startLine' => $i,
            'content' => "<p>{$text}</p>", 'plainText' => $text];
    }
    cfAdmin()->table('nodes')->insert($rows);

    // Dry-run: reports but writes nothing.
    Artisan::call('library:flag-sweep', ['--books' => "{$garbage},{$healthy}", '--dry-run' => true]);
    expect(ConversionFlag::whereIn('book', [$garbage, $healthy])->exists())->toBeFalse();

    // Real run: garbage flagged, healthy untouched.
    Artisan::call('library:flag-sweep', ['--books' => "{$garbage},{$healthy}"]);
    $flag = ConversionFlag::where('book', $garbage)->where('status', 'open')->first();
    expect($flag)->not->toBeNull();
    expect($flag->source)->toBe('auto_sweep');
    expect(implode(',', $flag->details['signals']))->toContain('block_page_phrase');
    expect(ConversionFlag::where('book', $healthy)->exists())->toBeFalse();
});

// ── Queue resolution ──

test('reconvert-queue --resolve closes all open flags with the resolution', function () {
    ConversionFlag::raise('apitest_qbook', ConversionFlag::SOURCE_USER_REPORT, 'r1');
    ConversionFlag::raise('apitest_qbook', ConversionFlag::SOURCE_AUTO_SWEEP, 'r2');

    Artisan::call('library:reconvert-queue', ['--resolve' => 'apitest_qbook', '--resolution' => 'reconverted']);

    $flags = ConversionFlag::where('book', 'apitest_qbook')->get();
    expect($flags)->toHaveCount(2);
    foreach ($flags as $flag) {
        expect($flag->status)->toBe('resolved');
        expect($flag->resolution)->toBe('reconverted');
        expect($flag->resolved_at)->not->toBeNull();
    }
});

// ── Admin reconvert bypass (the maintainer trigger) ──

test('a plain non-owner user cannot reconvert; an admin can (maintainer bypass)', function () {
    \Illuminate\Support\Facades\Queue::fake();
    Mail::fake();

    $owner = $this->apiUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);

    // The book needs a source artifact for reconvert to proceed past the gate.
    $artifactDir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($artifactDir);
    file_put_contents("{$artifactDir}/original.md", "# Source\n\nBody.\n");

    try {
        // Stranger: hard 403.
        $this->loginUser();
        $this->postJson("/api/books/{$book}/reconvert")->assertStatus(403);

        // Admin (≠ owner): passes the gate and dispatches the job.
        $this->loginUser(['is_admin' => true]);
        $this->postJson("/api/books/{$book}/reconvert")
            ->assertStatus(200)
            ->assertJson(['success' => true, 'status' => 'processing']);
        \Illuminate\Support\Facades\Queue::assertPushed(\App\Jobs\ProcessDocumentImportJob::class);

        // reconvert-info advertises the capability to admins only.
        expect($this->getJson("/api/books/{$book}/reconvert-info")->json('canAdminReconvert'))->toBeTrue();
        $this->loginUser();
        expect($this->getJson("/api/books/{$book}/reconvert-info")->json('canAdminReconvert'))->toBeFalse();
    } finally {
        File::deleteDirectory($artifactDir);
    }
});

// ── The case bundle round-trip ──

test('book:export → book:import --force round-trips a book losslessly', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user, ['visibility' => 'public', 'title' => 'Export Roundtrip']);
    cfAdmin()->table('nodes')->insert([
        ['book' => $book, 'node_id' => "{$book}_n1", 'chunk_id' => 0, 'startLine' => 1,
         'content' => '<p>Alpha</p>', 'plainText' => 'Alpha'],
        ['book' => $book, 'node_id' => "{$book}_n2", 'chunk_id' => 0, 'startLine' => 2,
         'content' => '<p>Beta</p>', 'plainText' => 'Beta'],
    ]);
    cfAdmin()->table('hyperlights')->insert([
        'book' => $book, 'hyperlight_id' => 'hl_export_rt', 'node_id' => json_encode(["{$book}_n1"]),
        'charData' => json_encode(["{$book}_n1" => ['charStart' => 0, 'charEnd' => 5]]),
        'highlightedText' => 'Alpha', 'creator' => $user->name, 'time_since' => 1,
        'raw_json' => json_encode([]),
    ]);
    ConversionFlag::raise($book, ConversionFlag::SOURCE_MANUAL, 'travel with the bundle');

    // Artifacts on disk travel too.
    $artifactDir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($artifactDir);
    file_put_contents("{$artifactDir}/ocr_response.json", '{"pages": []}');

    $out = storage_path("app/book-exports/{$book}.tar.gz");
    try {
        Artisan::call('book:export', ['book' => $book]);
        expect(is_file($out))->toBeTrue();

        // Mutate, then --force import must restore the exported state.
        cfAdmin()->table('nodes')->where('book', $book)->delete();
        File::deleteDirectory($artifactDir);

        Artisan::call('book:import', ['archive' => $out, '--force' => true]);

        expect(cfAdmin()->table('nodes')->where('book', $book)->count())->toBe(2);
        $hl = cfAdmin()->table('hyperlights')->where('book', $book)->first();
        expect($hl->highlightedText)->toBe('Alpha');
        expect($hl->creator_token)->toBeNull(); // scrubbed on import
        expect(ConversionFlag::where('book', $book)->count())->toBe(1);
        expect(is_file("{$artifactDir}/ocr_response.json"))->toBeTrue();
        expect(cfAdmin()->table('library')->where('book', $book)->value('title'))->toBe('Export Roundtrip');
    } finally {
        @unlink($out);
        File::deleteDirectory($artifactDir);
        cfAdmin()->table('hyperlights')->where('book', $book)->delete();
    }
});
