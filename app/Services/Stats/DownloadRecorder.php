<?php

namespace App\Services\Stats;

use App\Services\Connections\ConnectionCountQuery;
use App\Support\AnonToken;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * The single writer of `downloads` — one row per (subject, format, reader
 * identity, day), the same unit as a view.
 *
 * Called at the request that DELIVERS the bytes (never at a status poll or a
 * build trigger), plus the beacon for exports the browser builds itself.
 * It never throws: a download must not fail because telemetry did.
 *
 * No identity (no session, no anon_token cookie — curl, a no-JS client) is
 * skipped, exactly as page_views/book_reads refuse it: a NULL identity would
 * dodge both unique indexes and every retry would count.
 */
class DownloadRecorder
{
    public const TYPE_BOOK = 'book';
    public const TYPE_SHELF = 'shelf';
    public const TYPE_LIBRARY = 'library';

    public const TYPES = [self::TYPE_BOOK, self::TYPE_SHELF, self::TYPE_LIBRARY];

    /** @return bool whether a NEW row was written (false on dedupe, skip or error) */
    public function record(Request $request, string $type, string $subject, string $format): bool
    {
        // A HEAD is an availability probe (the source panel HEADs the PDF
        // route on every open), never a download.
        if ($request->isMethod('HEAD')) {
            return false;
        }
        if (! in_array($type, self::TYPES, true) || $subject === '' || $format === '') {
            return false;
        }
        if ($type === self::TYPE_BOOK) {
            $subject = ConnectionCountQuery::rootBook($subject);
        }

        $user = Auth::user();
        $anonymousToken = $user ? null : AnonToken::fromRequest($request);

        return $this->write($type, $subject, $format, $user?->name, $anonymousToken);
    }

    /**
     * Identity supplied by the caller — for contexts with no browser cookie
     * (an MCP call is authenticated by bearer token, so the user is known but
     * Auth::user() may be the token guard's).
     */
    public function recordForUser(string $userName, string $type, string $subject, string $format): bool
    {
        if (! in_array($type, self::TYPES, true) || $subject === '' || $format === '' || $userName === '') {
            return false;
        }
        if ($type === self::TYPE_BOOK) {
            $subject = ConnectionCountQuery::rootBook($subject);
        }

        return $this->write($type, $subject, $format, $userName, null);
    }

    private function write(string $type, string $subject, string $format, ?string $userName, ?string $anonToken): bool
    {
        if ($userName === null && $anonToken === null) {
            return false;
        }

        // Per-branch ON CONFLICT: each identity fork targets ITS OWN unique
        // index (Postgres NULLs are distinct; one statement can't name both).
        $identityColumn = $userName !== null ? 'user_name' : 'anon_token';
        $identityValue = $userName ?? $anonToken;

        try {
            $row = DB::selectOne(
                "INSERT INTO downloads (subject_type, subject, format, {$identityColumn}, download_date, created_at, updated_at)
                 VALUES (?, ?, ?, ?, CURRENT_DATE, NOW(), NOW())
                 ON CONFLICT (subject_type, subject, format, {$identityColumn}, download_date) DO NOTHING
                 RETURNING id",
                [$type, $subject, $format, $identityValue]
            );

            return $row !== null;
        } catch (\Throwable $e) {
            Log::warning('Download record failed (non-fatal)', [
                'subject_type' => $type,
                'subject' => $subject,
                'format' => $format,
                'error' => $e->getMessage(),
            ]);

            return false;
        }
    }
}
