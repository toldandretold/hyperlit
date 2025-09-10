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

    public function test(Request $request)
    {
        $creatorInfo = $this->getCreatorInfo($request);
        
        return response()->json([
            'success' => true,
            'message' => 'DbLibraryController is working!',
            'timestamp' => now(),
            'auth_info' => [
                'authenticated_user' => Auth::user() ? Auth::user()->name : null,
                'creator_info' => $creatorInfo,
                'cookies' => $request->cookies->all(),
                'headers' => [
                    'origin' => $request->header('Origin'),
                    'user_agent' => $request->header('User-Agent'),
                ]
            ]
        ]);
    }

    /**
     * Delete a book and all associated records. Only the owner (creator) may delete.
     */
    public function destroy(Request $request, string $book)
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['success' => false, 'message' => 'Unauthorized'], 401);
        }

        $record = DB::table('library')->where('book', $book)->first();
        if (!$record) {
            return response()->json(['success' => false, 'message' => 'Book not found'], 404);
        }

        if ($record->creator !== $user->name) {
            return response()->json(['success' => false, 'message' => 'Forbidden'], 403);
        }

        DB::beginTransaction();
        try {
            DB::table('node_chunks')->where('book', $book)->delete();
            DB::table('footnotes')->where('book', $book)->delete();
            DB::table('bibliography')->where('book', $book)->delete();
            DB::table('hyperlights')->where('book', $book)->delete();
            DB::table('hypercites')->where('book', $book)->delete();
            DB::table('library')->where('book', $book)->delete();

            DB::commit();
            return response()->json(['success' => true]);
        } catch (\Exception $e) {
            DB::rollBack();
            Log::error('Delete book failed', ['book' => $book, 'error' => $e->getMessage()]);
            return response()->json(['success' => false, 'message' => 'Delete failed'], 500);
        }
    }


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
    public function getCreatorInfo(Request $request)
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

    // In app/Http/Controllers/DbLibraryController.php

public function upsert(Request $request)
{
    // The transaction is still a great idea to ensure the update is atomic.
    return DB::transaction(function () use ($request) {
        try {
            $data = (array) $request->input('data');
            $bookId = $data['book'] ?? null;

            if (!$bookId) {
                return response()->json(['success' => false, 'message' => 'Book ID is required'], 400);
            }

            $libraryRecord = PgLibrary::where('book', $bookId)->firstOrFail();

            $currentUserInfo = $this->getCreatorInfo($request);
            if (!$currentUserInfo['valid']) {
                return response()->json(['success' => false, 'message' => 'Invalid session'], 401);
            }

            $isOwner = ($libraryRecord->creator && $libraryRecord->creator === $currentUserInfo['creator']) ||
                       ($libraryRecord->creator_token && $libraryRecord->creator_token === $currentUserInfo['creator_token']);

            // This logic remains exactly the same.
            if ($isOwner) {
                // Truncate title to approximately 15 words
                $title = $data['title'] ?? $libraryRecord->title;
                $words = explode(' ', $title);
                if (count($words) > 15) {
                    $title = implode(' ', array_slice($words, 0, 15)) . '...';

                }
                
                $updateData = [
                    'title' => $title,
                    'author' => $data['author'] ?? $libraryRecord->author,
                    'type' => $data['type'] ?? $libraryRecord->type,
                    'timestamp' => $data['timestamp'] ?? $libraryRecord->timestamp,
                    'bibtex' => $data['bibtex'] ?? $libraryRecord->bibtex,
                    'raw_json' => json_encode($data),
                ];
            } else {
                $updateData = [
                    'timestamp' => $data['timestamp'] ?? $libraryRecord->timestamp,
                ];
            }

            // Apply the update (this is fast)
            $libraryRecord->update($updateData);

            Log::info('Library record updated successfully', [
                'book' => $bookId, 
                'is_owner' => $isOwner,
                'creator_info' => $currentUserInfo,
                'raw_request_data' => $data,
                'auth_user' => Auth::user() ? ['id' => Auth::user()->id, 'name' => Auth::user()->name] : null,
            ]);

            return response()->json([
                'success' => true,
                'message' => 'Library record updated successfully.',
                'library' => $libraryRecord->refresh(),
            ]);

        } catch (\Illuminate\Database\Eloquent\ModelNotFoundException $e) {
            return response()->json(['success' => false, 'message' => 'Book not found'], 404);
        } catch (\Exception $e) {
            Log::error('Upsert failed: ' . $e->getMessage(), ['trace' => $e->getTraceAsString()]);
            return response()->json(['success' => false, 'message' => 'Failed to sync data', 'error' => $e->getMessage()], 500);
        }
    });
}

    // In app/Http/Controllers/DbLibraryController.php
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
            
            if (isset($data['data']) && (is_object($data['data']) || is_array($data['data']))) {
                
                $item = (array) $data['data'];
                
                // Truncate title to approximately 15 words
                $title = $item['title'] ?? null;
                if ($title) {
                    $words = explode(' ', $title);
                    if (count($words) > 15) {
                        $title = implode(' ', array_slice($words, 0, 15)) . '...';
                    }

                }
                
                $record = [
                    'book' => $item['book'] ?? null,
                    'citationID' => $item['citationID'] ?? null,
                    'title' => $title,
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
                    'raw_json' => json_encode($item),
                    'created_at' => now(),
                    'updated_at' => now(),
                ];
                
                Log::info('Creating library record with auth info', [
                    'book' => $record['book'],
                    'creator' => $record['creator'],
                    'creator_type' => gettype($record['creator']),
                    'creator_token' => $record['creator_token'] ? 'present' : 'null',
                    'raw_frontend_data' => $item,
                    'auth_user' => Auth::user() ? ['id' => Auth::user()->id, 'name' => Auth::user()->name] : null,
                ]);
                
                // Use updateOrCreate to be more robust. It will create the record if it
                // doesn't exist, or update it if a duplicate request is sent.
                $createdRecord = PgLibrary::updateOrCreate(
                    ['book' => $record['book']], // The unique key to find the record
                    $record                     // The data to insert or update with
                );

                return response()->json([
                    'success' => true,
                    'message' => 'Library record created successfully.',
                    'library' => $createdRecord,
                ]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            Log::error('BulkCreate failed: ' . $e->getMessage(), ['trace' => $e->getTraceAsString()]);
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
     * Check if a citation ID (book ID) already exists in the database
     */
    public function validateCitationId(Request $request)
    {
        try {
            $citationId = $request->input('citation_id');
            
            if (!$citationId) {
                return response()->json([
                    'success' => false,
                    'message' => 'Citation ID is required'
                ], 400);
            }
            
            // Check if the citation ID exists in the book column
            $existingRecord = PgLibrary::where('book', $citationId)->first();
            
            if ($existingRecord) {
                return response()->json([
                    'success' => true,
                    'exists' => true,
                    'message' => 'Citation ID is already taken',
                    'book_url' => url('/') . '/' . $citationId,
                    'book_title' => $existingRecord->title,
                    'book_author' => $existingRecord->author
                ]);
            }
            
            return response()->json([
                'success' => true,
                'exists' => false,
                'message' => 'Citation ID is available'
            ]);
            
        } catch (\Exception $e) {
            Log::error('Citation ID validation failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Validation check failed'
            ], 500);
        }
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

