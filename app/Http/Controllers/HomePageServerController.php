<?php

/*This controller pulls the ranking columns from the library data table in postgreSQL:
[recent, total_highlights, hypercite_connections, reference_connections, created_at]
It processes them into three special books in the nodes table:
[most-recent, most-connected, most-lit]

This is calculated according to the following logic:
Most Recent: Uses the recent column directly (no processing needed)
Most Connected: Ranks by hypercite_connections, then reference_connections as a
  second key — so any text with a minted hypercite outranks every text without
  one, and below that line the not-yet-minted reference edges decide.
Most Lit: Ranks by hypercite_connections + total_highlights — human annotation
  activity, deliberately EXCLUDING the machine-detected reference edges so it
  says something different from Most Connected.
Both scores are written by App\Services\Connections\ConnectionCountQuery, which
owns the definition (both directions, distinct counterparts, inbound weighted
double, self/same-owner edges dropped). created_at is the final tiebreaker.

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

use Illuminate\Contracts\Cache\LockTimeoutException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Cache;
use Carbon\Carbon;
use App\Services\Connections\ConnectionCountQuery;

class HomePageServerController extends Controller
{
    private const CACHE_KEY = 'homepage_books_data';
    private const CACHE_TTL = 900; // 15 minutes
    private const PINNED_BOOK_ID = 'book_1773824629440';

    public function getHomePageBooks(Request $request)
    {
        // Fast path: serve the cached payload.
        $cached = Cache::get(self::CACHE_KEY);
        if ($cached !== null) {
            return $cached;
        }

        // F12: single-flight the rebuild. `Cache::remember` is NOT stampede-safe —
        // when the 15-min TTL lapses, every concurrent homepage load would otherwise
        // run generateHomePageBooks() at once and collide on the shared
        // most-recent/most-connected/most-lit node rows (unique index) → 500s + a
        // half-built homepage. Only ONE caller rebuilds under the lock; the rest
        // block briefly and then read the freshly-cached result.
        try {
            return Cache::lock(self::CACHE_KEY . ':rebuild', 60)->block(10, function () {
                return Cache::remember(self::CACHE_KEY, self::CACHE_TTL, fn () => $this->generateHomePageBooks());
            });
        } catch (LockTimeoutException $e) {
            // Couldn't acquire within 10s: serve cache if it landed, else generate
            // directly (degraded, but never error the homepage).
            return Cache::get(self::CACHE_KEY) ?? $this->generateHomePageBooks();
        }
    }

    public function updateHomePageBooks(Request $request, $forceUpdate = false)
    {
        if ($forceUpdate) {
            Cache::forget(self::CACHE_KEY);
        }

        // Serialise with the read-path rebuild (same lock) so two callers never
        // delete+insert the shared node rows at once (F12).
        try {
            return Cache::lock(self::CACHE_KEY . ':rebuild', 60)->block(10, function () {
                $result = $this->generateHomePageBooks();
                Cache::put(self::CACHE_KEY, $result, self::CACHE_TTL);
                return $result;
            });
        } catch (LockTimeoutException $e) {
            $result = $this->generateHomePageBooks();
            Cache::put(self::CACHE_KEY, $result, self::CACHE_TTL);
            return $result;
        }
    }

    private function generateHomePageBooks()
    {
        // Refresh the ranking columns FIRST, then read them. Corpus-wide and
        // set-based: this also runs inline on a cache miss, so it must never
        // become a per-book loop. Deliberately not restricted to `listed` books
        // — the harvested journal corpus is minted listed = false and its counts
        // were NULL forever because the old recompute skipped it. WHICH books
        // the homepage ranks is the separate `where('listed', true)` below.
        (new ConnectionCountQuery())->recompute();

        // Get all library records with the required columns, excluding unlisted books
        $libraryRecords = DB::table('library')
            ->select([
                'book',
                'recent',
                'total_highlights',
                'hypercite_connections',
                'reference_connections',
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
            ->whereNotIn('book', ['stats', 'most-recent', 'most-connected', 'most-lit'])
            ->where('book', 'NOT LIKE', '%/%')
            ->get();

        // Use admin connection to bypass RLS for system-generated content
        $adminDb = DB::connection('pgsql_admin');

        // Calculate rankings
        $rankings = $this->calculateRankings($libraryRecords);

        // Pin book at top of most-recent list
        $pinnedBookInRecords = $libraryRecords->contains('book', self::PINNED_BOOK_ID);
        if (!$pinnedBookInRecords) {
            $pinnedRecord = DB::table('library')
                ->select([
                    'book', 'recent', 'total_highlights', 'hypercite_connections',
                    'reference_connections',
                    'total_views', 'created_at', 'bibtex', 'title', 'author',
                    'year', 'publisher', 'journal'
                ])
                ->where('book', self::PINNED_BOOK_ID)
                ->first();

            if ($pinnedRecord) {
                $libraryRecords->push($pinnedRecord);
            }
        }

        // Shift all mostRecent rankings down by 1 and pin at position 1
        foreach ($rankings['mostRecent'] as $book => $rank) {
            $rankings['mostRecent'][$book] = $rank + 1;
        }
        $rankings['mostRecent'][self::PINNED_BOOK_ID] = 1;

        // Clear existing entries for our special books
        $adminDb->table('nodes')->whereIn('book', [
            'most-recent',
            'most-connected',
            'most-lit'
        ])->delete();

        // Clear/create library entries for our special books
        $this->createLibraryEntries($adminDb);

        // Create entries for each special book
        $this->createNodesForBook('most-recent', $libraryRecords, $rankings['mostRecent'], $adminDb);
        $this->createNodesForBook('most-connected', $libraryRecords, $rankings['mostConnected'], $adminDb);
        $this->createNodesForBook('most-lit', $libraryRecords, $rankings['mostLit'], $adminDb);

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

    private function createNodesForBook($bookName, $libraryRecords, $positionData, $adminDb)
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
            $content = '<p class="libraryCard" id="' . $positionId . '">'
                    . $citationHtml
                    . '<a href="/' . $record->book . '"><span class="open-icon">↗</span></a>'
                    . '<a href="#" class="book-actions" data-book="' . $record->book . '" title="Actions" aria-label="Actions">'
                    . '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
                    . '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>'
                    . '</svg></a>'
                    . '</p>';

            // Create the chunk entry
            $chunks[] = [
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
                // Match JavaScript bibtexProcessor.js formatting
                if ($journal = $get('journal')) {
                    $html .= ", <em>{$journal}</em>";
                }
                if ($volume = $get('volume')) {
                    $html .= ", {$volume}";
                    if ($number = $get('number')) {
                        $html .= "({$number})";
                    }
                }
                if ($year = $get('year')) {
                    $html .= " ({$year})";
                }
                if ($pages = $get('pages')) {
                    $html .= ", {$pages}";
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

        // Year (skip for articles - handled in case above)
        if ($type !== 'article' && ($year = $get('year'))) {
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
        // Only anonymize if it looks like a UUID (matches JavaScript bibtexProcessor.js logic)
        if (preg_match('/^[0-9a-fA-F-]{36}$/', $author)) {
            return 'Anon.';
        }

        return $author;
    }

    private function calculateRankings($libraryRecords)
    {
        // Most Recent: Based on created_at (newest first)
        $mostRecent = $this->rankByCreationDate($libraryRecords);

        // Most Connected: hypercite edges first, reference edges as the second
        // key — a composite metric, compared element-wise by rankByMetric. Any
        // text with a minted hypercite therefore outranks every text without one.
        $mostConnected = $this->rankByMetric(
            $libraryRecords,
            function ($record) {
                return [
                    (int) ($record->hypercite_connections ?? 0),
                    (int) ($record->reference_connections ?? 0),
                ];
            }
        );

        // Most Lit: human annotation activity — hypercite edges + hyperlights.
        // Reference edges are excluded on purpose: they are machine-detected, and
        // including them would make this rank almost identically to Most Connected.
        $mostLit = $this->rankByMetric(
            $libraryRecords,
            function($record) {
                return (int) ($record->hypercite_connections ?? 0) + (int) ($record->total_highlights ?? 0);
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

        // Sort by metric value (descending), then by created_at (ascending for
        // tiebreaker). A metric may be an ARRAY of keys (Most Connected passes
        // [hypercites, references]); PHP's <=> compares arrays element-wise, so
        // a composite metric needs no special case here.
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

    // The per-book stats recompute that used to live here (recalculateLibraryStats
    // + countCitationsForBook + isSelfCitation) is gone: it ran two queries PER
    // BOOK, counted INBOUND hypercites only, and skipped every `listed = false`
    // book — which is the whole harvested journal corpus. Its replacement is the
    // set-based App\Services\Connections\ConnectionCountQuery, called at the top
    // of generateHomePageBooks(). Do not reintroduce a second definition of
    // "how connected is this book" here.
}
