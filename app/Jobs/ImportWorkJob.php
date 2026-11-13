<?php

namespace App\Jobs;

use App\Models\CanonicalSource;
use App\Models\User;
use App\Services\BillingService;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceHarvest\WorkOcrCharger;
use App\Services\SourceImport\PersonalCopyMaker;
use App\Services\SourceImport\SingleWorkImporter;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * Import ONE work a user asked for by DOI / OpenAlex id, through the whole acquisition ladder
 * (AutoVersionCreator → ContentFetchService → JATS / OA candidates / HTML / browser → OCR).
 * The user-facing sibling of ImportCitedSourceJob; SingleWorkImporter is its only dispatcher.
 *
 * Two legs, split at the one step that costs money:
 *   1. fetch with OCR skipped. JATS / HTML lanes finish here, free.
 *   2. a PDF was downloaded → OCR it. Over MCP that waits for the user to accept the
 *      estimate (status awaiting_confirmation); on the web it needs a positive balance,
 *      same as an uploaded PDF. OCR is charged to the importer after it succeeds.
 *
 * Then delivery: the system copy if HostingPolicy left it public (onto the importer's
 * "Imported works" shelf), otherwise a private personal copy.
 */
class ImportWorkJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600;
    public int $tries = 1;

    public function __construct(private string $importId) {}

    public function handle(
        AutoVersionCreator $creator,
        WorkOcrCharger $charger,
        HarvestShelf $shelves,
        PersonalCopyMaker $copies,
        BillingService $billing,
    ): void {
        $row = DB::connection('pgsql_admin')->table('work_imports')->where('id', $this->importId)->first();
        if (!$row) {
            Log::warning('ImportWorkJob: import row vanished', ['import' => $this->importId]);

            return;
        }

        $this->mark(['status' => 'running', 'reason' => null]);
        $this->progress('processing', 'fetching_work', 10, 'Looking for an open copy…');

        try {
            $canonical = CanonicalSource::find($row->canonical_source_id);
            if (!$canonical) {
                throw new \RuntimeException('canonical row not found');
            }
            $user = $row->user_id ? User::on('pgsql_admin')->find($row->user_id) : null;

            // Leg 1 — everything except paid OCR.
            $result = $creator->create($canonical, true);

            if (($result['status'] ?? null) === 'deferred' && $this->pdfAwaitingOcr($result['book'] ?? null)) {
                $systemBook = $result['book'];
                $this->mark(['system_book' => $systemBook]);

                if ($row->surface === SingleWorkImporter::SURFACE_MCP && !$row->ocr_confirmed) {
                    $this->pauseForConfirmation($systemBook, $user);

                    return;
                }
                if ($user && !$billing->canProceed($user)) {
                    $this->failImport('insufficient_balance', 'An open copy was found as a PDF, which needs OCR — top up credits and try again.');

                    return;
                }

                // Leg 2 — OCR the PDF that is already on disk (no re-fetch).
                $this->progress('processing', 'ocr', 45, 'Reading the PDF (OCR)…');
                $result = $creator->create($canonical, false);
            }

            $status = $result['status'] ?? 'error';
            if (!in_array($status, ['assigned', 'assigned_existing'], true) || empty($result['book'])) {
                $this->failImport($result['reason'] ?? $status, null, $result['via'] ?? null, $result['book'] ?? null);

                return;
            }

            $systemBook = $result['book'];
            if ($status === 'assigned' && $user) {
                // Idempotent (ocr_charged.json) and a no-op for the JATS / HTML lanes.
                $charger->charge($user, $systemBook, "Work import OCR: {$systemBook}");
            }

            $this->progress('processing', 'delivering', 90, 'Adding it to your library…');
            $this->deliver($row, $systemBook, $shelves, $copies, $result['via'] ?? null);
        } catch (\Throwable $e) {
            Log::error('ImportWorkJob failed', ['import' => $this->importId, 'error' => $e->getMessage()]);
            $this->failImport(mb_substr($e->getMessage(), 0, 500));
        }
    }

    private function deliver(object $row, string $systemBook, HarvestShelf $shelves, PersonalCopyMaker $copies, ?string $via): void
    {
        $visibility = DB::connection('pgsql_admin')->table('library')->where('book', $systemBook)->value('visibility');

        if ($visibility === 'public') {
            if ($row->creator) {
                $shelf = $shelves->ensureImportShelfFor($row->creator);
                $shelves->addBooks($shelf->id, [$systemBook]);
            }
            $this->complete($systemBook, $systemBook, 'commons', $via);

            return;
        }

        // Held (its licence does not let Hyperlit host it publicly): the importer still gets
        // to read what they asked for, as a private book of their own.
        if (!$row->creator && !$row->creator_token) {
            $this->failImport('held_no_owner', 'An open copy was found, but its licence does not allow public hosting and there is no account to keep a private copy in.', $via, $systemBook);

            return;
        }
        $copy = $copies->make($systemBook, $this->importId, $row->creator, $row->creator_token);
        $this->complete($copy, $systemBook, 'personal_copy', $via);
    }

    private function pauseForConfirmation(string $systemBook, ?User $user): void
    {
        $pages = $this->countPdfPages(resource_path("markdown/{$systemBook}/original.pdf"));
        $perK = BillingService::ocrPricePerKPages(null);
        $cost = ($pages !== null && $perK !== null && $user)
            ? round($pages / 1000 * $perK * $user->getBillingMultiplier(), 2)
            : null;
        $token = SingleWorkImporter::newConfirmToken();
        $estimate = ['estimated_pages' => $pages, 'estimated_cost_usd' => $cost];

        $this->mark([
            'status'        => 'awaiting_confirmation',
            'confirm_token' => $token,
            'estimate'      => json_encode($estimate),
        ]);
        $this->progress('awaiting_confirmation', 'awaiting_confirmation', 40,
            'An open copy was found as a PDF. Converting it needs OCR, billed per page — confirm to continue.',
            $estimate + ['confirm_token' => $token]);
    }

    private function pdfAwaitingOcr(?string $book): bool
    {
        return $book !== null && File::exists(resource_path("markdown/{$book}/original.pdf"));
    }

    private function countPdfPages(string $path): ?int
    {
        try {
            return count((new \Smalot\PdfParser\Parser())->parseFile($path)->getPages());
        } catch (\Throwable) {
            return null; // best-effort; the estimate just reads "unknown"
        }
    }

    private function complete(string $book, string $systemBook, string $outcome, ?string $via): void
    {
        $this->mark([
            'status'      => 'completed',
            'book'        => $book,
            'system_book' => $systemBook,
            'outcome'     => $outcome,
            'via'         => $via,
        ]);
        $this->progress('complete', 'complete', 100,
            $outcome === 'commons'
                ? 'Imported — this is the shared commons copy.'
                : 'Imported as a private copy: its licence does not allow public hosting.',
            ['book' => $book, 'outcome' => $outcome, 'via' => $via]);
    }

    private function failImport(string $reason, ?string $detail = null, ?string $via = null, ?string $systemBook = null): void
    {
        $this->mark(array_filter([
            'status'      => 'failed',
            'reason'      => $reason,
            'via'         => $via,
            'system_book' => $systemBook,
        ], fn ($v) => $v !== null));
        $this->progress('failed', 'fetch_failed', 0,
            $detail ?? ('Could not import an open copy: ' . $reason . ($via ? " ({$via})" : '') . '.'),
            ['reason' => $reason, 'via' => $via]);
    }

    /** @param array<string, mixed> $fields */
    private function mark(array $fields): void
    {
        DB::connection('pgsql_admin')->table('work_imports')
            ->where('id', $this->importId)
            ->update($fields + ['updated_at' => now()]);
    }

    /** @param array<string, mixed> $extra */
    private function progress(string $status, string $stage, int $percent, string $detail, array $extra = []): void
    {
        SingleWorkImporter::writeProgress($this->importId, $status, $stage, $percent, $detail, $extra);
    }
}
