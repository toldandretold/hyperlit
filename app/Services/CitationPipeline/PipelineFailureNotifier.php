<?php

namespace App\Services\CitationPipeline;

use App\Mail\CitationPipelineBugReportMail;
use App\Mail\CitationReviewFailedMail;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

/**
 * At-most-once terminal-failure notification for a citation pipeline: an
 * apology email to the requesting user (they were promised results by email —
 * never leave them waiting on one that will never come) plus a bug report to
 * the maintainer with the full telemetry stream, so a prod failure arrives
 * pre-debugged.
 *
 * Callers are the three terminal seams — CitationPipelineJob::failed(), the
 * stale auto-fail in CitationScannerController, and the empty-result paths in
 * CitationReviewCommand. Whatever the cause, the "why" rides along in the
 * telemetry; new failure modes are covered without touching this class.
 *
 * Same philosophy as PipelineTelemetry: best-effort, never throws into the
 * caller. The failure_notified_at column is the idempotency latch — claimed
 * atomically, so concurrent pollers/retries can't double-send.
 */
final class PipelineFailureNotifier
{
    public function notify(?string $pipelineId): void
    {
        if (!$pipelineId) {
            return;
        }

        try {
            $db = DB::connection('pgsql_admin');

            $claimed = $db->table('citation_pipelines')
                ->where('id', $pipelineId)
                ->whereNull('failure_notified_at')
                ->update(['failure_notified_at' => now()]);

            if (!$claimed) {
                return; // already notified, or unknown pipeline id
            }

            $pipeline = (array) $db->table('citation_pipelines')->where('id', $pipelineId)->first();
            $book = $db->table('library')->where('book', $pipeline['book'])->first();
            $bookTitle = $book->title ?? $pipeline['book'];

            $user = null;
            if (!empty($pipeline['user_id'])) {
                $user = User::on('pgsql_admin')->find($pipeline['user_id']);
            }
            if (!$user && ($book->creator ?? null)) {
                $user = User::on('pgsql_admin')->where('name', $book->creator)->first();
            }

            if ($user?->email) {
                Mail::send(new CitationReviewFailedMail(
                    $user->email,
                    $bookTitle,
                    $pipeline['book'],
                    $pipeline['error'] ?? null,
                ));
            }

            Mail::send(new CitationPipelineBugReportMail(
                $pipeline,
                $bookTitle,
                $user?->name,
                $user?->email,
            ));
        } catch (\Throwable $e) {
            Log::error('PipelineFailureNotifier failed', [
                'pipelineId' => $pipelineId,
                'error'      => $e->getMessage(),
            ]);
        }
    }
}
