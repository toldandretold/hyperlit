<?php

/*This controller pulls four columns from the library data table in postgreSQL: 
[recent, total_highlights, total_hypercites, created_at]
It processes them into three special books in the node_chunks table: 
[most-recent, most-connected, most-lit]

This is calculated according to the following logic:
Most Recent: Uses the recent column directly (no processing needed)
Most Connected: Ranks books by total_citations in descending order, with created_at as tiebreaker
Most Lit: Ranks books by the sum of total_citations + total_highlights in descending order, with created_at as tiebreaker

The ranking logic ensures that:
Higher metric values get lower ranking numbers (1 = best)
When two books have the same metric value, the one created first gets the better ranking
Each book gets a unique ranking number (1, 2, 3, etc.) 

call this in terminal to update the node_chunks table with:

curl -X POST http://localhost:8000/api/homepage/books/update \
  -H "Content-Type: application/json" \
  -H "Accept: application/json"

*/

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Carbon\Carbon;

class HomePageServerController extends Controller
{
    public function updateHomePageBooks(Request $request)
    {
        // Get all library records with the required columns
        $libraryRecords = DB::table('library')
            ->select([
                'book',
                'recent',
                'total_highlights',
                'total_citations',
                'total_views',
                'created_at',
                'bibtex'
            ])
            ->get();

        // Calculate rankings
        $rankings = $this->calculateRankings($libraryRecords);

        // Clear existing entries for our special books
        DB::table('node_chunks')->whereIn('book', [
            'most-recent', 
            'most-connected', 
            'most-lit'
        ])->delete();

        // Create entries for each special book
        $this->createNodeChunksForBook('most-recent', $libraryRecords, 'recent');
        $this->createNodeChunksForBook('most-connected', $libraryRecords, $rankings['mostConnected']);
        $this->createNodeChunksForBook('most-lit', $libraryRecords, $rankings['mostLit']);

        return response()->json([
            'success' => true,
            'message' => 'Homepage books updated successfully',
            'books_processed' => $libraryRecords->count(),
            'timestamp' => Carbon::now()
        ]);
    }

    private function createNodeChunksForBook($bookName, $libraryRecords, $positionData)
    {
        $chunks = [];
        $currentTime = Carbon::now();

        foreach ($libraryRecords as $record) {
            // Get the position ID based on book type
            if ($bookName === 'most-recent') {
                $positionId = $record->recent;
            } else {
                $positionId = $positionData[$record->book] ?? null;
            }

            if ($positionId === null) {
                continue;
            }

            // Calculate chunk_id (0 for positions 1-100, 1 for 101-200, etc.)
            $chunkId = floor(($positionId - 1) / 100);

            // Generate content with citation
            $citationHtml = $this->parseBibtexToHtml($record->bibtex);
            $content = '<p class="libraryCard" id="' . $positionId . '">' . $citationHtml . '</p>';

            // Create the chunk entry
            $chunks[] = [
                'raw_json' => json_encode([
                    'original_book' => $record->book,
                    'position_type' => $bookName,
                    'position_id' => $positionId,
                    'bibtex' => $record->bibtex
                ]),
                'book' => $bookName,
                'chunk_id' => $chunkId,
                'startLine' => $positionId,
                'footnotes' => null,
                'hypercites' => null,
                'hyperlights' => null,
                'content' => $content,
                'plainText' => strip_tags($citationHtml),
                'type' => 'p',
                'created_at' => $currentTime,
                'updated_at' => $currentTime
            ];
        }

        // Insert all chunks for this book
        if (!empty($chunks)) {
            DB::table('node_chunks')->insert($chunks);
        }
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

        // Author
        if ($author = $get('author')) {
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

        // URL
        if ($url = $get('url')) {
            $html .= ". <a href=\"{$url}\" target=\"_blank\">Available online</a>";
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

    private function calculateRankings($libraryRecords)
    {
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
}
