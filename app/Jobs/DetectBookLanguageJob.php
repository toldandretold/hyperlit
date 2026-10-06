<?php

namespace App\Jobs;

use App\Services\Translation\BookLanguageDetector;
use App\Services\Translation\BookTextSampler;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Detect a book's language from its node content and stamp
 * library.language_detected (+ _at). Best-effort: any failure logs and
 * returns — a detection miss must never fail an import.
 *
 * The result feeds `<html lang>` ONLY (declared library.language always
 * wins) — NEVER citation_language / JSON-LD inLanguage, which are
 * bibliographic claims and stay declared-only.
 *
 * `language_detected_at` is stamped EVEN WHEN detection returns null
 * (confidently unknown), so library:detect-language --stale doesn't retry
 * the same undetectable book forever; a later content change bumps
 * library.timestamp past it and re-qualifies the book.
 *
 * Dispatched from the "content just landed wholesale" points (document
 * import, harvest persist, web-stub create) — deliberately NOT the editor
 * sync hot path; the weekly --stale sweep covers organic drift ("the book
 * became Chinese later").
 */
class DetectBookLanguageJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(public string $bookId) {}

    public function handle(): void
    {
        try {
            if (! self::eligible($this->bookId)) {
                return;
            }

            $code = BookLanguageDetector::detect(BookTextSampler::sample($this->bookId));

            DB::connection('pgsql_admin')->table('library')
                ->where('book', $this->bookId)
                ->update([
                    'language_detected' => $code,
                    'language_detected_at' => now(),
                ]);
        } catch (\Throwable $e) {
            Log::warning('DetectBookLanguageJob failed (non-fatal)', [
                'book' => $this->bookId, 'error' => $e->getMessage(),
            ]);
        }
    }

    /**
     * Top-level, non-encrypted, non-synthetic books with content only.
     * Shared by the job and library:detect-language.
     */
    public static function eligible(string $bookId): bool
    {
        if (str_contains($bookId, '/')) {
            return false; // sub-books inherit their host's page
        }

        $row = DB::connection('pgsql_admin')->table('library')
            ->where('book', $bookId)
            ->first(['encrypted', 'has_nodes', 'raw_json']);
        if (! $row || $row->encrypted || ! $row->has_nodes) {
            return false;
        }

        // Synthetic render books (shelf/user_home/stats) are app furniture.
        $type = json_decode((string) $row->raw_json, true)['type'] ?? null;

        return ! in_array($type, ['shelf', 'user_home'], true);
    }
}
