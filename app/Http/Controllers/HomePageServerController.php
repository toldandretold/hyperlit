<?php

/*This controller pulls four columns from the library data table in postgreSQL: 
[recent, total_highlights, total_hypercites, created_at]
It processes them into three special books in the nodes table: 
[most-recent, most-connected, most-lit]

This is calculated according to the following logic:
Most Recent: Uses the recent column directly (no processing needed)
Most Connected: Ranks books by total_citations in descending order, with created_at as tiebreaker
Most Lit: Ranks books by the sum of total_citations + total_highlights in descending order, with created_at as tiebreaker

The ranking logic ensures that:
Higher metric values get lower ranking numbers (1 = best)
When two books have the same metric value, the one created first gets the better ranking
Each book gets a unique ranking number (1, 2, 3, etc.) 

call this in terminal to update the nodes table with:

curl -X POST http://localhost:8000/api/homepage/books/update \
  -H "Content-Type: application/json" \
  -H "Accept: application/json"

*/

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Cache;
use Carbon\Carbon;
use App\Models\PgHyperlight;
use App\Models\PgHypercite;

class HomePageServerController extends Controller
{
    private const CACHE_KEY = 'homepage_books_data';
    private const CACHE_TTL = 900; // 15 minutes

    public function getHomePageBooks(Request $request)
    {
        return Cache::remember(self::CACHE_KEY, self::CACHE_TTL, function () {
            return $this->generateHomePageBooks();
        });
    }

    public function updateHomePageBooks(Request $request, $forceUpdate = false)
    {
        if ($forceUpdate) {
            Cache::forget(self::CACHE_KEY);
        }

        return $this->generateHomePageBooks();
    }

    private function generateHomePageBooks()
    {
        // Get all library records with the required columns, excluding unlisted books
        $libraryRecords = DB::table('library')
            ->select([
                'book',
                'recent',
                'total_highlights',
                'total_citations',
                'total_views',
                'created_at',
                'bibtex',
                'title',
                'author',
                'year',
                'publisher',
                'journal'
            ])
            ->where('listed', true)
            ->whereNotIn('visibility', ['private', 'deleted'])
            ->get();

        // Use admin connection to bypass RLS for system-generated content
        $adminDb = DB::connection('pgsql_admin');

        // Recalculate stats from hyperlights/hypercites tables to ensure accuracy
        $this->recalculateLibraryStats($libraryRecords, $adminDb);

        // Calculate rankings
        $rankings = $this->calculateRankings($libraryRecords);

        // Clear existing entries for our special books
        $adminDb->table('nodes')->whereIn('book', [
            'most-recent',
            'most-connected',
            'most-lit'
        ])->delete();

        // Clear/create library entries for our special books
        $this->createLibraryEntries($adminDb);

        // Create entries for each special book
        $this->createNodeChunksForBook('most-recent', $libraryRecords, $rankings['mostRecent'], $adminDb);
        $this->createNodeChunksForBook('most-connected', $libraryRecords, $rankings['mostConnected'], $adminDb);
        $this->createNodeChunksForBook('most-lit', $libraryRecords, $rankings['mostLit'], $adminDb);

        return response()->json([
            'success' => true,
            'message' => 'Homepage books updated successfully',
            'books_processed' => $libraryRecords->count(),
            'timestamp' => Carbon::now()
        ]);
    }

    private function createLibraryEntries($adminDb)
    {
        $currentTime = Carbon::now();
        $specialBooks = ['most-recent', 'most-connected', 'most-lit'];

        // Delete existing entries for special books
        $adminDb->table('library')->whereIn('book', $specialBooks)->delete();

        // Create new entries
        $libraryEntries = [];
        foreach ($specialBooks as $bookId) {
            $libraryEntries[] = [
                'book' => $bookId,
                'author' => 'hyperlit',
                'visibility' => 'public',
                'listed' => false,
                'raw_json' => json_encode([
                    'type' => 'generated',
                    'purpose' => 'homepage_ranking',
                    'book_id' => $bookId
                ]),
                'timestamp' => round(microtime(true) * 1000),
                'created_at' => $currentTime,
                'updated_at' => $currentTime
            ];
        }

        // Insert all library entries
        $adminDb->table('library')->insert($libraryEntries);
    }

