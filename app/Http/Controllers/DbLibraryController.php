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
use Illuminate\Support\Facades\Auth;
use App\Models\AnonymousSession;

class DbLibraryController extends Controller
{
     private function isValidAnonymousToken($token)
    {
        if (!$token) {
            Log::info('No token provided for validation');
            return false;
        }
        
        $session = AnonymousSession::where('token', $token)
            ->where('created_at', '>', now()->subDays(365))
            ->first();
            
        $isValid = $session !== null;
        
        Log::info('Token validation result', [
            'token_length' => strlen($token),
            'session_found' => $isValid,
            'session_created_at' => $session ? $session->created_at : null
        ]);
        
        return $isValid;
    }

    /**
     * Get creator info based on auth state
     */
    private function getCreatorInfo(Request $request)
    {
        $user = Auth::user();
        
        if ($user) {
            // Authenticated user
            Log::info('Using authenticated user', ['user' => $user->name]);
            return [
                'creator' => $user->name,
                'creator_token' => null,
                'valid' => true
            ];
        } else {
            // Anonymous user - validate server token
            $anonToken = $request->cookie('anon_token');
            
            Log::info('Checking anonymous session', [
                'cookie_present' => $anonToken ? 'yes' : 'no',
                'cookie_length' => $anonToken ? strlen($anonToken) : 0,
                'all_cookies' => array_keys($request->cookies->all())
            ]);
            
            if (!$anonToken || !$this->isValidAnonymousToken($anonToken)) {
                Log::warning('Anonymous session validation failed', [
                    'token_present' => $anonToken ? 'yes' : 'no',
                    'validation_passed' => $anonToken ? $this->isValidAnonymousToken($anonToken) : false
                ]);
                return [
                    'creator' => null,
                    'creator_token' => null,
                    'valid' => false
                ];
            }
            
            // Update last used time for the anonymous session
            AnonymousSession::where('token', $anonToken)
                ->update(['last_used_at' => now()]);
            
            Log::info('Anonymous session validated successfully');
            return [
                'creator' => null,
                'creator_token' => $anonToken,
                'valid' => true
            ];
        }
    }

