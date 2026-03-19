<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use App\Jobs\CitationScanJob;

class CitationScannerController extends Controller
{
    /**
     * Trigger a citation scan for a book's bibliography.
     * POST /api/citation-scanner/scan
     */
    public function scan(Request $request): JsonResponse
    {
        $request->validate([
            'book' => 'required|string',
        ]);

        $bookId = $request->input('book');
        $db = DB::connection('pgsql_admin');

        // Check that the book exists in the library
        $bookExists = $db->table('library')->where('book', $bookId)->exists();
        if (!$bookExists) {
            return response()->json([
                'success' => false,
                'message' => 'Book not found',
            ], 404);
        }

        // Check no running scan for this book
        $runningScan = $db->table('citation_scans')
            ->where('book', $bookId)
            ->whereIn('status', ['pending', 'running'])
            ->first();

        if ($runningScan) {
            return response()->json([
                'success' => false,
                'message' => 'A scan is already in progress for this book',
                'scan_id' => $runningScan->id,
            ], 409);
        }

        // Count bibliography entries
        $entryCount = $db->table('bibliography')->where('book', $bookId)->count();

        // Create scan record
        $scanId = (string) Str::uuid();
        $db->table('citation_scans')->insert([
            'id'            => $scanId,
            'book'          => $bookId,
            'status'        => 'pending',
            'total_entries' => $entryCount,
            'created_at'    => now(),
            'updated_at'    => now(),
        ]);

        // Dispatch the job
        CitationScanJob::dispatch($scanId, $bookId);

        return response()->json([
            'success'       => true,
            'scan_id'       => $scanId,
            'total_entries' => $entryCount,
        ]);
    }

    /**
     * Get the status of a citation scan.
     * GET /api/citation-scanner/status/{scanId}
     */
    public function status(string $scanId): JsonResponse
    {
        $scan = DB::connection('pgsql_admin')
            ->table('citation_scans')
            ->where('id', $scanId)
            ->first();

        if (!$scan) {
            return response()->json([
                'success' => false,
                'message' => 'Scan not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'scan'    => [
                'id'                => $scan->id,
                'book'              => $scan->book,
                'status'            => $scan->status,
                'total_entries'     => $scan->total_entries,
                'already_linked'    => $scan->already_linked,
                'newly_resolved'    => $scan->newly_resolved,
                'failed_to_resolve' => $scan->failed_to_resolve,
                'enriched_existing' => $scan->enriched_existing,
                'results'           => json_decode($scan->results, true),
                'error'             => $scan->error,
                'created_at'        => $scan->created_at,
                'updated_at'        => $scan->updated_at,
            ],
        ]);
    }

    /**
     * Get scan history for a book.
     * GET /api/citation-scanner/history/{book}
     */
    public function history(string $book): JsonResponse
    {
        $scans = DB::connection('pgsql_admin')
            ->table('citation_scans')
            ->where('book', $book)
            ->orderByDesc('created_at')
            ->limit(10)
            ->select([
                'id', 'book', 'status', 'total_entries',
                'already_linked', 'newly_resolved', 'failed_to_resolve',
                'enriched_existing', 'error', 'created_at', 'updated_at',
            ])
            ->get();

        return response()->json([
            'success' => true,
            'scans'   => $scans,
        ]);
    }
}
