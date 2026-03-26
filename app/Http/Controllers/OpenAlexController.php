<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Log;
use App\Services\OpenAlexService;

class OpenAlexController extends Controller
{
    public function __construct(private OpenAlexService $openAlex) {}

    /**
     * Search OpenAlex works
     * GET /api/search/openalex?q=query&limit=10
     */
    public function search(Request $request)
    {
        $request->validate([
            'q'     => 'required|string|min:2',
            'limit' => 'integer|min:1|max:20',
        ]);

        $query = $request->input('q');
        $limit = min((int) $request->input('limit', 10), 20);

        try {
            $results = $this->openAlex->fetchFromOpenAlex($query, $limit);

            return response()->json([
                'success' => true,
                'results' => $results,
                'query'   => $query,
                'source'  => 'openalex',
                'count'   => count($results),
            ]);
        } catch (\Exception $e) {
            Log::error('OpenAlex search failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'OpenAlex search failed',
                'error'   => config('app.debug') ? $e->getMessage() : null,
            ], 500);
        }
    }

    /**
     * Resolve a raw bibliography string to candidate OpenAlex works
     * POST /api/openalex/lookup-citation
     */
    public function lookupCitation(Request $request)
    {
        $request->validate([
            'raw' => 'required|string|min:5',
        ]);

        $raw = $request->input('raw');
        $extractedTitle = $this->openAlex->extractTitle($raw);

        try {
            $results = $this->openAlex->fetchFromOpenAlex($extractedTitle, 5);

            return response()->json([
                'success'         => true,
                'candidates'      => array_slice($results, 0, 3),
                'extracted_title' => $extractedTitle,
                'raw'             => $raw,
            ]);
        } catch (\Exception $e) {
            Log::error('OpenAlex lookup-citation failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Citation lookup failed',
                'error'   => config('app.debug') ? $e->getMessage() : null,
            ], 500);
        }
    }

    /**
     * Save an OpenAlex work as a lightweight library stub so it can be cited.
     * POST /api/openalex/save-to-library
     */
    public function saveToLibrary(Request $request): JsonResponse
    {
        $request->validate([
            'openalex_id' => 'required|string|max:30',
        ]);

        $openalexId = $request->input('openalex_id');

        $existing = \App\Models\PgLibrary::where('openalex_id', $openalexId)->first();

        if ($existing) {
            return response()->json([
                'success' => true,
                'book'    => $existing->book,
                'bibtex'  => $existing->bibtex,
            ]);
        }

        try {
            $response = \Illuminate\Support\Facades\Http::withHeaders([
                'User-Agent' => OpenAlexService::USER_AGENT,
            ])->get(OpenAlexService::BASE_URL . '/works/' . $openalexId, [
                'select' => OpenAlexService::SELECT_FIELDS,
            ]);

            if (!$response->successful()) {
                Log::warning('OpenAlex /works/' . $openalexId . ' returned ' . $response->status());
                return response()->json([
                    'success' => false,
                    'message' => 'Could not fetch work from OpenAlex',
                ], 502);
            }

            $work = $response->json();
        } catch (\Exception $e) {
            Log::error('OpenAlex saveToLibrary fetch failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Failed to reach OpenAlex',
            ], 502);
        }

        $normalised = $this->openAlex->normaliseWork($work);
        $bookId = $this->openAlex->createOrFindStub($normalised);

        if (!$bookId) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to create library stub',
            ], 500);
        }

        return response()->json([
            'success' => true,
            'book'    => $bookId,
            'bibtex'  => $normalised['bibtex'],
        ]);
    }
}
