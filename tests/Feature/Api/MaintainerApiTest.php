<?php

/**
 * The /maintainer triage page + its API: admin-only everywhere (the web page
 * 404s for non-admins — its existence isn't advertised), the queue endpoint
 * mirrors library:reconvert-queue via the shared ReconvertQueue service, the
 * original-file endpoint streams the source for the side-by-side view, the
 * export endpoint hands down the dev case bundle, and the sweep emails ONE
 * summary per run.
 */

use App\Mail\SweepFlagsRaisedMail;
use App\Models\ConversionFlag;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Mail;

afterEach(function () {
    ConversionFlag::query()->where('book', 'like', 'apitest%')->delete();
    $this->cleanupApiFixtures();
});

// ── Gating ──

test('the /maintainer page 404s for guests and non-admins, renders for admins', function () {
    $this->get('/maintainer')->assertNotFound();

    $this->loginUser();
    $this->get('/maintainer')->assertNotFound();

    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer')->assertOk()->assertViewIs('maintainer')->assertSee('Maintainer');
});

test('every maintainer API endpoint is admin-gated', function () {
    $this->loginUser(); // authenticated but NOT admin
    $this->getJson('/api/maintainer/flags')->assertStatus(403);
    $this->postJson('/api/maintainer/flags/apitest_x/resolve', ['resolution' => 'dismissed'])->assertStatus(403);
    $this->getJson('/api/maintainer/original/apitest_x')->assertStatus(403);
    $this->getJson('/api/maintainer/export/apitest_x')->assertStatus(403);
});

// ── The queue endpoint ──

test('flags endpoint groups per book with artifacts + suggested action', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    $book = $this->makeBook($admin, ['visibility' => 'public', 'title' => 'Triage Me', 'conversion_method' => 'pdf_ocr_mistral']);
    ConversionFlag::raise($book, ConversionFlag::SOURCE_USER_REPORT, 'footnotes broken', ['issueTypes' => ['footnotes_not_matched']]);
    ConversionFlag::raise($book, ConversionFlag::SOURCE_AUTO_SWEEP, 'garbage sweep: block_page_phrase', ['signals' => ['block_page_phrase']]);

    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    file_put_contents("{$dir}/ocr_response.json", '{}');

    try {
        $entry = collect($this->getJson('/api/maintainer/flags')->assertOk()->json('entries'))
            ->firstWhere('book', $book);
        expect($entry)->not->toBeNull();
        expect($entry['title'])->toBe('Triage Me');
        expect($entry['suggested'])->toBe('reconvert'); // ocr cache on disk
        expect($entry['artifacts'])->toContain('ocr_response.json');
        expect(collect($entry['flags'])->pluck('source')->sort()->values()->all())
            ->toBe(['auto_sweep', 'user_report']);
    } finally {
        File::deleteDirectory($dir);
    }
});

test('resolve endpoint closes all open flags for the book', function () {
    $this->loginUser(['is_admin' => true]);
    ConversionFlag::raise('apitest_mtres', ConversionFlag::SOURCE_USER_REPORT, 'r');
    ConversionFlag::raise('apitest_mtres', ConversionFlag::SOURCE_AUTO_SWEEP, 's');

    $this->postJson('/api/maintainer/flags/apitest_mtres/resolve', ['resolution' => 'reconverted'])
        ->assertOk()->assertJson(['resolved' => 2]);

    expect(ConversionFlag::where('book', 'apitest_mtres')->where('status', 'open')->exists())->toBeFalse();

    $this->postJson('/api/maintainer/flags/apitest_mtres/resolve', ['resolution' => 'nonsense'])
        ->assertStatus(422);
});

// ── The original-file endpoint ──

test('original endpoint streams the PDF inline for the side-by-side view; 404 when absent', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    $book = $this->makeBook($admin, ['visibility' => 'public']);

    $this->getJson("/api/maintainer/original/{$book}")->assertStatus(404);

    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    file_put_contents("{$dir}/original.pdf", "%PDF-1.4 fake");

    try {
        $resp = $this->get("/api/maintainer/original/{$book}");
        $resp->assertOk();
        expect($resp->headers->get('Content-Type'))->toBe('application/pdf');
        expect($resp->headers->get('Content-Disposition'))->toContain('inline');
    } finally {
        File::deleteDirectory($dir);
    }
});

// ── The export endpoint ──

test('export endpoint builds and downloads the case bundle', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    $book = $this->makeBook($admin, ['visibility' => 'public', 'title' => 'Bundle Me']);

    $tarball = storage_path("app/book-exports/{$book}.tar.gz");
    try {
        $resp = $this->get("/api/maintainer/export/{$book}");
        $resp->assertOk();
        expect($resp->headers->get('Content-Disposition'))->toContain("{$book}.tar.gz");
        expect(is_file($tarball))->toBeTrue();
    } finally {
        @unlink($tarball);
    }
});

// ── Sweep alert email ──

test('flag-sweep sends ONE summary email for new flags, none on rerun or dry-run', function () {
    Mail::fake();
    $admin = $this->loginUser(['is_admin' => true]);
    $garbage = $this->makeBook($admin, ['visibility' => 'public', 'conversion_method' => 'pdf_ocr_mistral']);
    DB::connection('pgsql_admin')->table('nodes')->insert([
        'book' => $garbage, 'node_id' => "{$garbage}_g1", 'chunk_id' => 0, 'startLine' => 1,
        'content' => '<p>x</p>', 'plainText' => 'Access Check — unusual traffic activity, complete this reCAPTCHA.',
    ]);

    // Dry-run: no flags, no mail.
    Artisan::call('library:flag-sweep', ['--books' => $garbage, '--dry-run' => true]);
    Mail::assertNothingOutgoing();
    Mail::assertNothingQueued();

    // First real run: one summary mail, linking the maintainer page.
    Artisan::call('library:flag-sweep', ['--books' => $garbage]);
    Mail::assertQueued(SweepFlagsRaisedMail::class, function (SweepFlagsRaisedMail $mail) use ($garbage) {
        return count($mail->flagged) === 1 && $mail->flagged[0]['book'] === $garbage;
    });

    // Second run: flag upserts (already open) → NO second alert.
    Artisan::call('library:flag-sweep', ['--books' => $garbage]);
    Mail::assertQueuedCount(1);
});
