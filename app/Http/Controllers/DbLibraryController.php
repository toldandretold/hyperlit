<?php

/*

when you call:

bulkCreate() or upsert() → automatically triggers stats update → automatically triggers homepage update
updateBookStats($book) → automatically triggers homepage update after book stats
updateAllLibraryStats() → manually triggers the full chain

*/

namespace App\Http\Controllers;

use App\Models\PgLibrary;
use App\Models\PgHypercite;
use App\Models\PgHyperlight;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class DbLibraryController extends Controller
{
    public function bulkCreate(Request $request)
    {
        // Use database transaction to ensure atomicity
        return DB::transaction(function () use ($request) {
            try {
                $data = $request->all();
                
                if (isset($data['data']) && is_object($data['data'])) {
                    $item = $data['data'];
                    
                    $record = [
                        'book' => $item['book'] ?? null,
                        'citationID' => $item['citationID'] ?? null,
                        'title' => $item['title'] ?? null,
                        'author' => $item['author'] ?? null,
                        'creator' => $item['creator'] ?? null,
                        'type' => $item['type'] ?? null,
                        'timestamp' => $item['timestamp'] ?? null,
                        'bibtex' => $item['bibtex'] ?? null,
                        'year' => $item['year'] ?? null,
                        'publisher' => $item['publisher'] ?? null,
                        'journal' => $item['journal'] ?? null,
                        'pages' => $item['pages'] ?? null,
                        'url' => $item['url'] ?? null,
                        'note' => $item['note'] ?? null,
                        'school' => $item['school'] ?? null,
                        'fileName' => $item['fileName'] ?? null,
                        'fileType' => $item['fileType'] ?? null,
                        'recent' => $item['recent'] ?? null,
                        'total_views' => $item['total_views'] ?? 0,
                        'total_highlights' => $item['total_highlights'] ?? 0,
                        'total_citations' => $item['total_citations'] ?? 0,
                        'raw_json' => ($item),
                        'created_at' => now(),
                        'updated_at' => now(),
                    ];
                    
                    // Step 1: Create the record and ensure it's committed
                    $createdRecord = PgLibrary::create($record);
                    
                    // Verify the record was actually created
                    if (!$createdRecord || !$createdRecord->exists) {
                        throw new \Exception('Failed to create library record');
                    }
                    
                    // Step 2: Chain the subsequent operations AFTER successful creation
                    $chainResult = $this->executeChainedOperations();
                    
                    return response()->json([
                        'success' => true,
                        'message' => 'Library record created and chain completed',
                        'chain_result' => $chainResult
                    ]);
                }
                
                return response()->json([
                    'success' => false,
                    'message' => 'Invalid data format'
                ], 400);
                
            } catch (\Exception $e) {
                // Transaction will automatically rollback
                Log::error('BulkCreate failed: ' . $e->getMessage());
                return response()->json([
                    'success' => false,
                    'message' => 'Failed to sync data',
                    'error' => $e->getMessage()
                ], 500);
            }
        });
    }

    public function upsert(Request $request)
    {
        return DB::transaction(function () use ($request) {
            try {
                $data = $request->all();
                
                if (isset($data['data']) && (is_object($data['data']) || is_array($data['data']))) {
                    $item = (array) $data['data'];
                    Log::info('Received library data:', ['data' => $item]);
                    Log::info('Creator value: ' . ($item['creator'] ?? 'NOT SET'));
                    
                    // Step 1: Perform upsert and ensure it's committed
                    $record = PgLibrary::updateOrCreate(
                        [
                            'book' => $item['book'] ?? null,
                            'citationID' => $item['citationID'] ?? null,
                        ],
                        [
                            'title' => $item['title'] ?? null,
                            'author' => $item['author'] ?? null,
                            'creator' => $item['creator'] ?? null,
                            'type' => $item['type'] ?? null,
                            'timestamp' => $item['timestamp'] ?? null,
                            'bibtex' => $item['bibtex'] ?? null,
                            'year' => $item['year'] ?? null,
                            'publisher' => $item['publisher'] ?? null,
                            'journal' => $item['journal'] ?? null,
                            'pages' => $item['pages'] ?? null,
                            'url' => $item['url'] ?? null,
                            'note' => $item['note'] ?? null,
                            'school' => $item['school'] ?? null,
                            'fileName' => $item['fileName'] ?? null,
                            'fileType' => $item['fileType'] ?? null,
                            'recent' => $item['recent'] ?? null,
                            'total_views' => $item['total_views'] ?? 0,
                            'total_highlights' => $item['total_highlights'] ?? 0,
                            'total_citations' => $item['total_citations'] ?? 0,
                            'raw_json' => ($item),
                            'updated_at' => now(),
                        ]
                    );
                    
                    // Verify the record exists
                    if (!$record || !$record->exists) {
                        throw new \Exception('Failed to upsert library record');
                    }
                    
                    // Step 2: Chain the subsequent operations AFTER successful upsert
                    $chainResult = $this->executeChainedOperations();
                    
                    return response()->json([
                        'success' => true,
                        'message' => 'Library synced and chain completed successfully',
                        'chain_result' => $chainResult
                    ]);
                }
                
                return response()->json([
                    'success' => false,
                    'message' => 'Invalid data format'
                ], 400);
                
            } catch (\Exception $e) {
                Log::error('Upsert failed: ' . $e->getMessage());
                return response()->json([
                    'success' => false,
                    'message' => 'Failed to sync data',
                    'error' => $e->getMessage()
                ], 500);
            }
        });
    }

    /**
     * Execute the chained operations with proper error handling and sequencing
     */
    private function executeChainedOperations()
    {
        $results = [
            'stats_updated' => false,
            'homepage_updated' => false,
            'errors' => []
        ];
        
        try {
            // Step 2a: Update stats (each method returns success/failure)
            Log::info('Starting stats update chain...');
            
            $recentResult = $this->updateRecentColumnInternal();
            if (!$recentResult['success']) {
                throw new \Exception('Failed to update recent column: ' . $recentResult['message']);
            }
            
            $citesResult = $this->updateTotalCitesColumnInternal();
            if (!$citesResult['success']) {
                throw new \Exception('Failed to update cites column: ' . $citesResult['message']);
            }
            
            $highlightsResult = $this->updateTotalHighlightsColumnInternal();
            if (!$highlightsResult['success']) {
                throw new \Exception('Failed to update highlights column: ' . $highlightsResult['message']);
            }
            
            $results['stats_updated'] = true;
            Log::info('Stats update completed successfully');
            
            // Step 2b: Update homepage ONLY after stats are confirmed updated
            Log::info('Starting homepage update...');
            
            $homePageController = new \App\Http\Controllers\HomePageServerController();
            $homepageResponse = $homePageController->updateHomePageBooks(new Request());
            
            // Check if homepage update was successful
            $homepageData = $homepageResponse->getData(true);
            if (!isset($homepageData['success']) || !$homepageData['success']) {
                throw new \Exception('Homepage update failed: ' . ($homepageData['message'] ?? 'Unknown error'));
            }
            
            $results['homepage_updated'] = true;
            Log::info('Homepage update completed successfully');
            
        } catch (\Exception $e) {
            $error = 'Chain operation failed: ' . $e->getMessage();
            Log::error($error);
            $results['errors'][] = $error;
        }
        
        return $results;
    }

    /**
     * Internal version of updateRecentColumn that returns structured result
     */
    private function updateRecentColumnInternal()
    {
        try {
            $libraryRecords = PgLibrary::orderBy('updated_at', 'desc')->get();
            
            foreach ($libraryRecords as $index => $record) {
                $record->update(['recent' => $index + 1]);
            }

            return [
                'success' => true,
                'message' => 'Recent column updated successfully',
                'updated_count' => $libraryRecords->count()
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'message' => 'Error updating recent column: ' . $e->getMessage()
            ];
        }
    }

    /**
     * Internal version of updateTotalCitesColumn that returns structured result
     */
    private function updateTotalCitesColumnInternal()
    {
        try {
            $books = PgLibrary::distinct()->pluck('book');
            
            foreach ($books as $book) {
                $hypercites = PgHypercite::where('book', $book)->get();
                $totalCites = 0;
                
                foreach ($hypercites as $hypercite) {
                    if ($hypercite->citedIN) {
                        $citedInArray = is_array($hypercite->citedIN) 
                            ? $hypercite->citedIN 
                            : json_decode($hypercite->citedIN, true);
                        
                        if (is_array($citedInArray)) {
                            foreach ($citedInArray as $citation) {
                                if (!$this->isSelfCitation($citation, $book)) {
                                    $totalCites++;
                                }
                            }
                        }
                    }
                }
                
                PgLibrary::where('book', $book)->update(['total_citations' => $totalCites]);
            }

            return [
                'success' => true,
                'message' => 'Total cites column updated successfully',
                'updated_books' => $books->count()
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'message' => 'Error updating total cites column: ' . $e->getMessage()
            ];
        }
    }

    /**
     * Internal version of updateTotalHighlightsColumn that returns structured result
     */
    private function updateTotalHighlightsColumnInternal()
    {
        try {
            $books = PgLibrary::distinct()->pluck('book');
            
            foreach ($books as $book) {
                $highlightCount = PgHyperlight::where('book', $book)->count();
                PgLibrary::where('book', $book)->update(['total_highlights' => $highlightCount]);
            }

            return [
                'success' => true,
                'message' => 'Total highlights column updated successfully',
                'updated_books' => $books->count()
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'message' => 'Error updating total highlights column: ' . $e->getMessage()
            ];
        }
    }

    // Keep your existing public methods for direct API access
    public function updateRecentColumn()
    {
        $result = $this->updateRecentColumnInternal();
        return response()->json($result, $result['success'] ? 200 : 500);
    }

    public function updateTotalCitesColumn()
    {
        $result = $this->updateTotalCitesColumnInternal();
        return response()->json($result, $result['success'] ? 200 : 500);
    }

    public function updateTotalHighlightsColumn()
    {
        $result = $this->updateTotalHighlightsColumnInternal();
        return response()->json($result, $result['success'] ? 200 : 500);
    }

    public function updateAllLibraryStats()
    {
        try {
            $chainResult = $this->executeChainedOperations();
            
            return response()->json([
                'success' => $chainResult['stats_updated'] && $chainResult['homepage_updated'],
                'message' => 'Library statistics and homepage update completed',
                'details' => $chainResult
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Error updating library statistics: ' . $e->getMessage()
            ], 500);
        }
    }

    public function updateBookStats($book)
    {
        return DB::transaction(function () use ($book) {
            try {
                // Update recent column (this affects all books, so we run it)
                $recentResult = $this->updateRecentColumnInternal();
                if (!$recentResult['success']) {
                    throw new \Exception('Failed to update recent column');
                }
                
                // Update cites for specific book
                $hypercites = PgHypercite::where('book', $book)->get();
                $totalCites = 0;
                
                foreach ($hypercites as $hypercite) {
                    if ($hypercite->citedIN) {
                        $citedInArray = is_array($hypercite->citedIN) 
                            ? $hypercite->citedIN 
                            : json_decode($hypercite->citedIN, true);
                        
                        if (is_array($citedInArray)) {
                            foreach ($citedInArray as $citation) {
                                if (!$this->isSelfCitation($citation, $book)) {
                                    $totalCites++;
                                }
                            }
                        }
                    }
                }
                
                // Update highlights for specific book
                $highlightCount = PgHyperlight::where('book', $book)->count();
                
                // Update the library record
                $updated = PgLibrary::where('book', $book)->update([
                    'total_citations' => $totalCites,
                    'total_highlights' => $highlightCount
                ]);
                
                if ($updated === 0) {
                    return response()->json([
                        'success' => false,
                        'message' => "Book '{$book}' not found in library"
                    ], 404);
                }
                
                // Chain: Update homepage ONLY after book stats are confirmed updated
                $homePageController = new \App\Http\Controllers\HomePageServerController();
                $homepageResponse = $homePageController->updateHomePageBooks(new Request());
                
                $homepageData = $homepageResponse->getData(true);
                if (!isset($homepageData['success']) || !$homepageData['success']) {
                    throw new \Exception('Homepage update failed');
                }
                
                return response()->json([
                    'success' => true,
                    'message' => "Stats updated for book: {$book} and homepage updated",
                    'book' => $book,
                    'total_citations' => $totalCites,
                    'total_highlights' => $highlightCount
                ]);
                
            } catch (\Exception $e) {
                return response()->json([
                    'success' => false,
                    'message' => 'Error updating book stats: ' . $e->getMessage()
                ], 500);
            }
        });
    }

    public function updateTotalViewsColumn()
    {
        try {
            return response()->json([
                'success' => true,
                'message' => 'Total views column update is not implemented yet'
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Error updating total views column: ' . $e->getMessage()
            ], 500);
        }
    }

    private function isSelfCitation($citation, $currentBook)
    {
        if (preg_match('/^\/([^#]+)#/', $citation, $matches)) {
            $citedBook = $matches[1];
            return $citedBook === $currentBook;
        }
        
        if (preg_match('/^\/([^\/]+)\//', $citation, $matches)) {
            $citedBook = $matches[1];
            return $citedBook === $currentBook;
        }
        
        return false;
    }
}