    private function createNodeChunksForBook($bookName, $libraryRecords, $positionData, $adminDb)
    {
        $chunks = [];
        $currentTime = Carbon::now();

        foreach ($libraryRecords as $record) {
            // Get the position ID based on book type
            $positionId = $positionData[$record->book] ?? null;

            if ($positionId === null) {
                continue;
            }

            // Calculate chunk_id (0 for positions 1-100, 1 for 101-200, etc.)
            $chunkId = floor(($positionId - 1) / 100);

            // Generate content with citation
            $citationHtml = $this->generateCitationHtml($record);
            $content = '<p class="libraryCard" id="' . $positionId . '">' . $citationHtml . '<a href="/' . $record->book . '"><span class="open-icon">↗</span>' . '</p>';

            // Create the chunk entry
            $chunks[] = [
                'raw_json' => json_encode([
                    'original_book' => $record->book,
                    'position_type' => $bookName,
                    'position_id' => $positionId,
                    'bibtex' => $record->bibtex,
                    'title' => $record->title ?? null,
                    'author' => $record->author ?? null,
                    'year' => $record->year ?? null
                ]),
                'book' => $bookName,
                'chunk_id' => $chunkId,
                'startLine' => $positionId,
                'node_id' => $bookName . '_' . $record->book . '_card',
                'content' => $content,
                'plainText' => strip_tags($citationHtml),
                'type' => 'p',
                'created_at' => $currentTime,
                'updated_at' => $currentTime
            ];
        }

        // Insert all chunks for this book
        if (!empty($chunks)) {
            $adminDb->table('nodes')->insert($chunks);
        }
    }

    private function generateCitationHtml($record)
    {
        // First try to parse bibtex if it exists
        if (!empty($record->bibtex)) {
            $citationHtml = $this->parseBibtexToHtml($record->bibtex);
            if (!empty($citationHtml)) {
                return $citationHtml;
            }
        }

        // Fallback to using individual fields
        return $this->generateFallbackCitation($record);
    }

    private function generateFallbackCitation($record)
    {
        $html = '';

        // Check if we have any meaningful data
        $hasTitle = !empty($record->title);
        $hasAuthor = !empty($record->author);
        $hasYear = !empty($record->year);
        $hasPublisher = !empty($record->publisher);
        $hasJournal = !empty($record->journal);

        // If we have no meaningful citation data, use default
        if (!$hasTitle && !$hasAuthor && !$hasYear && !$hasPublisher && !$hasJournal) {
            return 'Anon., <em>Unreferenced</em>';
        }

        // Author
        if ($hasAuthor) {
            $author = $this->anonymizeIfNeeded($record->author);
            $html .= "<strong>{$author}</strong>. ";
        } else {
            $html .= "<strong>Anon.</strong> ";
        }

        // Title
        if ($hasTitle) {
            // Determine if it should be italicized (assume book if no journal)
            if ($hasJournal) {
                $html .= "\"{$record->title}.\" ";
            } else {
                $html .= "<em>{$record->title}</em>. ";
            }
        } else {
            $html .= "<em>Unreferenced</em>. ";
        }

        // Journal
        if ($hasJournal) {
            $html .= "<em>{$record->journal}</em>. ";
        }

        // Publisher
        if ($hasPublisher && !$hasJournal) {
            $html .= "{$record->publisher}. ";
        }

        // Year
        if ($hasYear) {
            $html .= "{$record->year}";
        }

        // Clean up extra spaces and add final period if needed
        $html = preg_replace('/\s+/', ' ', $html);
        $html = trim($html);
        
        if (!empty($html) && !in_array(substr($html, -1), ['.', '!', '?'])) {
            $html .= '.';
        }

        return $html;
    }

    private function parseBibtexToHtml($bibtex)
    {
        if (empty($bibtex)) {
            return '';
        }

        // Parse BibTeX entry
        $parsed = $this->parseBibtexEntry($bibtex);
        
        if (empty($parsed)) {
            return '';
        }

        // Generate HTML based on entry type
        return $this->generateHtmlCitation($parsed);
    }

