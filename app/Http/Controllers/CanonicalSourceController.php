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
            ],
        ]);
    }
}
