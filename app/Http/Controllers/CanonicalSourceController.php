<?php

namespace App\Http\Controllers;

use App\Models\CanonicalSource;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * Test coverage: tests/Feature/Citations/CanonicalBestVersionTest.php
 *   — Precedence (author > publisher > commons > auto > any visible),
 *     privacy (no private leak), 404 / non-uuid route constraints.
 */
class CanonicalSourceController extends Controller
{
    /**
     * Resolve a canonical_source.id to the best available library version
     * for the current user, plus enough metadata for the citation card.
     *
     * Precedence: author_version_book > publisher_version_book > commons_version_book
     *           > auto_version_book > any visible version (creator/public/shelf-aware).
     *
     * Privacy: only versions visible to the caller are returned — private library
     * rows belonging to another user are never leaked.
     *
     * Returns 200 with { book, has_version, metadata } in all "canonical exists"
     * cases, and 404 only if the canonical itself doesn't exist. A canonical
     * with no resolvable version returns { book: null, has_version: false }.
     */
    public function bestVersion(Request $request, string $id): JsonResponse
    {
        $canonical = CanonicalSource::find($id);
        if (!$canonical) {
            return response()->json(['error' => 'Canonical not found'], 404);
        }

        $user = Auth::user();
        $anonymousToken = $request->cookie('anon_token');

        // 1. Try the four precedence pointers — but verify each is still visible.
        $precedenceBooks = array_filter([
            $canonical->author_version_book,
            $canonical->publisher_version_book,
            $canonical->commons_version_book,
            $canonical->auto_version_book,
        ]);

        $book = null;
        foreach ($precedenceBooks as $candidate) {
            if ($this->isBookVisible($candidate, $user, $anonymousToken)) {
                $book = $candidate;
                break;
            }
        }

        // 2. Fall back to any visible linked version.
        if ($book === null) {
            $book = DB::table('library')
                ->where('canonical_source_id', $canonical->id)
                ->where(function ($q) use ($user, $anonymousToken) {
                    $q->where(function ($p) {
                        $p->where('visibility', 'public')
                          ->where('listed', true);
                    });
                    if ($user) {
                        $q->orWhere(function ($p) use ($user) {
                            $p->where('creator', $user->name)
                              ->where('visibility', '!=', 'deleted');
                        });
                    }
                    if ($anonymousToken) {
                        $q->orWhere(function ($p) use ($anonymousToken) {
                            $p->where('creator_token', $anonymousToken)
                              ->where('visibility', '!=', 'deleted');
                        });
                    }
                })
                ->orderBy('created_at')
                ->value('book');
        }

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

    private function isBookVisible(?string $book, $user, ?string $anonymousToken): bool
    {
        if (empty($book)) return false;

        $row = DB::table('library')
            ->where('book', $book)
            ->select('creator', 'creator_token', 'visibility', 'listed')
            ->first();

        if (!$row || $row->visibility === 'deleted') return false;

        if ($row->visibility === 'public' && $row->listed) return true;
        if ($user && $row->creator === $user->name && $row->visibility !== 'deleted') return true;
        if ($anonymousToken && $row->creator_token === $anonymousToken && $row->visibility !== 'deleted') return true;

        return false;
    }
}