    // Update your upsert method with better debugging
    public function upsert(Request $request)
    {
        return DB::transaction(function () use ($request) {
            try {
                $data = $request->all();
                
                // Get creator info based on auth state
                $creatorInfo = $this->getCreatorInfo($request);
                if (!$creatorInfo['valid']) {
                    Log::warning('Invalid session in upsert', [
                        'creator_info' => $creatorInfo,
                        'cookies' => $request->cookies->all()
                    ]);
                    return response()->json([
                        'success' => false,
                        'message' => 'Invalid session',
                        'debug' => [
                            'has_auth_user' => Auth::user() ? true : false,
                            'has_anon_token' => $request->cookie('anon_token') ? true : false,
                            'creator_info' => $creatorInfo
                        ]
                    ], 401);
                }
                
                if (isset($data['data']) && (is_object($data['data']) || is_array($data['data']))) {
                    $item = (array) $data['data'];
                    
                    Log::info('Processing upsert with validated session', [
                        'book' => $item['book'] ?? 'not_set',
                        'creator_from_server' => $creatorInfo['creator'],
                        'creator_token_present' => $creatorInfo['creator_token'] ? 'yes' : 'no',
                        'auth_user' => Auth::user() ? Auth::user()->name : 'anonymous'
                    ]);
                    
                    // For upsert, we need to handle existing records carefully
                    $bookId = $item['book'] ?? null;
                    $citationId = $item['citationID'] ?? null;
                    
                    if (!$bookId) {
                        return response()->json([
                            'success' => false,
                            'message' => 'Book ID is required'
                        ], 400);
                    }
                    
                    // Check if record already exists and if user has permission to update it
                    $existingRecord = PgLibrary::where('book', $bookId)
                        ->where('citationID', $citationId)
                        ->first();
                    
                    if ($existingRecord) {
                        Log::info('Found existing record, checking permissions', [
                            'existing_creator' => $existingRecord->creator,
                            'existing_creator_token_present' => $existingRecord->creator_token ? 'yes' : 'no',
                            'current_creator' => $creatorInfo['creator'],
                            'current_creator_token_present' => $creatorInfo['creator_token'] ? 'yes' : 'no'
                        ]);
                        
                        // Check if user can modify this existing record
                        $user = Auth::user();
                        $canModify = false;
                        $reason = '';
                        
                        if ($user && $existingRecord->creator === $user->name) {
                            // Authenticated user owns the record
                            $canModify = true;
                            $reason = 'authenticated_user_owns_record';
                        } elseif (!$user && $existingRecord->creator_token && $existingRecord->creator_token === $creatorInfo['creator_token']) {
                            // Anonymous user owns the record
                            $canModify = true;
                            $reason = 'anonymous_user_owns_record';
                        } elseif (!$existingRecord->creator && !$existingRecord->creator_token) {
                            // Orphaned record, can be claimed
                            $canModify = true;
                            $reason = 'orphaned_record_claimed';
                        } else {
                            $reason = 'no_matching_ownership';
                        }
                        
                        Log::info('Permission check result', [
                            'can_modify' => $canModify,
                            'reason' => $reason,
                            'existing_creator' => $existingRecord->creator,
                            'existing_token_match' => $existingRecord->creator_token === $creatorInfo['creator_token']
                        ]);
                        
                        if (!$canModify) {
                            return response()->json([
                                'success' => false,
                                'message' => 'Access denied: Cannot modify this library record',
                                'debug' => [
                                    'reason' => $reason,
                                    'existing_creator' => $existingRecord->creator,
                                    'existing_has_token' => $existingRecord->creator_token ? true : false,
                                    'current_user' => $user ? $user->name : null,
                                    'current_has_token' => $creatorInfo['creator_token'] ? true : false,
                                    'tokens_match' => $existingRecord->creator_token === $creatorInfo['creator_token']
                                ]
                            ], 403);
                        }
                    } else {
                        Log::info('No existing record found, will create new one');
                    }
                    
                    // Step 1: Perform upsert and ensure it's committed
                    $record = PgLibrary::updateOrCreate(
                        [
                            'book' => $bookId,
                            'citationID' => $citationId,
                        ],
                        [
                            'title' => $item['title'] ?? null,
                            'author' => $item['author'] ?? null,
                            'creator' => $creatorInfo['creator'], // Use server-determined creator
                            'creator_token' => $creatorInfo['creator_token'], // Use server-determined token
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
                    
                    Log::info('Library record upserted successfully', [
                        'book' => $bookId,
                        'was_existing' => $existingRecord ? true : false
                    ]);
                    
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
                Log::error('Upsert failed: ' . $e->getMessage(), [
                    'trace' => $e->getTraceAsString()
                ]);
                return response()->json([
                    'success' => false,
                    'message' => 'Failed to sync data',
                    'error' => $e->getMessage()
                ], 500);
            }
        });
    }

    public function bulkCreate(Request $request)
    {
        // Use database transaction to ensure atomicity
        return DB::transaction(function () use ($request) {
            try {
                $data = $request->all();
                
                // Get creator info based on auth state
                $creatorInfo = $this->getCreatorInfo($request);
                if (!$creatorInfo['valid']) {
                    return response()->json([
                        'success' => false,
                        'message' => 'Invalid session'
                    ], 401);
                }
                
                if (isset($data['data']) && is_object($data['data'])) {
                    $item = $data['data'];
                    
                    $record = [
                        'book' => $item['book'] ?? null,
                        'citationID' => $item['citationID'] ?? null,
                        'title' => $item['title'] ?? null,
                        'author' => $item['author'] ?? null,
                        'creator' => $creatorInfo['creator'], // Use server-determined creator
                        'creator_token' => $creatorInfo['creator_token'], // Use server-determined token
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
                    
                    Log::info('Creating library record with auth info', [
                        'book' => $record['book'],
                        'creator' => $record['creator'],
                        'creator_token' => $record['creator_token'] ? 'present' : 'null',
                        'auth_user' => Auth::user() ? Auth::user()->name : 'anonymous'
                    ]);
                    
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

    // ... rest of your internal methods stay the same ...
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

    /**
         * Update only the timestamp for a library record
         * This allows any authenticated user to update the last activity timestamp
         */
        public function updateTimestamp(Request $request)
        {
            try {
                $data = $request->all();
                
                // Get creator info based on auth state
                $creatorInfo = $this->getCreatorInfo($request);
                if (!$creatorInfo['valid']) {
                    return response()->json([
                        'success' => false,
                        'message' => 'Invalid session'
                    ], 401);
                }
                
                $bookId = $data['book'] ?? null;
                $timestamp = $data['timestamp'] ?? null;
                
                if (!$bookId) {
                    return response()->json([
                        'success' => false,
                        'message' => 'Book ID is required'
                    ], 400);
                }
                
                if (!$timestamp) {
                    return response()->json([
                        'success' => false,
                        'message' => 'Timestamp is required'
                    ], 400);
                }
                
                // Find the library record by book ID
                $libraryRecord = PgLibrary::where('book', $bookId)->first();
                
                if (!$libraryRecord) {
                    return response()->json([
                        'success' => false,
                        'message' => 'Library record not found'
                    ], 404);
                }
                
                // Update only the timestamp - any valid user can do this
                $libraryRecord->update([
                    'timestamp' => $timestamp,
                    'updated_at' => now()
                ]);
                
                Log::info('Library timestamp updated', [
                    'book' => $bookId,
                    'timestamp' => $timestamp,
                    'updated_by' => $creatorInfo['creator'] ?? 'anonymous'
                ]);
                
                return response()->json([
                    'success' => true,
                    'message' => 'Library timestamp updated successfully',
                    'book' => $bookId,
                    'timestamp' => $timestamp
                ]);
                
            } catch (\Exception $e) {
                Log::error('Update timestamp failed: ' . $e->getMessage());
                return response()->json([
                    'success' => false,
                    'message' => 'Failed to update timestamp',
                    'error' => $e->getMessage()
                ], 500);
            }
        }
}