<?php

namespace App\Services;

use Illuminate\Http\Client\Pool;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class WebFetchService
{
    private LlmService $llm;

    public function __construct(LlmService $llm)
    {
        $this->llm = $llm;
    }

    /**
     * Extract a URL from bibliography HTML content.
     */
    public function extractUrl(string $content): ?string
    {
        $url = null;

        // Check for href first
        if (preg_match('/href=["\']?(https?:\/\/[^\s"\'<>]+)/i', $content, $m)) {
            $url = $m[1];
        }

        // Plain text URL fallback
        if (!$url && preg_match('#(https?://[^\s<>"\']+)#i', $content, $m)) {
            $url = $m[1];
        }

        if (!$url) {
            return null;
        }

        // Strip trailing punctuation
        $url = rtrim($url, '.,;)');

        // Strip trailing parenthetical fragments like "(open" from "(open in a new window)"
        $url = preg_replace('/\((?:open|new|link|click|accessed|retrieved).*$/i', '', $url);

        // Strip any remaining trailing parentheses or punctuation left behind
        $url = rtrim($url, '.,;)(/');

        return $url ?: null;
    }

    /**
     * Fetch a URL, strip HTML boilerplate, and validate content relevance via LLM.
     * Returns validated plain text or null if fetch fails / content is irrelevant.
     */
    public function fetchAndValidate(string $url, string $title): ?string
    {
        $text = $this->fetchWebPage($url);

        if (!$text || strlen($text) < 200) {
            return null;
        }

        // LLM screen: reject cookie walls, 404s, login pages, unrelated content
        if (!$this->llm->validateWebContent($text, $title)) {
            Log::info('WebFetchService: LLM rejected content as irrelevant', [
                'url' => $url,
                'title' => $title,
                'text_length' => strlen($text),
            ]);
            return null;
        }

        return $text;
    }

    /**
     * Fetch and validate multiple URLs concurrently using Http::pool.
     * Fetches in chunks of 8 with 1s gap to avoid overwhelming publisher servers.
     *
     * @param array $items Keyed by referenceId: ['ref1' => ['url' => ..., 'title' => ...], ...]
     * @return array Validated text keyed by referenceId (null for failures)
     */
    public function fetchAndValidateBatch(array $items): array
    {
        if (empty($items)) {
            return [];
        }

        $results = [];
        $keys = array_keys($items);
        $chunks = array_chunk($keys, 8);

        foreach ($chunks as $chunkIndex => $chunkKeys) {
            // Fetch chunk concurrently
            $responses = Http::pool(function (Pool $pool) use ($items, $chunkKeys) {
                foreach ($chunkKeys as $key) {
                    $pool->as((string) $key)
                        ->withHeaders(ContentFetchService::browserHeaders())
                        ->timeout(15)
                        ->get($items[$key]['url']);
                }
            });

            // Process responses
            foreach ($chunkKeys as $key) {
                $item = $items[$key];
                $response = $responses[(string) $key] ?? null;
                if (!$response || !$response->successful()) {
                    $results[$key] = null;
                    continue;
                }

                $contentType = $response->header('Content-Type') ?? '';
                if (str_contains($contentType, 'application/pdf')) {
                    $results[$key] = null;
                    continue;
                }

                $text = $this->extractTextFromHtml($response->body());
                if (!$text || strlen($text) < 200) {
                    $results[$key] = null;
                    continue;
                }

                // LLM validate (sequential — typically few entries reach this wave)
                if (!$this->llm->validateWebContent($text, $item['title'])) {
                    Log::info('WebFetchService batch: LLM rejected content', [
                        'url'   => $item['url'],
                        'title' => $item['title'],
                    ]);
                    $results[$key] = null;
                    continue;
                }

                $results[$key] = $text;
            }

            if ($chunkIndex < count($chunks) - 1) {
                sleep(1);
            }
        }

        return $results;
    }

    /**
     * Create a library stub with real searchable nodes from web-fetched text.
     * Returns the stub book ID or null on failure.
     */
    public function createWebStubWithNodes(
        $db,
        ?string $title,
        ?string $author,
        ?int $year,
        string $text,
        ?string $url
    ): ?string {
        // Dedup by URL
        if ($url) {
            $existing = $db->table('library')
                ->where('url', $url)
                ->where('type', 'web_source')
                ->first(['book']);
            if ($existing) {
                return $existing->book;
            }
        }

        $bookId = 'web_' . Str::random(20);

        try {
            $now = now()->toDateTimeString();

            // Create library stub with has_nodes = true
            $db->table('library')->insert([
                'book'       => $bookId,
                'title'      => $title ?: 'Web Source',
                'author'     => $author,
                'year'       => $year,
                'abstract'   => Str::limit($text, 2000, '...'),
                'url'        => $url,
                'type'       => 'web_source',
                'has_nodes'  => true,
                'creator'    => 'WebFetch',
                'visibility' => 'public',
                'listed'     => false,
                'raw_json'   => json_encode([
                    'source_url' => $url,
                    'method'     => 'web_fetch',
                    'fetched_at' => now()->toIso8601String(),
                ]),
                'timestamp'  => round(microtime(true) * 1000),
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            // Chunk text into paragraphs and create nodes
            $chunks = $this->chunkText($text);
            $this->createNodes($db, $bookId, $chunks);

            return $bookId;
        } catch (\Exception $e) {
            Log::warning('WebFetchService stub creation failed: ' . $e->getMessage());
            return null;
        }
    }

    /**
     * Fetch a web page and extract plain text content.
     */
    private function fetchWebPage(string $url): ?string
    {
        try {
            $response = Http::withHeaders(ContentFetchService::browserHeaders())
                ->timeout(15)
                ->get($url);

            if (!$response->successful()) {
                return null;
            }

            // Skip PDFs
            $contentType = $response->header('Content-Type') ?? '';
            if (str_contains($contentType, 'application/pdf')) {
                return null;
            }

            return $this->extractTextFromHtml($response->body());
        } catch (\Exception $e) {
            Log::info('WebFetchService: fetch failed', [
                'url' => $url,
                'error' => Str::limit($e->getMessage(), 100),
            ]);
            return null;
        }
    }

    /**
     * Strip boilerplate HTML and extract plain text.
     */
    private function extractTextFromHtml(string $html): ?string
    {
        $patterns = [
            '/<script\b[^>]*>.*?<\/script>/is',
            '/<style\b[^>]*>.*?<\/style>/is',
            '/<nav\b[^>]*>.*?<\/nav>/is',
            '/<header\b[^>]*>.*?<\/header>/is',
            '/<footer\b[^>]*>.*?<\/footer>/is',
            '/<aside\b[^>]*>.*?<\/aside>/is',
            '/<svg\b[^>]*>.*?<\/svg>/is',
        ];

        $cleaned = preg_replace($patterns, '', $html);
        $cleaned = strip_tags($cleaned);
        $cleaned = html_entity_decode($cleaned, ENT_QUOTES, 'UTF-8');
        $cleaned = preg_replace('/\s+/', ' ', $cleaned);
        $cleaned = trim($cleaned);

        // Truncate to 6000 chars
        if (strlen($cleaned) > 6000) {
            $cleaned = substr($cleaned, 0, 6000);
        }

        if (strlen($cleaned) < 200) {
            return null;
        }

        return $cleaned;
    }

    /**
     * Split text into ~500-char chunks, splitting on double newlines then sentence boundaries.
     *
     * @return string[]
     */
    private function chunkText(string $text): array
    {
        // First try splitting on double newlines (paragraph boundaries)
        $paragraphs = preg_split('/\n\n+/', $text);
        $paragraphs = array_filter(array_map('trim', $paragraphs));

        if (empty($paragraphs)) {
            $paragraphs = [$text];
        }

        $chunks = [];
        $current = '';

        foreach ($paragraphs as $para) {
            if (strlen($current) + strlen($para) + 2 > 500 && $current !== '') {
                $chunks[] = trim($current);
                $current = '';
            }

            if (strlen($para) > 500) {
                // Split long paragraphs on sentence boundaries
                if ($current !== '') {
                    $chunks[] = trim($current);
                    $current = '';
                }
                $sentences = preg_split('/(?<=[.!?])\s+/', $para);
                $sentenceBuf = '';
                foreach ($sentences as $sentence) {
                    if (strlen($sentenceBuf) + strlen($sentence) + 1 > 500 && $sentenceBuf !== '') {
                        $chunks[] = trim($sentenceBuf);
                        $sentenceBuf = '';
                    }
                    $sentenceBuf .= ($sentenceBuf ? ' ' : '') . $sentence;
                }
                if ($sentenceBuf !== '') {
                    $current = $sentenceBuf;
                }
            } else {
                $current .= ($current ? "\n\n" : '') . $para;
            }
        }

        if (trim($current) !== '') {
            $chunks[] = trim($current);
        }

        return $chunks ?: [$text];
    }

    /**
     * Create node records from text chunks.
     * Uses e() for HTML content (XSS protection) — same pattern as ImportController footnotes.
     * search_vector auto-populates from plainText (GENERATED ALWAYS AS STORED).
     */
    private function createNodes($db, string $bookId, array $chunks): void
    {
        $insertData = [];
        $now = now();

        foreach ($chunks as $index => $chunk) {
            $nodeId = (string) Str::uuid();
            $startLine = ($index + 1) * 100;
            $chunkId = floor($index / 100) * 100;

            $nodeHtml = '<p data-node-id="' . e($nodeId) . '" no-delete-id="please" '
                      . 'style="min-height:1.5em;">' . e($chunk) . '</p>';

            $insertData[] = [
                'book'       => $bookId,
                'startLine'  => $startLine,
                'chunk_id'   => $chunkId,
                'node_id'    => $nodeId,
                'content'    => $nodeHtml,
                'plainText'  => $chunk,
                'type'       => 'p',
                'footnotes'  => json_encode([]),
                'raw_json'   => json_encode([]),
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        // Insert in batches
        foreach (array_chunk($insertData, 500) as $batch) {
            $db->table('nodes')->insert($batch);
        }

        Log::info('WebFetchService created nodes', [
            'book' => $bookId,
            'count' => count($insertData),
        ]);
    }
}