    private function parseBibtexEntry($bibtex)
    {
        // Remove extra whitespace and normalize
        $bibtex = trim($bibtex);
        
        // Match the entry type and key
        if (!preg_match('/@(\w+)\s*\{\s*([^,]+)\s*,/', $bibtex, $matches)) {
            return null;
        }

        $entryType = strtolower($matches[1]);
        $key = trim($matches[2]);

        // Extract fields
        $fields = [];
        
        // Match field = {value} or field = "value" patterns
        preg_match_all('/(\w+)\s*=\s*[{"](.*?)["}](?=\s*,|\s*})/s', $bibtex, $fieldMatches, PREG_SET_ORDER);
        
        foreach ($fieldMatches as $match) {
            $fieldName = strtolower(trim($match[1]));
            $fieldValue = trim($match[2]);
            $fields[$fieldName] = $fieldValue;
        }

        return [
            'type' => $entryType,
            'key' => $key,
            'fields' => $fields
        ];
    }

    private function generateHtmlCitation($parsed)
    {
        $fields = $parsed['fields'];
        $type = $parsed['type'];

        // Helper function to get field value
        $get = function($field) use ($fields) {
            return $fields[$field] ?? '';
        };

        $html = '';

        // Author with anonymization check
        if ($author = $get('author')) {
            // Check if author should be anonymized
            $author = $this->anonymizeIfNeeded($author);
            $html .= "<strong>{$author}</strong>. ";
        }
        // Title
        if ($title = $get('title')) {
            if (in_array($type, ['book', 'inbook', 'incollection'])) {
                $html .= "<em>{$title}</em>. ";
            } else {
                $html .= "\"{$title}.\" ";
            }
        }

        // Handle different entry types
        switch ($type) {
            case 'article':
                if ($journal = $get('journal')) {
                    $html .= "<em>{$journal}</em>";
                }
                if ($volume = $get('volume')) {
                    $html .= " {$volume}";
                }
                if ($number = $get('number')) {
                    $html .= ".{$number}";
                }
                if ($pages = $get('pages')) {
                    $html .= " ({$pages})";
                }
                break;

            case 'book':
            case 'inbook':
                if ($publisher = $get('publisher')) {
                    $html .= "{$publisher}";
                }
                if ($address = $get('address')) {
                    $html .= ", {$address}";
                }
                break;

            case 'incollection':
                if ($booktitle = $get('booktitle')) {
                    $html .= "In <em>{$booktitle}</em>";
                }
                if ($editor = $get('editor')) {
                    $html .= ", edited by {$editor}";
                }
                if ($publisher = $get('publisher')) {
                    $html .= ". {$publisher}";
                }
                break;

            case 'inproceedings':
            case 'conference':
                if ($booktitle = $get('booktitle')) {
                    $html .= "In <em>{$booktitle}</em>";
                }
                if ($organization = $get('organization')) {
                    $html .= ". {$organization}";
                }
                break;

            case 'phdthesis':
            case 'mastersthesis':
                if ($school = $get('school')) {
                    $html .= "{$school}";
                }
                break;

            case 'techreport':
                if ($institution = $get('institution')) {
                    $html .= "{$institution}";
                }
                if ($number = $get('number')) {
                    $html .= ", Technical Report {$number}";
                }
                break;

            case 'misc':
            case 'unpublished':
                if ($howpublished = $get('howpublished')) {
                    $html .= "{$howpublished}";
                }
                break;
        }

        // Year
        if ($year = $get('year')) {
            $html .= ", {$year}";
        }

        // Pages (if not already added)
        if (!in_array($type, ['article']) && ($pages = $get('pages'))) {
            $html .= ", pp. {$pages}";
        }

        // DOI
        if ($doi = $get('doi')) {
            $html .= ". DOI: <a href=\"https://doi.org/{$doi}\" target=\"_blank\">{$doi}</a>";
        }

        // Note
        if ($note = $get('note')) {
            $html .= ". {$note}";
        }

        // Clean up extra spaces and add final period if needed
        $html = preg_replace('/\s+/', ' ', $html);
        $html = trim($html);
        
        if (!empty($html) && !in_array(substr($html, -1), ['.', '!', '?'])) {
            $html .= '.';
        }

        return $html;
    }

