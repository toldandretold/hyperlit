<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Carbon\Carbon;
use App\Models\PgLibrary;
use App\Models\PgNodeChunk;
use App\Services\DocumentImport\FileHelpers;

class DailyStatsJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    private const BOOK_ID = 'stats';
    private const CSV_DIRECTORY = 'stats';
    private FileHelpers $fileHelpers;

    public function __construct()
    {
        $this->fileHelpers = new FileHelpers();
    }

    public function handle(): void
    {
        try {
            Log::info('Starting daily stats generation');

            $today = Carbon::now();

            // Step 1: Gather all statistics
            $stats = $this->gatherStatistics($today);

            // Step 2: Save to CSV files (historical tracking)
            $this->saveToCsv($stats, $today);

            // Step 3: Create/update the stats book
            $this->createStatsBook($stats, $today);

            Log::info('Daily stats generation completed successfully', [
                'date' => $today->toDateString(),
                'unique_creators' => $stats['unique_creators']['total'],
                'books' => $stats['activity_breakdown']['books']['total']
            ]);

        } catch (\Exception $e) {
            Log::error('Daily stats job failed', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ]);
            throw $e;
        }
    }

    private function gatherStatistics(Carbon $today): array
    {
        return [
            'unique_creators' => $this->getUniqueCreators(),
            'growth_metrics' => $this->getGrowthMetrics($today),
            'activity_breakdown' => $this->getActivityBreakdown(),
            'generated_at' => $today->toDateTimeString(),
        ];
    }

    private function getUniqueCreators(): array
    {
        // Authenticated creators (username-based)
        $authenticatedCreators = DB::table('library')
            ->whereNotNull('creator')
            ->distinct('creator')
            ->count('creator');

        // Anonymous creators (token-based)
        // Must check all tables since anonymous users might only highlight/cite
        $anonymousTokensLibrary = DB::table('library')
            ->whereNull('creator')
            ->whereNotNull('creator_token')
            ->distinct('creator_token')
            ->pluck('creator_token');

        $anonymousTokensHyperlights = DB::table('hyperlights')
            ->whereNull('creator')
            ->whereNotNull('creator_token')
            ->distinct('creator_token')
            ->pluck('creator_token');

        $anonymousTokensHypercites = DB::table('hypercites')
            ->whereNull('creator')
            ->whereNotNull('creator_token')
            ->distinct('creator_token')
            ->pluck('creator_token');

        // Merge and deduplicate
        $allAnonTokens = $anonymousTokensLibrary
            ->merge($anonymousTokensHyperlights)
            ->merge($anonymousTokensHypercites)
            ->unique();

        $anonymousCreators = $allAnonTokens->count();

        return [
            'authenticated' => $authenticatedCreators,
            'anonymous' => $anonymousCreators,
            'total' => $authenticatedCreators + $anonymousCreators,
        ];
    }

    private function getGrowthMetrics(Carbon $today): array
    {
        $periods = [
            '24h' => $today->copy()->subHours(24),
            '7d' => $today->copy()->subDays(7),
            '30d' => $today->copy()->subDays(30),
        ];

        $growth = [];

        foreach ($periods as $label => $startDate) {
            // New authenticated users (from library table)
            $newAuth = DB::table('library')
                ->whereNotNull('creator')
                ->where('created_at', '>=', $startDate)
                ->distinct('creator')
                ->count('creator');

            // New anonymous tokens (across all tables)
            $newAnonLibrary = DB::table('library')
                ->whereNull('creator')
                ->whereNotNull('creator_token')
                ->where('created_at', '>=', $startDate)
                ->distinct('creator_token')
                ->pluck('creator_token');

            $newAnonHyperlights = DB::table('hyperlights')
                ->whereNull('creator')
                ->whereNotNull('creator_token')
                ->where('created_at', '>=', $startDate)
                ->distinct('creator_token')
                ->pluck('creator_token');

            $newAnonHypercites = DB::table('hypercites')
                ->whereNull('creator')
                ->whereNotNull('creator_token')
                ->where('created_at', '>=', $startDate)
                ->distinct('creator_token')
                ->pluck('creator_token');

            $newAnon = $newAnonLibrary
                ->merge($newAnonHyperlights)
                ->merge($newAnonHypercites)
                ->unique()
                ->count();

            $growth[$label] = [
                'authenticated' => $newAuth,
                'anonymous' => $newAnon,
                'total' => $newAuth + $newAnon,
            ];
        }

        return $growth;
    }

    private function getActivityBreakdown(): array
    {
        // Books
        $booksAuthCreators = DB::table('library')
            ->whereNotNull('creator')
            ->distinct('creator')
            ->count('creator');

        $booksAnonTokens = DB::table('library')
            ->whereNull('creator')
            ->whereNotNull('creator_token')
            ->distinct('creator_token')
            ->count('creator_token');

        // Hyperlights
        $hyperlightsAuthCreators = DB::table('hyperlights')
            ->whereNotNull('creator')
            ->distinct('creator')
            ->count('creator');

        $hyperlightsAnonTokens = DB::table('hyperlights')
            ->whereNull('creator')
            ->whereNotNull('creator_token')
            ->distinct('creator_token')
            ->count('creator_token');

        // Hypercites
        $hypercitesAuthCreators = DB::table('hypercites')
            ->whereNotNull('creator')
            ->distinct('creator')
            ->count('creator');

        $hypercitesAnonTokens = DB::table('hypercites')
            ->whereNull('creator')
            ->whereNotNull('creator_token')
            ->distinct('creator_token')
            ->count('creator_token');

        return [
            'books' => [
                'total' => DB::table('library')->count(),
                'public' => DB::table('library')
                    ->where('visibility', 'public')
                    ->count(),
                'private' => DB::table('library')
                    ->where('visibility', 'private')
                    ->count(),
                'unique_creators' => $booksAuthCreators + $booksAnonTokens,
                'unique_creators_auth' => $booksAuthCreators,
                'unique_creators_anon' => $booksAnonTokens,
            ],
            'hyperlights' => [
                'total' => DB::table('hyperlights')->count(),
                'by_authenticated' => DB::table('hyperlights')
                    ->whereNotNull('creator')
                    ->count(),
                'by_anonymous' => DB::table('hyperlights')
                    ->whereNull('creator')
                    ->whereNotNull('creator_token')
                    ->count(),
                'unique_creators' => $hyperlightsAuthCreators + $hyperlightsAnonTokens,
                'unique_creators_auth' => $hyperlightsAuthCreators,
                'unique_creators_anon' => $hyperlightsAnonTokens,
            ],
            'hypercites' => [
                'total' => DB::table('hypercites')->count(),
                'by_authenticated' => DB::table('hypercites')
                    ->whereNotNull('creator')
                    ->count(),
                'by_anonymous' => DB::table('hypercites')
                    ->whereNull('creator')
                    ->whereNotNull('creator_token')
                    ->count(),
                'unique_creators' => $hypercitesAuthCreators + $hypercitesAnonTokens,
                'unique_creators_auth' => $hypercitesAuthCreators,
                'unique_creators_anon' => $hypercitesAnonTokens,
            ],
        ];
    }

    private function saveToCsv(array $stats, Carbon $today): void
    {
        $date = $today->toDateString();

        // Ensure directory exists
        Storage::disk('local')->makeDirectory(self::CSV_DIRECTORY);

        // 1. Unique creators (cumulative totals)
        $this->appendToCsv('unique_creators.csv', [
            'date' => $date,
            'authenticated' => $stats['unique_creators']['authenticated'],
            'anonymous' => $stats['unique_creators']['anonymous'],
            'total' => $stats['unique_creators']['total'],
        ]);

        // 2. Growth metrics (daily new creators)
        foreach ($stats['growth_metrics'] as $period => $data) {
            $this->appendToCsv("growth_{$period}.csv", [
                'date' => $date,
                'authenticated' => $data['authenticated'],
                'anonymous' => $data['anonymous'],
                'total' => $data['total'],
            ]);
        }

        // 3. Activity breakdown (daily totals)
        $this->appendToCsv('activity_breakdown.csv', [
            'date' => $date,
            'books_total' => $stats['activity_breakdown']['books']['total'],
            'books_public' => $stats['activity_breakdown']['books']['public'],
            'books_private' => $stats['activity_breakdown']['books']['private'],
            'books_unique_creators' => $stats['activity_breakdown']['books']['unique_creators'],
            'books_unique_creators_auth' => $stats['activity_breakdown']['books']['unique_creators_auth'],
            'books_unique_creators_anon' => $stats['activity_breakdown']['books']['unique_creators_anon'],
            'hyperlights_total' => $stats['activity_breakdown']['hyperlights']['total'],
            'hyperlights_auth' => $stats['activity_breakdown']['hyperlights']['by_authenticated'],
            'hyperlights_anon' => $stats['activity_breakdown']['hyperlights']['by_anonymous'],
            'hyperlights_unique_creators' => $stats['activity_breakdown']['hyperlights']['unique_creators'],
            'hyperlights_unique_creators_auth' => $stats['activity_breakdown']['hyperlights']['unique_creators_auth'],
            'hyperlights_unique_creators_anon' => $stats['activity_breakdown']['hyperlights']['unique_creators_anon'],
            'hypercites_total' => $stats['activity_breakdown']['hypercites']['total'],
            'hypercites_auth' => $stats['activity_breakdown']['hypercites']['by_authenticated'],
            'hypercites_anon' => $stats['activity_breakdown']['hypercites']['by_anonymous'],
            'hypercites_unique_creators' => $stats['activity_breakdown']['hypercites']['unique_creators'],
            'hypercites_unique_creators_auth' => $stats['activity_breakdown']['hypercites']['unique_creators_auth'],
            'hypercites_unique_creators_anon' => $stats['activity_breakdown']['hypercites']['unique_creators_anon'],
        ]);

        Log::info('CSV files updated', [
            'date' => $date,
            'directory' => self::CSV_DIRECTORY
        ]);
    }

    private function appendToCsv(string $filename, array $data): void
    {
        try {
            $path = self::CSV_DIRECTORY . '/' . $filename;
            $fullPath = Storage::disk('local')->path($path);

            $fileExists = Storage::disk('local')->exists($path);

            $file = fopen($fullPath, 'a');

            // Write headers if new file
            if (!$fileExists || filesize($fullPath) === 0) {
                fputcsv($file, array_keys($data));
            }

            // Append data row
            fputcsv($file, array_values($data));

            fclose($file);
        } catch (\Exception $e) {
            Log::warning('CSV append failed, continuing...', [
                'file' => $filename,
                'error' => $e->getMessage()
            ]);
        }
    }

    private function createStatsBook(array $stats, Carbon $today): void
    {
        // Step 1: Ensure stats book exists in library
        $library = PgLibrary::firstOrCreate(
            ['book' => self::BOOK_ID],
            [
                'title' => 'Hyperlit Platform Statistics',
                'author' => 'hyperlit',
                'type' => 'article',
                'visibility' => 'public',
                'listed' => true,
                'creator' => 'hyperlit',
                'creator_token' => null,
                'timestamp' => now()->timestamp,
                'raw_json' => json_encode([
                    'type' => 'generated',
                    'purpose' => 'daily_statistics',
                    'book_id' => self::BOOK_ID
                ]),
            ]
        );

        // Update timestamp to reflect latest data
        $library->update(['timestamp' => now()->timestamp]);

        // Step 2: Delete all existing nodes (full replacement strategy)
        PgNodeChunk::where('book', self::BOOK_ID)->delete();

        // Step 3: Build nodes from stats data
        $nodes = $this->buildStatsNodes($stats, $today);

        // Step 4: Bulk insert new nodes
        PgNodeChunk::insert($nodes);

        Log::info('Stats book created/updated', [
            'book' => self::BOOK_ID,
            'node_count' => count($nodes),
            'url' => url('/' . self::BOOK_ID)
        ]);
    }

    private function buildStatsNodes(array $stats, Carbon $today): array
    {
        $nodes = [];
        $startLine = 100;
        $index = 0;

        // Node 1: Title and overview
        $nodes[] = $this->createNode(
            $startLine,
            '<h1 id="' . $startLine . '">Hyperlit Platform Statistics</h1>',
            'h1',
            $index++
        );
        $startLine += 100;

        $nodes[] = $this->createNode(
            $startLine,
            '<p id="' . $startLine . '">Last updated: ' . $today->toFormattedDateString() . ' at ' . $today->format('H:i') . ' UTC</p>',
            'p',
            $index++
        );
        $startLine += 100;

        // Node 2: Unique creators section
        $nodes[] = $this->createNode(
            $startLine,
            '<h2 id="' . $startLine . '">Unique Creators (All-Time)</h2>',
            'h2',
            $index++
        );
        $startLine += 100;

        $nodes[] = $this->createNode(
            $startLine,
            sprintf(
                '<ul id="%d"><li><strong>Total:</strong> %d</li><li><strong>Authenticated:</strong> %d</li><li><strong>Anonymous:</strong> %d</li></ul>',
                $startLine,
                $stats['unique_creators']['total'],
                $stats['unique_creators']['authenticated'],
                $stats['unique_creators']['anonymous']
            ),
            'ul',
            $index++
        );
        $startLine += 100;

        // Node 3: Growth metrics section
        $nodes[] = $this->createNode(
            $startLine,
            '<h2 id="' . $startLine . '">New Creators</h2>',
            'h2',
            $index++
        );
        $startLine += 100;

        foreach ($stats['growth_metrics'] as $period => $data) {
            $periodLabel = [
                '24h' => 'Last 24 Hours',
                '7d' => 'Last 7 Days',
                '30d' => 'Last 30 Days',
            ][$period];

            $nodes[] = $this->createNode(
                $startLine,
                '<h3 id="' . $startLine . '">' . $periodLabel . '</h3>',
                'h3',
                $index++
            );
            $startLine += 100;

            $nodes[] = $this->createNode(
                $startLine,
                sprintf(
                    '<ul id="%d"><li><strong>Total:</strong> %d</li><li><strong>Authenticated:</strong> %d</li><li><strong>Anonymous:</strong> %d</li></ul>',
                    $startLine,
                    $data['total'],
                    $data['authenticated'],
                    $data['anonymous']
                ),
                'ul',
                $index++
            );
            $startLine += 100;
        }

        // Node 4: Activity breakdown section
        $nodes[] = $this->createNode(
            $startLine,
            '<h2 id="' . $startLine . '">Content Activity</h2>',
            'h2',
            $index++
        );
        $startLine += 100;

        $activity = $stats['activity_breakdown'];

        $nodes[] = $this->createNode(
            $startLine,
            '<h3 id="' . $startLine . '">Books</h3>',
            'h3',
            $index++
        );
        $startLine += 100;

        $nodes[] = $this->createNode(
            $startLine,
            sprintf(
                '<ul id="%d"><li><strong>Total:</strong> %d</li><li><strong>Public:</strong> %d</li><li><strong>Private:</strong> %d</li><li><strong>Unique Creators:</strong> %d (Auth: %d, Anon: %d)</li></ul>',
                $startLine,
                $activity['books']['total'],
                $activity['books']['public'],
                $activity['books']['private'],
                $activity['books']['unique_creators'],
                $activity['books']['unique_creators_auth'],
                $activity['books']['unique_creators_anon']
            ),
            'ul',
            $index++
        );
        $startLine += 100;

        $nodes[] = $this->createNode(
            $startLine,
            '<h3 id="' . $startLine . '">Hyperlights</h3>',
            'h3',
            $index++
        );
        $startLine += 100;

        $nodes[] = $this->createNode(
            $startLine,
            sprintf(
                '<ul id="%d"><li><strong>Total:</strong> %d</li><li><strong>By Authenticated Users:</strong> %d</li><li><strong>By Anonymous Users:</strong> %d</li><li><strong>Unique Creators:</strong> %d (Auth: %d, Anon: %d)</li></ul>',
                $startLine,
                $activity['hyperlights']['total'],
                $activity['hyperlights']['by_authenticated'],
                $activity['hyperlights']['by_anonymous'],
                $activity['hyperlights']['unique_creators'],
                $activity['hyperlights']['unique_creators_auth'],
                $activity['hyperlights']['unique_creators_anon']
            ),
            'ul',
            $index++
        );
        $startLine += 100;

        $nodes[] = $this->createNode(
            $startLine,
            '<h3 id="' . $startLine . '">Hypercites</h3>',
            'h3',
            $index++
        );
        $startLine += 100;

        $nodes[] = $this->createNode(
            $startLine,
            sprintf(
                '<ul id="%d"><li><strong>Total:</strong> %d</li><li><strong>By Authenticated Users:</strong> %d</li><li><strong>By Anonymous Users:</strong> %d</li><li><strong>Unique Creators:</strong> %d (Auth: %d, Anon: %d)</li></ul>',
                $startLine,
                $activity['hypercites']['total'],
                $activity['hypercites']['by_authenticated'],
                $activity['hypercites']['by_anonymous'],
                $activity['hypercites']['unique_creators'],
                $activity['hypercites']['unique_creators_auth'],
                $activity['hypercites']['unique_creators_anon']
            ),
            'ul',
            $index++
        );
        $startLine += 100;

        return $nodes;
    }

    private function createNode(int $startLine, string $content, string $type, int $index): array
    {
        $nodeId = $this->fileHelpers->generateNodeId(self::BOOK_ID);

        return [
            'book' => self::BOOK_ID,
            'startLine' => $startLine,
            'chunk_id' => floor($index / 100),
            'node_id' => $nodeId,
            'content' => $content,
            'plainText' => strip_tags($content),
            'type' => $type,
            'footnotes' => json_encode([]),
            'raw_json' => json_encode([
                'startLine' => $startLine,
                'content' => $content,
                'type' => $type,
            ]),
            'created_at' => now(),
            'updated_at' => now(),
        ];
    }
}
