<?php

/**
 * PDF import billing from QUEUE-WORKER context (docs/billing.md).
 *
 * The regression this locks: ProcessDocumentImportJob used to look the user up
 * on the DEFAULT connection, where a queue worker has NO RLS session vars —
 * users_select_policy (app.current_user AND app.current_token) matched zero
 * rows, User::find returned null, and billing silently never happened. Every
 * async PDF import went unbilled until 2026-07. These tests run the job's
 * billing paths with the session vars explicitly CLEARED (a faithful worker
 * simulation) and assert the charge actually lands.
 *
 * Also covers BILLING_CHARGE_OCR_ON_FAILED_IMPORT: default OFF = a failed
 * import writes no debit; ON = failed() bills the OCR that actually ran
 * (marker-idempotent, no-op when OCR never happened).
 */

use App\Jobs\ProcessDocumentImportJob;
use App\Models\User;
use App\Services\BillingService;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\MetadataExtractor;
use App\Services\DocumentImport\Processors\DocxProcessor;
use App\Services\DocumentImport\Processors\EpubProcessor;
use App\Services\DocumentImport\Processors\HtmlProcessor;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use App\Services\DocumentImport\Processors\PdfProcessor;
use App\Services\DocumentImport\Processors\ZipProcessor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

/** Faithful worker simulation: the connection has NO RLS session vars. */
function importBillingClearRlsVars(): void
{
    foreach (['app.current_user', 'app.current_token', 'app.session_id'] as $var) {
        DB::statement("SELECT set_config(?, '', false)", [$var]);
    }
}

/** Read the user's ledger the way middleware-context code would. */
function importBillingLedger(User $user, string $category)
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);

    return DB::table('billing_ledger')
        ->where('user_id', $user->id)->where('category', $category)->get();
}

function importBillingBookDir(string $book): string
{
    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);

    return $dir;
}

function importBillingSeedOcrCache(string $dir, int $pages = 4, string $model = 'mistral-ocr-2512'): void
{
    File::put("{$dir}/ocr_response.json", json_encode([
        'model' => $model,
        'pages' => array_map(fn ($i) => ['index' => $i], range(0, $pages - 1)),
    ]));
}

/** A PdfProcessor that "converts" instantly — the OCR cache is already seeded. */
function importBillingFakePdfProcessor(): PdfProcessor
{
    return new class extends PdfProcessor
    {
        public function __construct() {}

        public function setProgressCallback(\Closure $callback): void {}

        public function process(string $inputPath, string $outputPath, string $bookId): void
        {
            File::put("{$outputPath}/nodes.jsonl", json_encode([
                'content' => '<p>Billing test paragraph.</p>',
                'plainText' => 'Billing test paragraph.',
                'type' => 'text',
            ])."\n");
        }
    };
}

beforeEach(function () {
    $this->mock(\App\Http\Controllers\UserHomeServerController::class, function ($mock) {
        $mock->shouldReceive('generateAccountBook')->andReturnNull();
    });
});

it('bills the OCR from a worker context with no RLS session vars (the silent-no-op regression)', function () {
    Queue::fake();

    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $book = 'book_billworker_'.Str::lower(Str::random(8));
    $this->seedLibrary(['book' => $book, 'creator' => $user->name, 'creator_token' => $user->user_token, 'visibility' => 'private']);

    $dir = importBillingBookDir($book);
    importBillingSeedOcrCache($dir, pages: 4); // 4/1000 × $2.00 = $0.008 raw
    File::put("{$dir}/original.pdf", '%PDF-fake');

    importBillingClearRlsVars();

    try {
        $job = new ProcessDocumentImportJob($book, 'pdf', $user->id, [], []);
        $job->handle(
            app(EpubProcessor::class),
            app(MarkdownProcessor::class),
            app(HtmlProcessor::class),
            importBillingFakePdfProcessor(),
            app(DocxProcessor::class),
            app(ZipProcessor::class),
            app(FileHelpers::class),
            app(BillingService::class),
            app(MetadataExtractor::class),
        );

        // The conversion completed…
        $progress = json_decode(File::get("{$dir}/progress.json"), true);
        expect($progress['status'])->toBe('complete');

        // …AND the charge landed despite the empty worker context: $0.008 × 1.5.
        $rows = importBillingLedger($user, 'ocr');
        expect($rows)->toHaveCount(1);
        expect((float) $rows[0]->amount)->toEqualWithDelta(0.008 * 1.5, 0.0001);
        expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.008 * 1.5, 0.0001);

        // Idempotency marker written, so a retry can't re-bill.
        expect(File::exists("{$dir}/ocr_charged.json"))->toBeTrue();
    } finally {
        File::deleteDirectory($dir);
    }
});

it('does NOT charge a failed import by default (toggle off)', function () {
    config(['services.billing.charge_ocr_on_failed_import' => false]);

    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $book = 'book_billfail_'.Str::lower(Str::random(8));
    $dir = importBillingBookDir($book);
    importBillingSeedOcrCache($dir); // OCR DID run before the crash

    importBillingClearRlsVars();

    try {
        (new ProcessDocumentImportJob($book, 'pdf', $user->id, [], []))
            ->failed(new RuntimeException('conversion exploded'));

        expect(importBillingLedger($user, 'ocr'))->toHaveCount(0);
        expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001);
        expect(File::exists("{$dir}/ocr_charged.json"))->toBeFalse();

        // The failure is surfaced to the poller either way.
        expect(json_decode(File::get("{$dir}/progress.json"), true)['status'])->toBe('failed');
    } finally {
        File::deleteDirectory($dir);
    }
});

it('bills the OCR that ran when the failed-import toggle is ON — exactly once', function () {
    config(['services.billing.charge_ocr_on_failed_import' => true]);

    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $book = 'book_billfailon_'.Str::lower(Str::random(8));
    $dir = importBillingBookDir($book);
    importBillingSeedOcrCache($dir, pages: 10); // 10/1000 × $2.00 = $0.02 raw

    importBillingClearRlsVars();

    try {
        $job = new ProcessDocumentImportJob($book, 'pdf', $user->id, [], []);
        $job->failed(new RuntimeException('conversion exploded'));

        $rows = importBillingLedger($user, 'ocr');
        expect($rows)->toHaveCount(1);
        expect((float) $rows[0]->amount)->toEqualWithDelta(0.02 * 1.5, 0.0001);
        expect(File::exists("{$dir}/ocr_charged.json"))->toBeTrue();

        // A second failed() (queue edge cases re-fire it) can't double-charge.
        importBillingClearRlsVars();
        $job->failed(new RuntimeException('again'));
        expect(importBillingLedger($user, 'ocr'))->toHaveCount(1);
    } finally {
        File::deleteDirectory($dir);
    }
});

it('failed-import toggle charges nothing when OCR never ran (no ocr_response.json)', function () {
    config(['services.billing.charge_ocr_on_failed_import' => true]);

    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $book = 'book_billnoocr_'.Str::lower(Str::random(8));
    $dir = importBillingBookDir($book); // no OCR cache — crash happened pre-OCR

    importBillingClearRlsVars();

    try {
        (new ProcessDocumentImportJob($book, 'pdf', $user->id, [], []))
            ->failed(new RuntimeException('died before OCR'));

        expect(importBillingLedger($user, 'ocr'))->toHaveCount(0);
        expect((float) User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001);
    } finally {
        File::deleteDirectory($dir);
    }
});
