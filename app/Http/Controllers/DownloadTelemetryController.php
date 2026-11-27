<?php

namespace App\Http\Controllers;

use App\Helpers\BookSlugHelper;
use App\Services\Connections\ConnectionCountQuery;
use App\Services\Stats\DownloadRecorder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Download beacon for the book exports the BROWSER builds (markdown / docx /
 * epub are assembled from IndexedDB and saved as a Blob — the server never
 * sees those bytes, so the client reports them).
 *
 * The format whitelist is deliberately only those three: every other format
 * (m4b, pdf, the vaults) is counted at the server route that serves it, and
 * letting a client claim one would double-count it.
 */
class DownloadTelemetryController extends Controller
{
    public const CLIENT_FORMATS = ['markdown', 'docx', 'epub'];

    public function record(Request $request, DownloadRecorder $recorder): JsonResponse
    {
        $format = (string) $request->input('format', '');
        $book = (string) $request->input('book', '');
        if (! in_array($format, self::CLIENT_FORMATS, true) || $book === '' || strlen($book) > 255) {
            return response()->json(['error' => 'Unknown download'], 422);
        }

        try {
            $book = ConnectionCountQuery::rootBook(BookSlugHelper::resolve($book));
            // resolve() hands an unknown id back as-is — refuse to mint
            // counts for books that don't exist.
            if (! DB::connection('pgsql_admin')->table('library')->where('book', $book)->exists()) {
                return response()->json(['error' => 'Unknown book'], 422);
            }
        } catch (\Throwable) {
            return response()->json(['success' => false], 200);
        }

        $recorder->record($request, DownloadRecorder::TYPE_BOOK, $book, $format);

        return response()->json(['success' => true]);
    }
}