    private function anonymizeIfNeeded($author)
    {
        // Define criteria for anonymization
        $shouldAnonymize = false;
        
        // Check if it's too long (adjust threshold as needed)
        if (strlen($author) > 50) {
            $shouldAnonymize = true;
        }
        
        // Check if it looks like a UUID
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $author)) {
            $shouldAnonymize = true;
        }
        
        // Check if it contains suspicious patterns
        if (preg_match('/^[0-9a-f]{32,}$/i', $author) || // Long hex strings
            preg_match('/^[A-Za-z0-9+\/]{20,}={0,2}$/', $author) || // Base64-like
            strlen($author) > 30 && !preg_match('/\s/', $author)) { // Long string without spaces
            $shouldAnonymize = true;
        }
        
        return $shouldAnonymize ? 'Anon.' : $author;
    }

    private function calculateRankings($libraryRecords)
    {
        // Most Recent: Based on created_at (newest first)
        $mostRecent = $this->rankByCreationDate($libraryRecords);

        // Most Connected: Based on total_citations
        $mostConnected = $this->rankByMetric(
            $libraryRecords, 
            'total_citations'
        );

        // Most Lit: Based on total_citations + total_highlights
        $mostLit = $this->rankByMetric(
            $libraryRecords, 
            function($record) {
                return ($record->total_citations ?? 0) + ($record->total_highlights ?? 0);
            }
        );

        return [
            'mostRecent' => $mostRecent,
            'mostConnected' => $mostConnected,
            'mostLit' => $mostLit
        ];
    }

    private function rankByMetric($records, $metricCallback)
    {
        // Convert records to array and calculate metric values
        $recordsWithMetric = $records->map(function ($record) use ($metricCallback) {
            if (is_callable($metricCallback)) {
                $metricValue = $metricCallback($record);
            } else {
                $metricValue = $record->{$metricCallback} ?? 0;
            }

            return [
                'book' => $record->book,
                'metric_value' => $metricValue,
                'created_at' => $record->created_at
            ];
        })->toArray();

        // Sort by metric value (descending), then by created_at (ascending for tiebreaker)
        usort($recordsWithMetric, function ($a, $b) {
            // First compare by metric value (higher is better, so descending)
            if ($a['metric_value'] !== $b['metric_value']) {
                return $b['metric_value'] <=> $a['metric_value'];
            }
            
            // If metric values are equal, sort by created_at (earlier is better)
            return strtotime($a['created_at']) <=> strtotime($b['created_at']);
        });

        // Assign rankings (1 = best/highest)
        $rankings = [];
        foreach ($recordsWithMetric as $index => $record) {
            $rankings[$record['book']] = $index + 1;
        }

        return $rankings;
    }

    private function rankByCreationDate($records)
    {
        // Convert records to array with creation dates
        $recordsWithDate = $records->map(function ($record) {
            return [
                'book' => $record->book,
                'created_at' => $record->created_at
            ];
        })->toArray();

        // Sort by created_at (descending - newest first)
        usort($recordsWithDate, function ($a, $b) {
            return strtotime($b['created_at']) <=> strtotime($a['created_at']);
        });

        // Assign rankings (1 = most recent)
        $rankings = [];
        foreach ($recordsWithDate as $index => $record) {
            $rankings[$record['book']] = $index + 1;
        }

        return $rankings;
    }

    public static function invalidateCache()
    {
        Cache::forget(self::CACHE_KEY);
    }

    /**
     * Recalculate total_highlights and total_citations for all listed books.
     * Called before ranking calculation to ensure fresh stats.
     */
    private function recalculateLibraryStats($libraryRecords, $adminDb)
    {
        foreach ($libraryRecords as $record) {
            $highlightCount = PgHyperlight::where('book', $record->book)->count();
            $totalCites = $this->countCitationsForBook($record->book);

            $adminDb->table('library')->where('book', $record->book)->update([
                'total_highlights' => $highlightCount,
                'total_citations' => $totalCites
            ]);

            // Update the record object so we don't need to re-fetch
            $record->total_highlights = $highlightCount;
            $record->total_citations = $totalCites;
        }
    }

    /**
     * Count citations for a book, excluding self-citations.
     * Parses citedIN arrays from hypercites table.
     */
    private function countCitationsForBook($book)
    {
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

        return $totalCites;
    }

    /**
     * Check if a citation references the same book (self-citation).
     */
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
