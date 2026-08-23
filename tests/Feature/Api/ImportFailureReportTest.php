<?php

/**
 * The import-failure "Send report" flow (POST /api/integrity/import-failure
 * → ImportFailureReportMail → fml@hyperlit.io) is the last resort when an
 * import dies — it must never itself fail silently.
 *
 * Regressions guarded here:
 *  - The mailable used to `finally { @unlink($storedPath) }` in build(), but
 *    Symfony reads attachments LAZILY at render time, so every file-bearing
 *    report threw in the queue worker after responding 200. build() must
 *    leave the file on disk (orphans are swept by uploads:clean-import-failures).
 *  - The mailable carries its own $tries/$backoff because the default-queue
 *    worker runs --tries=1, which would one-shot this diagnostic email on any
 *    transient SMTP hiccup.
 */

use App\Mail\ImportFailureReportMail;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Mail;

afterEach(fn () => $this->cleanupApiFixtures());

test('POST /api/integrity/import-failure accepts a report without a file', function () {
    Mail::fake();
    $this->loginUser();
    $this->postJson('/api/integrity/import-failure', [
        'bookId' => 'apitest_book',
        'errorMessage' => 'poll_failure: Unique violation …',
        'status' => 'poll_failure',
        'source' => 'poll_failure',
    ])->assertStatus(200)->assertJson(['status' => 'received']);

    Mail::assertQueued(ImportFailureReportMail::class);
});

test('report with an uploaded file stores it and queues the mail with the path', function () {
    Mail::fake();
    $this->loginUser();

    $this->post('/api/integrity/import-failure', [
        'bookId' => 'apitest_book',
        'status' => 'pre_conversion',
        'source' => 'pre_conversion',
        'original' => UploadedFile::fake()->create('broken.pdf', 64),
    ])->assertStatus(200);

    $storedPath = null;
    Mail::assertQueued(ImportFailureReportMail::class, function ($mail) use (&$storedPath) {
        $storedPath = $mail->data['storedUploadPath'] ?? null;

        return $storedPath
            && str_starts_with($storedPath, storage_path('app/import-failure-uploads/'))
            && ($mail->data['uploadedFilename'] ?? null) === 'broken.pdf';
    });
    expect($storedPath)->not->toBeNull();
    expect(File::exists($storedPath))->toBeTrue();

    File::delete($storedPath);
});

test('mailable build() does NOT delete the stored upload (lazy attach bug)', function () {
    $tmp = tempnam(sys_get_temp_dir(), 'ifm_');
    file_put_contents($tmp, 'fake pdf bytes');

    try {
        (new ImportFailureReportMail([
            'bookId' => 'apitest_book',
            'status' => 'poll_failure',
            'storedUploadPath' => $tmp,
            'uploadedFilename' => 'broken.pdf',
            'recentLogs' => [],
        ]))->build();

        // build() returning must leave the file for render time + queue:retry.
        expect(file_exists($tmp))->toBeTrue();
    } finally {
        @unlink($tmp);
    }
});

test('mailable carries its own retry budget (worker runs --tries=1)', function () {
    $mail = new ImportFailureReportMail([]);
    expect($mail->tries)->toBe(3);
    expect($mail->backoff)->toBe([30, 120]);
});
