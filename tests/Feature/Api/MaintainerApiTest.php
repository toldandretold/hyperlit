<?php

/**
 * The /maintainer/conversion triage page + its API: admin-only everywhere (the web page
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
    DB::connection('pgsql_admin')->table('nodes')->where('book', 'like', 'apitest\_%')->delete();
    $this->cleanupApiFixtures();
});

/** Seed N nodes of junk (short) or prose (real-paragraph-length) text. */
function seedNodes(string $book, int $count, bool $prose): void
{
    $rows = [];
    for ($i = 1; $i <= $count; $i++) {
        $text = $prose
            ? str_repeat("The measured spectra of the silicon qubit devices continued to improve across successive fabrication runs, and the teams reported steadily longer coherence times in each publication. ", 3)
            : 'Access options · Institutional login';
        $rows[] = [
            'book' => $book, 'node_id' => "{$book}_n{$i}", 'chunk_id' => 0, 'startLine' => $i,
            'content' => '<p>' . $text . '</p>', 'plainText' => $text,
        ];
    }
    DB::connection('pgsql_admin')->table('nodes')->insert($rows);
}

// ── Gating ──

test('the /maintainer/conversion page 404s for guests and non-admins, renders for admins', function () {
    $this->get('/maintainer/conversion')->assertNotFound();

    $this->loginUser();
    $this->get('/maintainer/conversion')->assertNotFound();

    $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/conversion')->assertOk()->assertViewIs('maintainer')->assertSee('Maintainer');
});

test('every maintainer API endpoint is admin-gated', function () {
    $this->loginUser(); // authenticated but NOT admin
    $this->getJson('/api/maintainer/conversion/flags')->assertStatus(403);
    $this->postJson('/api/maintainer/conversion/flags/apitest_x/resolve', ['resolution' => 'dismissed'])->assertStatus(403);
    $this->postJson('/api/maintainer/conversion/flags/apitest_x/retract')->assertStatus(403);
    $this->getJson('/api/maintainer/conversion/original/apitest_x')->assertStatus(403);
    $this->getJson('/api/maintainer/conversion/export/apitest_x')->assertStatus(403);
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
        $entry = collect($this->getJson('/api/maintainer/conversion/flags')->assertOk()->json('entries'))
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

    $this->postJson('/api/maintainer/conversion/flags/apitest_mtres/resolve', ['resolution' => 'reconverted'])
        ->assertOk()->assertJson(['resolved' => 2]);

    expect(ConversionFlag::where('book', 'apitest_mtres')->where('status', 'open')->exists())->toBeFalse();

    $this->postJson('/api/maintainer/conversion/flags/apitest_mtres/resolve', ['resolution' => 'nonsense'])
        ->assertStatus(422);
});

// ── The retract endpoint (harvest false positives) ──

test('retract deletes a junk harvested version and closes its flags as retracted', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    $book = $this->makeBook($admin, ['visibility' => 'public', 'title' => 'Paywall Page', 'conversion_method' => 'html_scrape_unverified']);
    seedNodes($book, 2, prose: false); // landing-page junk: body absent
    ConversionFlag::raise($book, ConversionFlag::SOURCE_AUTO_SWEEP, 'no article body', ['issueTypes' => ['body_absent']]);

    $this->postJson("/api/maintainer/conversion/flags/{$book}/retract")
        ->assertOk()->assertJson(['retracted' => true, 'resolved' => 1]);

    $admin_db = DB::connection('pgsql_admin');
    expect($admin_db->table('library')->where('book', $book)->value('visibility'))->toBe('deleted');
    expect($admin_db->table('nodes')->where('book', $book)->count())->toBe(0);
    $flag = ConversionFlag::where('book', $book)->first();
    expect($flag->status)->toBe('resolved');
    expect($flag->resolution)->toBe('retracted');
});

test('retract refuses a body-present book without force — a flagged book can be real', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    $book = $this->makeBook($admin, ['visibility' => 'public', 'title' => 'Real Short Article', 'conversion_method' => 'html_scrape_unverified']);
    seedNodes($book, 6, prose: true); // ≥5 real paragraphs: body PRESENT
    ConversionFlag::raise($book, ConversionFlag::SOURCE_AUTO_SWEEP, 'suspect', ['issueTypes' => ['body_absent']]);

    $this->postJson("/api/maintainer/conversion/flags/{$book}/retract")
        ->assertStatus(422)->assertJson(['refusal' => 'body_present']);
    expect(DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('visibility'))->toBe('public');

    // The human eyeballed it and insists — force goes through.
    $this->postJson("/api/maintainer/conversion/flags/{$book}/retract", ['force' => true])
        ->assertOk()->assertJson(['retracted' => true]);
    expect(DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('visibility'))->toBe('deleted');
});

test('retract never touches a non-system-acquired book, even with force', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    $book = $this->makeBook($admin, ['visibility' => 'public', 'title' => 'My Own Upload', 'conversion_method' => 'pdf_ocr_mistral']);
    seedNodes($book, 2, prose: false);
    ConversionFlag::raise($book, ConversionFlag::SOURCE_USER_REPORT, 'looks broken');

    $this->postJson("/api/maintainer/conversion/flags/{$book}/retract", ['force' => true])
        ->assertStatus(422)->assertJson(['refusal' => 'not_system_acquired']);
    expect(DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('visibility'))->toBe('public');
    expect(ConversionFlag::where('book', $book)->where('status', 'open')->exists())->toBeTrue();
});

test('harvest:retract --flagged bulk-retracts junk, skips real books, and dry-run deletes nothing', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    $junk = $this->makeBook($admin, ['visibility' => 'public', 'title' => 'Junk A', 'conversion_method' => 'html_scrape_unverified']);
    $real = $this->makeBook($admin, ['visibility' => 'public', 'title' => 'Real B', 'conversion_method' => 'html_scrape_unverified']);
    seedNodes($junk, 2, prose: false);
    seedNodes($real, 6, prose: true);
    ConversionFlag::raise($junk, ConversionFlag::SOURCE_AUTO_SWEEP, 'no body', ['issueTypes' => ['body_absent']]);
    ConversionFlag::raise($real, ConversionFlag::SOURCE_AUTO_SWEEP, 'no body', ['issueTypes' => ['body_absent']]);

    $lib = fn (string $b) => DB::connection('pgsql_admin')->table('library')->where('book', $b)->value('visibility');

    Artisan::call('harvest:retract', ['--flagged' => true, '--dry-run' => true]);
    expect($lib($junk))->toBe('public'); // dry run touched nothing

    Artisan::call('harvest:retract', ['--flagged' => true, '--yes' => true]);
    expect($lib($junk))->toBe('deleted');
    expect($lib($real))->toBe('public'); // body-present → skipped, flag stays open
    expect(ConversionFlag::where('book', $junk)->where('status', 'open')->exists())->toBeFalse();
    expect(ConversionFlag::where('book', $real)->where('status', 'open')->exists())->toBeTrue();
});

// ── The original-file endpoint ──

test('original endpoint streams the PDF inline for the side-by-side view; 404 when absent', function () {
    $admin = $this->loginUser(['is_admin' => true]);
    $book = $this->makeBook($admin, ['visibility' => 'public']);

    $this->getJson("/api/maintainer/conversion/original/{$book}")->assertStatus(404);

    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    file_put_contents("{$dir}/original.pdf", "%PDF-1.4 fake");

    try {
        $resp = $this->get("/api/maintainer/conversion/original/{$book}");
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
        $resp = $this->get("/api/maintainer/conversion/export/{$book}");
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
