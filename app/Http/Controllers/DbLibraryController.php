<?php

namespace App\Http\Controllers;

use App\Models\PgLibrary;
use App\Models\PgHypercite;  // Add this line
use App\Models\PgHyperlight;
use Illuminate\Http\Request;

class DbLibraryController extends Controller
{
    public function bulkCreate(Request $request)
    {
        try {
            $data = $request->all();
            
            // Library data comes as a single object, not an array
            if (isset($data['data']) && is_object($data['data'])) {
                $item = $data['data'];
                
                $record = [
                    'book' => $item['book'] ?? null,
                    'citationID' => $item['citationID'] ?? null,
                    'title' => $item['title'] ?? null,
                    'author' => $item['author'] ?? null,
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
                
                PgLibrary::create($record); // Use create for single record
                
                return response()->json(['success' => true]);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage()
            ], 500);
        }
    }

    // Add this new upsert method
    public function upsert(Request $request)
    {
        try {
            $data = $request->all();
            
            // Library data comes as a single object, not an array
            if (isset($data['data']) && (is_object($data['data']) || is_array($data['data']))) {
                $item = (array) $data['data']; // Convert to array for easier handling
                
                PgLibrary::updateOrCreate(
                    [
                        'book' => $item['book'] ?? null,
                        'citationID' => $item['citationID'] ?? null,
                    ],
                    [
                        'title' => $item['title'] ?? null,
                        'author' => $item['author'] ?? null,
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
                
                return response()->json(['success' => true, 'message' => 'Library synced successfully']);
            }
            
            return response()->json([
                'success' => false,
                'message' => 'Invalid data format'
            ], 400);
            
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Failed to sync data',
                'error' => $e->getMessage()
            ], 500);
        }
    }



        /**
     * Update library statistics for a specific book
     * Call this from terminal using: 
     * curl -X POST http://localhost:8000/api/library/update-all-stats \
        -H "Content-Type: application/json" \
         -H "Accept: application/json"
     */
    public function updateBookStats($book)
    {
        try {
            // Update recent column (this affects all books, so we run it)
            $this->updateRecentColumn();
            
            // Update cites for specific book
            $hypercites = PgHypercite::where('book', $book)->get();
            $totalCites = 0;
            
            foreach ($hypercites as $hypercite) {
                if ($hypercite->citedIN) {
                    // Check if citedIN is already an array or needs to be decoded
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
            
            return response()->json([
                'success' => true,
                'message' => "Stats updated for book: {$book}",
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
    }

/**
     * Update the recent column based on updated_at timestamp ordering
     */
    public function updateRecentColumn()
    {
        try {
            // Get all library records ordered by updated_at desc (most recent first)
            $libraryRecords = PgLibrary::orderBy('updated_at', 'desc')->get();
            
            // Update each record with its position number
            foreach ($libraryRecords as $index => $record) {
                $record->update(['recent' => $index + 1]);
            }

            return response()->json([
                'success' => true,
                'message' => 'Recent column updated successfully',
                'updated_count' => $libraryRecords->count()
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Error updating recent column: ' . $e->getMessage()
            ], 500);
        }
    }

   
    /**
     * Update the total_citations column based on hypercites data
     */
    public function updateTotalCitesColumn()
    {
        try {
            // Get all unique books from library
            $books = PgLibrary::distinct()->pluck('book');
            
            foreach ($books as $book) {
                // Get all hypercites for this book
                $hypercites = PgHypercite::where('book', $book)->get();
                
                $totalCites = 0;
                
                foreach ($hypercites as $hypercite) {
                    if ($hypercite->citedIN) {
                        // Check if citedIN is already an array or needs to be decoded
                        $citedInArray = is_array($hypercite->citedIN) 
                            ? $hypercite->citedIN 
                            : json_decode($hypercite->citedIN, true);
                        
                        if (is_array($citedInArray)) {
                            foreach ($citedInArray as $citation) {
                                // Check if it's a self-citation
                                if (!$this->isSelfCitation($citation, $book)) {
                                    $totalCites++;
                                }
                            }
                        }
                    }
                }
                
                // Update the library record for this book
                PgLibrary::where('book', $book)->update(['total_citations' => $totalCites]);
            }

            return response()->json([
                'success' => true,
                'message' => 'Total cites column updated successfully',
                'updated_books' => $books->count()
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Error updating total cites column: ' . $e->getMessage()
            ], 500);
        }
    }


    /**
     * Update the total_highlights column based on hyperlights data
     */
    public function updateTotalHighlightsColumn()
    {
        try {
            // Get all unique books from library
            $books = PgLibrary::distinct()->pluck('book');
            
            foreach ($books as $book) {
                // Count hyperlights for this book
                $highlightCount = PgHyperlight::where('book', $book)->count(); // Changed
                
                // Update the library record for this book
                PgLibrary::where('book', $book)->update(['total_highlights' => $highlightCount]);
            }

            return response()->json([
                'success' => true,
                'message' => 'Total highlights column updated successfully',
                'updated_books' => $books->count()
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Error updating total highlights column: ' . $e->getMessage()
            ], 500);
        }
    }

    /**
     * Update the total_views column (placeholder for now)
     */
    public function updateTotalViewsColumn()
    {
        try {
            // Placeholder implementation - you can implement this later
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

    /**
     * Update all library statistics columns
     */
    public function updateAllLibraryStats()
    {
        try {
            $this->updateRecentColumn();
            $this->updateTotalCitesColumn();
            $this->updateTotalHighlightsColumn();
            
            return response()->json([
                'success' => true,
                'message' => 'All library statistics updated successfully'
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Error updating library statistics: ' . $e->getMessage()
            ], 500);
        }
    }

    /**
     * Helper method to determine if a citation is a self-citation
     */
    private function isSelfCitation($citation, $currentBook)
    {
        // Handle format like "/book_1748157091481#hypercite_qjmfz187"
        if (preg_match('/^\/([^#]+)#/', $citation, $matches)) {
            $citedBook = $matches[1];
            return $citedBook === $currentBook;
        }
        
        // Handle format like "/Marx1867Capital/HL_1748268559841#hypercite_f9bob1ol"
        if (preg_match('/^\/([^\/]+)\//', $citation, $matches)) {
            $citedBook = $matches[1];
            return $citedBook === $currentBook;
        }
        
        // If we can't parse the format, assume it's not a self-citation
        return false;
    }

     


}



