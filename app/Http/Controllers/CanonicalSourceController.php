<?php

namespace App\Http\Controllers;

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\BestVersionService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

/**
 * Test coverage: tests/Feature/Citations/CanonicalBestVersionTest.php
 *   — Precedence (author > publisher > commons > auto > any visible),
 *     privacy (no private leak), 404 / non-uuid route constraints.
 * Resolution logic lives in App\Services\CanonicalVersions\BestVersionService.
 */
class CanonicalSourceController extends Controller
{
    /**
     * Resolve a canonical_source.id to the best available library version
     * for the current user, plus enough metadata for the citation card.
     *
     * Precedence comes from VersionPointerRegistry (author > publisher >
     * commons > auto > any visible version), visibility-checked per caller.
     *
     * Returns 200 with { book, has_version, metadata } in all "canonical exists"
     * cases, and 404 only if the canonical itself doesn't exist. A canonical
     * with no resolvable version returns { book: null, has_version: false }.
     *
     * The SOLE `canonical_source` payload that reaches the client — must stay in sync with the TS
     * contract `CanonicalBestVersion` (`indexedDB/bibliography/index.ts`). `creator_token` is hidden
     * on the model; only the citation-card metadata fields are exposed here.
     *
     * @return JsonResponse array{book: ?string, has_version: bool, metadata: array{
     *   title: ?string, author: ?string, year: ?int, journal: ?string, publisher: ?string,
     *   doi: ?string, abstract: ?string, oa_url: ?string, pdf_url: ?string,
     *   openalex_id: ?string, open_library_key: ?string, source_url: ?string
     * }} | array{error: string}
     */
    public function bestVersion(Request $request, string $id, BestVersionService $bestVersion): JsonResponse
    {
        $canonical = CanonicalSource::find($id);
        if (!$canonical) {
            return response()->json(['error' => 'Canonical not found'], 404);
        }

        $book = $bestVersion->bestVisibleVersion(
            $canonical,
            Auth::user(),
            $request->cookie('anon_token'),
        );

        return response()->json([
            'book'        => $book,
            'has_version' => $book !== null,
            'metadata'    => [
                'title'     => $canonical->title,
                'author'    => $canonical->author,
                'year'      => $canonical->year,
                'journal'   => $canonical->journal,
                'publisher' => $canonical->publisher,
                'doi'       => $canonical->doi,
                'abstract'  => $canonical->abstract,
                'oa_url'    => $canonical->oa_url,
                'pdf_url'   => $canonical->pdf_url,
                // Identifiers so the client can build the "view on OpenAlex / Open Library" link in the
                // verified state on a fresh open (mirrors the source panel's externalSourceLink).
                'openalex_id'      => $canonical->openalex_id,
                'open_library_key' => $canonical->open_library_key,
                // For web-only canonicals (no DOI/OA) — the original URL to link OUT to when the
                // only "version" was a suppressed WebFetch stub (book === null).
                'source_url' => $canonical->source_url,
            ],
        ]);
    }
}
