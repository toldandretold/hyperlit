<?php

namespace App\Services;

use Illuminate\Http\Client\Pool;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use App\Models\PgLibrary;

class OpenAlexService
{
    public const BASE_URL = 'https://api.openalex.org';
    public const USER_AGENT = 'Hyperlit/1.0 (mailto:sam@hyperlit.io)';
    public const SELECT_FIELDS = 'id,title,authorships,publication_year,primary_location,best_oa_location,doi,biblio,open_access,type,language,cited_by_count,abstract_inverted_index';

    /**
     * Make an HTTP GET request with retry logic for 429 rate limiting.
     * Retries up to 3 times with exponential backoff (1s, 2s, 4s).
     * Proactively sleeps when X-RateLimit-Remaining drops below threshold.
     */
    private function retryableGet(string $url, array $query = []): \Illuminate\Http\Client\Response
    {
        $maxRetries = 3;

        for ($attempt = 0; $attempt <= $maxRetries; $attempt++) {
            $response = Http::withHeaders([
                'User-Agent' => self::USER_AGENT,
            ])->get($url, $query);

            if ($response->status() !== 429 || $attempt === $maxRetries) {
                // Proactive throttle: sleep when remaining requests are low
                $this->proactiveThrottle($response);
                return $response;
            }

            $retryAfter = (int) ($response->header('Retry-After') ?: 0);
            $maxBackoff = 10;
            $backoff = $retryAfter > 0 ? min($retryAfter, $maxBackoff) : pow(2, $attempt);

            if ($retryAfter > $maxBackoff) {
                Log::warning('OpenAlex Retry-After exceeds cap', [
                    'retry_after' => $retryAfter,
                    'capped_to'   => $maxBackoff,
                ]);
            }

            Log::info('OpenAlex 429 rate limited, retrying', [
                'attempt'     => $attempt + 1,
                'backoff_sec' => $backoff,
                'url'         => $url,
            ]);

            sleep($backoff);
        }

        return $response; // unreachable, but satisfies static analysis
    }

    /**
     * Check X-RateLimit-Remaining header and proactively sleep when low.
     * Prevents hitting 429s by backing off before the limit is reached.
     */
    private function proactiveThrottle(\Illuminate\Http\Client\Response $response): void
    {
        $remaining = $response->header('X-RateLimit-Remaining');

        if ($remaining === null) {
            return;
        }

        $remaining = (int) $remaining;

        if ($remaining < 20) {
            Log::info('OpenAlex rate limit low, proactive throttle', [
                'remaining' => $remaining,
                'sleep_sec' => 2,
            ]);
            sleep(2);
        } elseif ($remaining < 50) {
            Log::info('OpenAlex rate limit approaching, proactive throttle', [
                'remaining' => $remaining,
                'sleep_sec' => 1,
            ]);
            sleep(1);
        }
    }

    /**
     * Fetch works from OpenAlex by search query and normalise them.
     *
     * @return array<int, array>
     */
    public function fetchFromOpenAlex(string $query, int $limit = 10, int $page = 1): array
    {
        $response = $this->retryableGet(self::BASE_URL . '/works', [
            'search'   => $query,
            'per_page' => $limit,
            'page'     => $page,
            'select'   => self::SELECT_FIELDS,
        ]);

        if (!$response->successful()) {
            Log::warning('OpenAlex API returned ' . $response->status() . ' for query: ' . $query);
            return [];
        }

        $works = $response->json('results') ?? [];

        return array_map(fn(array $work) => $this->normaliseWork($work), $works);
    }

    /**
     * Fetch works by author name from OpenAlex (two-step: resolve author -> fetch works).
     *
     * @return array<int, array>
     */
    public function fetchFromOpenAlexByAuthor(string $query, int $limit = 10): array
    {
        $authorResponse = $this->retryableGet(self::BASE_URL . '/authors', [
            'search'   => $query,
            'per_page' => 1,
            'select'   => 'id',
        ]);

        if (!$authorResponse->successful()) {
            return [];
        }

        $authors = $authorResponse->json('results') ?? [];
        if (empty($authors)) {
            return [];
        }

        $authorId = $authors[0]['id'] ?? null;
        if (!$authorId) {
            return [];
        }

        $worksResponse = $this->retryableGet(self::BASE_URL . '/works', [
            'filter'   => 'authorships.author.id:' . $authorId,
            'per_page' => $limit,
            'sort'     => 'cited_by_count:desc',
            'select'   => self::SELECT_FIELDS,
        ]);

        if (!$worksResponse->successful()) {
            return [];
        }

        $works = $worksResponse->json('results') ?? [];

        return array_map(fn(array $work) => $this->normaliseWork($work), $works);
    }

    /**
     * Fetch a single work by DOI from OpenAlex.
     * Returns a normalised work array, or null if not found.
     */
    public function fetchByDoi(string $doi): ?array
    {
        $response = $this->retryableGet(self::BASE_URL . '/works/doi:' . $doi, [
            'select' => self::SELECT_FIELDS,
        ]);

        if (!$response->successful()) {
            return null;
        }

        $work = $response->json();
        if (empty($work) || empty($work['id'])) {
            return null;
        }

        return $this->normaliseWork($work);
    }

    /**
     * Fetch multiple works by DOI concurrently using Http::pool.
     * Processes in chunks of 5 with 1s gap to stay under OpenAlex's 10 req/s polite limit.
     * Skips 429'd requests (returns null) and increases inter-chunk gap to 3s when throttled.
     * Monitors X-RateLimit-Remaining for proactive throttling.
     *
     * @param array $dois Keyed by referenceId: ['ref1' => '10.xxx/yyy', ...]
     * @return array Normalised works keyed by referenceId (null for failures)
     */
    public function fetchByDoiBatch(array $dois): array
    {
        if (empty($dois)) {
            return [];
        }

        $allResults = [];
        $keys = array_keys($dois);
        $chunks = array_chunk($keys, 5);
        $throttled = false;

        foreach ($chunks as $chunkIndex => $chunkKeys) {
            $responses = Http::pool(function (Pool $pool) use ($dois, $chunkKeys) {
                foreach ($chunkKeys as $key) {
                    $pool->as((string) $key)
                        ->withHeaders(['User-Agent' => self::USER_AGENT])
                        ->timeout(15)
                        ->get(self::BASE_URL . '/works/doi:' . $dois[$key], [
                            'select' => self::SELECT_FIELDS,
                        ]);
                }
            });

            $had429 = false;
            $lowestRemaining = PHP_INT_MAX;

            foreach ($chunkKeys as $key) {
                $response = $responses[(string) $key] ?? null;
                if (!$response instanceof \Illuminate\Http\Client\Response) {
                    $allResults[$key] = null;
                    continue;
                }

                // Skip 429s — the entry will fail this wave and can be retried in a later wave
                if ($response->status() === 429) {
                    Log::warning('OpenAlex batch DOI 429, skipping', ['doi' => $dois[$key]]);
                    $allResults[$key] = null;
                    $had429 = true;
                    continue;
                }

                if ($response->successful()) {
                    $work = $response->json();
                    $allResults[$key] = (!empty($work) && !empty($work['id']))
                        ? $this->normaliseWork($work)
                        : null;

                    // Track lowest remaining across this chunk's responses
                    $remaining = $response->header('X-RateLimit-Remaining');
                    if ($remaining !== null) {
                        $lowestRemaining = min($lowestRemaining, (int) $remaining);
                    }
                } else {
                    $allResults[$key] = null;
                }
            }

            if ($had429) {
                $throttled = true;
            }

            if ($chunkIndex < count($chunks) - 1) {
                // Proactive throttle based on remaining quota
                if ($lowestRemaining < 20) {
                    Log::info('OpenAlex batch DOI: rate limit low, sleeping 3s', ['remaining' => $lowestRemaining]);
                    sleep(3);
                } elseif ($throttled || $lowestRemaining < 50) {
                    sleep($throttled ? 3 : 2);
                } else {
                    sleep(1);
                }
            }
        }

        return $allResults;
    }

    /**
     * Search OpenAlex for multiple queries concurrently using Http::pool.
     * Processes in chunks of 5 with 1s gap to stay under OpenAlex's 10 req/s polite limit.
     * Skips 429'd requests (returns []) and increases inter-chunk gap to 3s when throttled.
     * Monitors X-RateLimit-Remaining for proactive throttling.
     *
     * @param array $queries Keyed by referenceId: ['ref1' => 'search title', ...]
     * @return array Arrays of normalised candidates keyed by referenceId
     */
    public function searchBatch(array $queries, int $limit = 5, array $yearFilters = []): array
    {
        if (empty($queries)) {
            return [];
        }

        $allResults = [];
        $keys = array_keys($queries);
        $chunks = array_chunk($keys, 5);
        $throttled = false;

        foreach ($chunks as $chunkIndex => $chunkKeys) {
            $responses = Http::pool(function (Pool $pool) use ($queries, $chunkKeys, $limit, $yearFilters) {
                foreach ($chunkKeys as $key) {
                    $params = [
                        'search'   => $queries[$key],
                        'per_page' => $limit,
                        'page'     => 1,
                        'select'   => self::SELECT_FIELDS,
                    ];
                    if (isset($yearFilters[$key])) {
                        $params['filter'] = 'publication_year:' . (int) $yearFilters[$key];
                    }
                    $pool->as((string) $key)
                        ->withHeaders(['User-Agent' => self::USER_AGENT])
                        ->timeout(15)
                        ->get(self::BASE_URL . '/works', $params);
                }
            });

            $had429 = false;
            $lowestRemaining = PHP_INT_MAX;

            foreach ($chunkKeys as $key) {
                $response = $responses[(string) $key] ?? null;
                if (!$response instanceof \Illuminate\Http\Client\Response) {
                    $allResults[$key] = [];
                    continue;
                }

                // Skip 429s — the entry will fail this wave and can be retried in a later wave
                if ($response->status() === 429) {
                    Log::warning('OpenAlex batch search 429, skipping', ['query' => $queries[$key]]);
                    $allResults[$key] = [];
                    $had429 = true;
                    continue;
                }

                if ($response->successful()) {
                    $works = $response->json('results') ?? [];
                    $allResults[$key] = array_map(fn(array $work) => $this->normaliseWork($work), $works);

                    // Track lowest remaining across this chunk's responses
                    $remaining = $response->header('X-RateLimit-Remaining');
                    if ($remaining !== null) {
                        $lowestRemaining = min($lowestRemaining, (int) $remaining);
                    }
                } else {
                    $allResults[$key] = [];
                }
            }

            if ($had429) {
                $throttled = true;
            }

            if ($chunkIndex < count($chunks) - 1) {
                // Proactive throttle based on remaining quota
                if ($lowestRemaining < 20) {
                    Log::info('OpenAlex batch search: rate limit low, sleeping 3s', ['remaining' => $lowestRemaining]);
                    sleep(3);
                } elseif ($throttled || $lowestRemaining < 50) {
                    sleep($throttled ? 3 : 2);
                } else {
                    sleep(1);
                }
            }
        }

        return $allResults;
    }

    /**
     * Extract a DOI from HTML content or plain text.
     * Looks for <a href="...doi.org/..."> links first, then plain text DOI patterns.
     */
    public function extractDoi(string $html): ?string
    {
        // 1. Look for DOI links: <a href="https://doi.org/10.xxxx/...">
        if (preg_match('#href=["\']https?://(?:dx\.)?doi\.org/(10\.\d{4,9}/[^\s"\'<>]+)["\']#i', $html, $m)) {
            return rtrim($m[1], '.,;)');
        }

        // 2. Plain text DOI pattern: doi:10.xxxx/... or https://doi.org/10.xxxx/...
        if (preg_match('#(?:doi:\s*|https?://(?:dx\.)?doi\.org/)(10\.\d{4,9}/[^\s<>]+)#i', $html, $m)) {
            return rtrim($m[1], '.,;)');
        }

        // 3. Bare DOI: 10.xxxx/... (must start at word boundary)
        if (preg_match('#\b(10\.\d{4,9}/[^\s<>"]+)#', $html, $m)) {
            return rtrim($m[1], '.,;)');
        }

        return null;
    }

    /**
     * Extract the title from a raw citation string (may contain HTML).
     * Bibtex formatting wraps book titles in <i> and article titles in quotes.
     * Also handles EPUB text-style spans like <span class="t13">.
     */
    public function extractTitle(string $raw): string
    {
        $plain = strip_tags($raw);

        // 1. Quoted title: "Title" or curly quotes — article/chapter titles are typically quoted
        if (preg_match('/[\x{201C}""]([^\x{201C}\x{201D}""]+)[\x{201D}""]/u', $plain, $m)) {
            $quoted = trim($m[1], " \t\n\r.");
            if (strlen($quoted) >= 10) {
                return $quoted;
            }
        }

        // Italic tag pattern: <i>, <em>, or <span class="tNN"> (EPUB text-style classes)
        $italicPattern = '#<(?:i|em|span\s+class="t\d+")>#i';

        // 2. HTML italic title: find the first italic marker and use year-anchor logic
        if (preg_match($italicPattern, $raw)) {
            // Extract italic text (handle all three tag types)
            $italicText = null;
            if (preg_match('#<(?:i|em)>(.*?)</(?:i|em)>#is', $raw, $m)) {
                $italicText = trim(strip_tags($m[1]));
            } elseif (preg_match('#<span\s+class="t\d+">(.*?)</span>#is', $raw, $m)) {
                $italicText = trim(strip_tags($m[1]));
            }

            if ($italicText && strlen($italicText) >= 5) {
                // Find year (19xx or 20xx) position in plain text
                $yearPos = null;
                if (preg_match('/\b(19|20)\d{2}\b/', $plain, $ym, PREG_OFFSET_CAPTURE)) {
                    $yearPos = $ym[0][1] + strlen($ym[0][0]);
                }

                // Find italic marker position in plain text by locating the italic text
                $italicPos = $italicText ? mb_strpos($plain, $italicText) : false;

                // If there's text between year and italic → that's an article title
                if ($yearPos !== null && $italicPos !== false && $italicPos > $yearPos) {
                    $between = trim(substr($plain, $yearPos, $italicPos - $yearPos));
                    // Strip leading punctuation/whitespace
                    $between = preg_replace('/^[\s.,;:)\]]+/', '', $between);
                    // Strip trailing punctuation
                    $between = preg_replace('/[\s.,;:]+$/', '', $between);
                    if (strlen($between) >= 10) {
                        return $between;
                    }
                }

                // No text before italic, or text too short → italic text is the title (book)
                return $italicText;
            }
        }

        // 3. Year-anchor fallback: find year, take text after it up to the first sentence boundary
        if (preg_match('/\b(?:19|20)\d{2}[a-z]?\b[.)]*\s*(.+)/u', $plain, $m)) {
            $afterYear = trim($m[1]);
            // Strip leading punctuation
            $afterYear = preg_replace('/^[\s.,;:)\]]+/', '', $afterYear);
            if (preg_match('/^(.+?)\.\s/', $afterYear, $sm)) {
                $title = trim($sm[1]);
                if (strlen($title) >= 10) {
                    return $title;
                }
            }
            // If no sentence boundary, take up to 150 chars
            if (strlen($afterYear) >= 10) {
                return trim(substr($afterYear, 0, 150));
            }
        }

        // 4. Last resort: strip author pattern and year, truncate at first sentence boundary
        $cleaned = preg_replace('/^[A-Z][a-z]+,\s*[A-Z][a-z.]+(?:\s+and\s+[A-Z][a-z]+,\s*[A-Z][a-z.]+)*\.?\s*/', '', $plain);
        $cleaned = preg_replace('/\(?\d{4}\)?[.:]?\s*\d*[-\x{2013}]?\d*\.?/u', '', $cleaned);
        $cleaned = trim($cleaned);

        if (preg_match('/^(.+?)\.\s/', $cleaned, $m)) {
            $title = trim($m[1]);
            if (strlen($title) >= 10) {
                return $title;
            }
        }

        return trim(substr($cleaned, 0, 150));
    }

    /**
     * Strip diacritics to ASCII: "Aydın"→"Aydin", "Mbembé"→"Mbembe", etc.
     */
    private function asciiFold(string $s): string
    {
        if (function_exists('transliterator_transliterate')) {
            return transliterator_transliterate('Any-Latin; Latin-ASCII', $s);
        }
        $result = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
        return $result !== false ? $result : $s;
    }

    /**
     * Lowercase, strip diacritics, remove punctuation, collapse whitespace.
     */
    private function normaliseText(string $s): string
    {
        $s = $this->asciiFold(mb_strtolower($s));
        $s = preg_replace('/[^\w\s]/u', ' ', $s);
        return preg_replace('/\s+/', ' ', trim($s));
    }

    /**
     * Compare two individual author names using word-set matching.
     * Handles reordering ("Nilsen, Alf Gunvald" vs "Alf Gunvald Nilsen")
     * and fuzzy tolerance via levenshtein().
     * Returns proportion of shorter name's words that matched (0.0–1.0).
     */
    private function nameSimilarity(string $name1, string $name2): float
    {
        $normalise = function (string $name): array {
            $name = $this->asciiFold(mb_strtolower($name));
            $name = preg_replace('/[,.\-]/u', ' ', $name);
            $words = preg_split('/\s+/', trim($name), -1, PREG_SPLIT_NO_EMPTY);
            // Remove initials (1-2 char tokens like "A", "AG", "CK")
            return array_values(array_filter($words, fn($w) => mb_strlen($w) > 2));
        };

        $words1 = $normalise($name1);
        $words2 = $normalise($name2);

        if (empty($words1) || empty($words2)) {
            return 0.0;
        }

        $shorter = count($words1) <= count($words2) ? $words1 : $words2;
        $longer  = count($words1) <= count($words2) ? $words2 : $words1;

        $matched = 0;
        $used = [];
        foreach ($shorter as $sw) {
            foreach ($longer as $li => $lw) {
                if (isset($used[$li])) continue;
                if ($sw === $lw || (mb_strlen($sw) >= 4 && mb_strlen($lw) >= 4 && levenshtein($sw, $lw) <= 1)) {
                    $matched++;
                    $used[$li] = true;
                    break;
                }
            }
        }

        return $matched / count($shorter);
    }

    /**
     * Compute blended word + character similarity between two titles.
     * Returns 0.0–1.0. Combines Jaccard word-overlap (structural) with
     * similar_text() percentage (typo tolerance), scaled by a length penalty.
     */
    public function titleSimilarity(string $query, string $resultTitle): float
    {
        $stopWords = ['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'by', 'with', 'from', 'at', 'is', 'as'];

        $normQuery  = $this->normaliseText($query);
        $normResult = $this->normaliseText($resultTitle);

        if ($normQuery === '' || $normResult === '') {
            return 0.0;
        }

        // Word-level Jaccard
        $tokenise = function (string $text) use ($stopWords): array {
            $words = preg_split('/\s+/', $text, -1, PREG_SPLIT_NO_EMPTY);
            return array_values(array_diff($words, $stopWords));
        };

        $queryWords  = $tokenise($normQuery);
        $resultWords = $tokenise($normResult);

        if (empty($queryWords) || empty($resultWords)) {
            return 0.0;
        }

        $intersection = count(array_intersect($queryWords, $resultWords));
        $union        = count(array_unique(array_merge($queryWords, $resultWords)));
        $jaccard      = $union > 0 ? $intersection / $union : 0.0;

        // Character-level similarity (typo tolerance)
        similar_text($normQuery, $normResult, $charSimPercent);
        $charSim = $charSimPercent / 100.0;

        // Blend: 60% word-level, 40% character-level
        $blended = 0.6 * $jaccard + 0.4 * $charSim;

        // Length penalty: min/max word count ratio scaled 0.5–1.0
        $lengthRatio = min(count($queryWords), count($resultWords))
                     / max(count($queryWords), count($resultWords));

        return $blended * (0.5 + 0.5 * $lengthRatio);
    }

    /**
     * Compute a composite metadata score between LLM-extracted metadata and a candidate.
     * Weights: title 0.55, author 0.25, year 0.10, journal 0.05, publisher 0.05. Returns 0.0–1.0.
     */
    public function metadataScore(array $llmMeta, array $candidate): array
    {
        // Title similarity (weight 0.55)
        $titleScore = $this->titleSimilarity(
            $llmMeta['title'] ?? '',
            $candidate['title'] ?? ''
        );

        // Title floor: if the title doesn't remotely match, hard reject regardless of author/year
        if ($titleScore < 0.15) {
            return [
                'score'           => 0.0,
                'titleScore'      => round($titleScore, 4),
                'reason'          => 'title_floor',
            ];
        }

        // Author match (weight 0.25): proportional matching via nameSimilarity
        $authorScore = 0.0;
        $llmAuthors = $llmMeta['authors'] ?? [];
        // Strip "et al." — it inflates the denominator and never matches a real name
        $llmAuthors = array_values(array_filter($llmAuthors, function ($a) {
            $normalised = mb_strtolower(trim($a));
            return $normalised !== 'et al.' && $normalised !== 'et al' && $normalised !== 'etal';
        }));
        $candidateAuthor = $candidate['author'] ?? '';

        if (!empty($llmAuthors) && !empty($candidateAuthor)) {
            // Split candidate authors by semicolons into individual names
            $candidateNames = array_map('trim', explode(';', $candidateAuthor));
            $candidateNames = array_values(array_filter($candidateNames, fn($n) => strlen($n) >= 2));

            $matchedCount = 0;
            $usedCandidates = [];

            foreach ($llmAuthors as $llmAuthor) {
                $bestNameScore = 0.0;
                $bestIdx = -1;

                foreach ($candidateNames as $ci => $cName) {
                    if (isset($usedCandidates[$ci])) continue;
                    $ns = $this->nameSimilarity($llmAuthor, $cName);
                    if ($ns > $bestNameScore) {
                        $bestNameScore = $ns;
                        $bestIdx = $ci;
                    }
                }

                if ($bestNameScore >= 0.6 && $bestIdx >= 0) {
                    $matchedCount++;
                    $usedCandidates[$bestIdx] = true;
                }
            }

            $authorScore = count($llmAuthors) > 0 ? (float)($matchedCount / count($llmAuthors)) : 0.0;
        }

        // Year match (weight 0.12): 1.0 exact, 0.5 if ±1, 0.0 otherwise
        // Check against both year and original_year; take the best score
        $yearScore = 0.0;
        $candidateYear = $candidate['year'] ?? null;
        $yearsToCheck = array_filter([
            $llmMeta['year'] ?? null,
            $llmMeta['original_year'] ?? null,
        ], fn($v) => $v !== null);
        if ($candidateYear !== null) {
            foreach ($yearsToCheck as $y) {
                $diff = abs((int) $y - (int) $candidateYear);
                if ($diff === 0) {
                    $yearScore = 1.0;
                    break;
                } elseif ($diff === 1 && $yearScore < 0.5) {
                    $yearScore = 0.5;
                }
            }
        }

        // Journal bonus (weight 0.05): similar_text comparison
        $journalScore = 0.0;
        $llmJournal = $llmMeta['journal'] ?? '';
        $candidateJournal = $candidate['journal'] ?? '';
        if (strlen($llmJournal) >= 3 && strlen($candidateJournal) >= 3) {
            $normLlmJournal  = $this->normaliseText($llmJournal);
            $normCandJournal = $this->normaliseText($candidateJournal);
            similar_text($normLlmJournal, $normCandJournal, $journalSimPercent);
            $journalSim = $journalSimPercent / 100.0;
            $journalScore = $journalSim >= 0.4 ? $journalSim : 0.0;
        }

        // Publisher comparison (weight 0.05): bonus only — no penalty if missing
        $publisherScore = 0.0;
        $llmPublisher = $llmMeta['publisher'] ?? '';
        $candidatePublisher = $candidate['publisher'] ?? '';
        if (strlen($llmPublisher) >= 3 && strlen($candidatePublisher) >= 3) {
            $normLlmPub  = $this->normaliseText($llmPublisher);
            $normCandPub = $this->normaliseText($candidatePublisher);
            similar_text($normLlmPub, $normCandPub, $pubSimPercent);
            $pubSim = $pubSimPercent / 100.0;
            $publisherScore = $pubSim >= 0.4 ? $pubSim : 0.0;
        }

        // Author mismatch penalty
        $authorMismatchPenalty = 1.0;
        if ($authorScore === 0.0 && !empty($llmAuthors)) {
            if (!empty($candidateAuthor)) {
                // Both sides have authors, none match → hard reject
                return [
                    'score'            => 0.0,
                    'titleScore'       => round($titleScore, 4),
                    'authorScore'      => 0.0,
                    'yearScore'        => $yearScore,
                    'journalScore'     => round($journalScore, 4),
                    'publisherScore'   => round($publisherScore, 4),
                    'authorPenalty'    => 0.0,
                    'rawScore'         => 0.0,
                    'llmAuthors'       => $llmAuthors,
                    'candidateAuthor'  => $candidateAuthor,
                    'reason'           => 'author_hard_reject',
                ];
            } else {
                $authorMismatchPenalty = 0.85;  // candidate has no author data
            }
        } elseif ($authorScore > 0.0 && $authorScore < 0.5 && !empty($llmAuthors)) {
            // Partial but weak match: graduated penalty
            $authorMismatchPenalty = 0.7 + 0.6 * $authorScore;
        } elseif (empty($llmAuthors) && !empty($candidateAuthor)) {
            // LLM extracted no authors but candidate has specific author.
            // Can't confirm or deny — apply penalty.
            $authorMismatchPenalty = 0.75;
        }

        $rawScore = ($titleScore * 0.55) + ($authorScore * 0.25) + ($yearScore * 0.10) + ($journalScore * 0.05) + ($publisherScore * 0.05);
        $finalScore = $rawScore * $authorMismatchPenalty;

        $breakdown = [
            'score'            => $finalScore,
            'titleScore'       => round($titleScore, 4),
            'authorScore'      => round($authorScore, 4),
            'yearScore'        => $yearScore,
            'journalScore'     => round($journalScore, 4),
            'publisherScore'   => round($publisherScore, 4),
            'authorPenalty'    => round($authorMismatchPenalty, 4),
            'rawScore'         => round($rawScore, 4),
            'llmAuthors'       => $llmAuthors,
            'candidateAuthor'  => $candidateAuthor,
        ];

        Log::info('metadataScore', $breakdown);

        return $breakdown;
    }

    /**
     * Check whether a normalised work is a real citable work (not paratext, component, etc.).
     */
    public function isCitableWork(array $normalised): bool
    {
        $citableTypes = [
            'journal-article', 'article', 'book', 'book-chapter',
            'dissertation', 'proceedings-article', 'report',
            'peer-review', 'monograph', 'reference-entry',
            'proceedings', 'standard', 'posted-content',
            'edited-book',
        ];

        $type = $normalised['type'] ?? null;

        return $type !== null && in_array($type, $citableTypes, true);
    }

    /**
     * Reconstruct plain text from an OpenAlex abstract_inverted_index.
     * The index maps each word to an array of positions: {"word": [0, 5], ...}.
     */
    public static function reconstructAbstract(?array $invertedIndex): ?string
    {
        if (empty($invertedIndex)) {
            return null;
        }

        $words = [];
        foreach ($invertedIndex as $word => $positions) {
            foreach ((array) $positions as $pos) {
                $words[(int) $pos] = (string) $word;
            }
        }

        if (empty($words)) {
            return null;
        }

        ksort($words);

        return implode(' ', $words);
    }

    /**
     * Normalise a raw OpenAlex work object into the shared citation shape.
     */
    public function normaliseWork(array $work): array
    {
        $authorships = $work['authorships'] ?? [];
        $authors = array_map(
            fn($a) => $a['author']['display_name'] ?? 'Unknown',
            array_slice($authorships, 0, 3)
        );
        $author = $authors ? implode('; ', $authors) : null;

        // Structured author list incl. ORCID, for canonical_source.authorships.
        // Future: ORCID match against a verified user → flag is_publisher_uploaded automatically.
        $structuredAuthorships = array_map(function ($a) {
            $rawAuthorId = $a['author']['id'] ?? null;
            $authorId = $rawAuthorId ? basename($rawAuthorId) : null;

            $orcid = $a['author']['orcid'] ?? null;
            if ($orcid && str_starts_with($orcid, 'https://orcid.org/')) {
                $orcid = substr($orcid, strlen('https://orcid.org/'));
            }

            return [
                'name'               => $a['author']['display_name'] ?? null,
                'openalex_author_id' => $authorId,
                'orcid'              => $orcid,
                'position'           => $a['author_position'] ?? null,
                'is_corresponding'   => (bool) ($a['is_corresponding'] ?? false),
            ];
        }, $authorships);

        $rawId = $work['id'] ?? null;
        $openalexId = $rawId ? basename($rawId) : null;

        $doi = $work['doi'] ?? null;
        if ($doi && str_starts_with($doi, 'https://doi.org/')) {
            $doi = substr($doi, strlen('https://doi.org/'));
        }

        $pdfUrl = $work['primary_location']['pdf_url']
            ?? $work['best_oa_location']['pdf_url']
            ?? null;

        $firstPage = $work['biblio']['first_page'] ?? null;
        $lastPage  = $work['biblio']['last_page'] ?? null;

        $sanitiseUrl = fn(?string $url): ?string =>
            ($url && filter_var($url, FILTER_VALIDATE_URL) && preg_match('#^https?://#i', $url))
                ? $url
                : null;

        return [
            'book'           => null,
            'title'          => $work['title'] ?? null,
            'author'         => $author,
            'has_nodes'      => false,
            'year'           => $work['publication_year'] ?? null,
            'journal'        => $work['primary_location']['source']['display_name'] ?? null,
            'publisher'      => $work['primary_location']['source']['host_organization_name'] ?? null,
            'doi'            => $doi,
            'openalex_id'    => $openalexId,
            'source'         => 'openalex',
            'is_oa'          => $work['open_access']['is_oa'] ?? null,
            'oa_status'      => $work['open_access']['oa_status'] ?? null,
            'oa_url'         => $sanitiseUrl($work['open_access']['oa_url'] ?? null),
            'pdf_url'        => $sanitiseUrl($pdfUrl),
            'work_license'   => $work['primary_location']['license'] ?? null,
            'cited_by_count' => $work['cited_by_count'] ?? null,
            'language'       => $work['language'] ?? null,
            'type'           => $work['type'] ?? null,
            'volume'         => $work['biblio']['volume'] ?? null,
            'issue'          => $work['biblio']['issue'] ?? null,
            'pages'          => ($firstPage && $lastPage) ? $firstPage . '–' . $lastPage : null,
            'bibtex'         => $this->generateBibtex($work),
            'abstract'       => self::reconstructAbstract($work['abstract_inverted_index'] ?? null),
            'authorships'    => $structuredAuthorships,
        ];
    }

    /**
     * Batch-upsert OpenAlex search results as lightweight library stubs.
     *
     * @param array<int, array> $candidates  Already-normalised works
     * @return array<int, array>  Candidates with `book` and `bibtex` populated
     */
    public function upsertLibraryStubs(array $candidates): array
    {
        $openalexIds = array_values(array_filter(array_column($candidates, 'openalex_id')));

        if (empty($openalexIds)) {
            return $candidates;
        }

        $existing = PgLibrary::whereIn('openalex_id', $openalexIds)
            ->select(['book', 'openalex_id', 'bibtex'])
            ->get()
            ->keyBy('openalex_id');

        $timestamp = time();

        foreach ($candidates as &$candidate) {
            $openalexId = $candidate['openalex_id'] ?? null;
            if (!$openalexId) continue;

            if ($existing->has($openalexId)) {
                $stub = $existing->get($openalexId);
                $candidate['book']   = $stub->book;
                $candidate['bibtex'] = $stub->bibtex;
            } else {
                $bookId = (string) Str::uuid();
                $bibtex = $candidate['bibtex'];
                $doiUrl = $candidate['doi'] ? 'https://doi.org/' . $candidate['doi'] : null;

                try {
                    $now = now()->toDateTimeString();
                    DB::connection('pgsql_admin')->table('library')->insert([
                        'book'           => $bookId,
                        'has_nodes'      => false,
                        'listed'         => false,
                        'visibility'     => 'public',
                        'openalex_id'    => $openalexId,
                        'bibtex'         => $bibtex,
                        'title'          => $candidate['title'],
                        'author'         => $candidate['author'],
                        'year'           => $candidate['year'],
                        'journal'        => $candidate['journal'],
                        'publisher'      => $candidate['publisher'] ?? null,
                        'doi'            => $candidate['doi'],
                        'is_oa'          => $candidate['is_oa'],
                        'oa_status'      => $candidate['oa_status'],
                        'oa_url'         => $candidate['oa_url'],
                        'pdf_url'        => $candidate['pdf_url'],
                        'work_license'   => $candidate['work_license'],
                        'cited_by_count' => $candidate['cited_by_count'],
                        'language'       => $candidate['language'],
                        'type'           => $candidate['type'],
                        'volume'         => $candidate['volume'],
                        'issue'          => $candidate['issue'],
                        'pages'          => $candidate['pages'],
                        'abstract'       => $candidate['abstract'] ?? null,
                        'url'            => $doiUrl,
                        'creator'        => 'OpenAlex',
                        'creator_token'  => null,
                        'timestamp'      => $timestamp,
                        'raw_json'       => json_encode([
                            'book'        => $bookId,
                            'title'       => $candidate['title'],
                            'author'      => $candidate['author'],
                            'year'        => $candidate['year'],
                            'type'        => $candidate['type'],
                            'journal'     => $candidate['journal'],
                            'publisher'   => $candidate['publisher'] ?? null,
                            'doi'         => $candidate['doi'],
                            'url'         => $doiUrl,
                            'openalex_id' => $openalexId,
                            'bibtex'      => $bibtex,
                            'visibility'  => 'public',
                            'creator'     => 'OpenAlex',
                        ]),
                        'created_at'     => $now,
                        'updated_at'     => $now,
                    ]);

                    $candidate['book']   = $bookId;
                    $candidate['bibtex'] = $bibtex;
                } catch (\Exception $e) {
                    Log::warning('OpenAlex stub creation failed for ' . $openalexId . ': ' . $e->getMessage());
                }
            }
        }
        unset($candidate);

        return $candidates;
    }

    /**
     * Create or find a single library stub for a normalised work.
     * Returns the book UUID, or null on failure.
     */
    public function createOrFindStub(array $normalised): ?string
    {
        // For non-OpenAlex sources (e.g. Open Library), use the generic path
        if (empty($normalised['openalex_id'])) {
            return $this->createStubDirect($normalised);
        }

        $result = $this->upsertLibraryStubs([$normalised]);
        return $result[0]['book'] ?? null;
    }

    /**
     * Create a library stub directly from a normalised work (any source).
     * Deduplicates by open_library_key if present, then by title+year.
     */
    private function createStubDirect(array $normalised): ?string
    {
        $title  = $normalised['title'] ?? null;
        $author = $normalised['author'] ?? null;
        $year   = $normalised['year'] ?? null;
        $olKey  = $normalised['open_library_key'] ?? null;

        if (!$title) {
            return null;
        }

        // Check for existing stub by open_library_key first
        if ($olKey) {
            $existing = DB::connection('pgsql_admin')->table('library')
                ->where('open_library_key', $olKey)
                ->first(['book', 'bibtex']);
            if ($existing) {
                return $existing->book;
            }
        }

        // Fallback dedup by title+year
        $query = DB::connection('pgsql_admin')->table('library')
            ->whereRaw('LOWER(title) = ?', [mb_strtolower($title)]);
        if ($year) {
            $query->where('year', $year);
        }
        $existing = $query->first(['book', 'bibtex']);

        if ($existing) {
            return $existing->book;
        }

        $bookId = (string) Str::uuid();
        $source = $normalised['source'] ?? 'unknown';
        $bibtex = $normalised['bibtex'] ?? '';
        $url    = $olKey ? 'https://openlibrary.org' . $olKey : null;

        // Fetch description from Open Library Works API if available
        $abstract = $normalised['abstract'] ?? null;
        if (!$abstract && $olKey) {
            $abstract = app(OpenLibraryService::class)->fetchDescription($olKey);
        }

        try {
            $now = now()->toDateTimeString();
            DB::connection('pgsql_admin')->table('library')->insert([
                'book'              => $bookId,
                'has_nodes'         => false,
                'listed'            => false,
                'visibility'        => 'public',
                'openalex_id'       => null,
                'open_library_key'  => $olKey,
                'bibtex'            => $bibtex,
                'title'             => $title,
                'author'            => $author,
                'year'              => $year,
                'journal'           => $normalised['journal'] ?? null,
                'doi'               => null,
                'is_oa'          => null,
                'oa_status'      => null,
                'oa_url'         => null,
                'pdf_url'        => null,
                'work_license'   => null,
                'cited_by_count' => null,
                'language'       => null,
                'type'           => $normalised['type'] ?? null,
                'volume'         => null,
                'issue'          => null,
                'pages'          => null,
                'abstract'       => $abstract,
                'url'            => $url,
                'creator'        => ucfirst($source),
                'creator_token'  => null,
                'timestamp'      => time(),
                'raw_json'       => json_encode([
                    'book'              => $bookId,
                    'title'             => $title,
                    'author'            => $author,
                    'year'              => $year,
                    'type'              => $normalised['type'] ?? null,
                    'publisher'         => $normalised['publisher'] ?? null,
                    'open_library_key'  => $olKey,
                    'url'               => $url,
                    'bibtex'            => $bibtex,
                    'visibility'        => 'public',
                    'creator'           => ucfirst($source),
                ]),
                'created_at'     => $now,
                'updated_at'     => $now,
            ]);

            return $bookId;
        } catch (\Exception $e) {
            Log::warning("Library stub creation failed ({$source}): " . $e->getMessage());
            return null;
        }
    }

    /**
     * Generate a BibTeX entry string from a raw OpenAlex work.
     */
    public function generateBibtex(array $work): string
    {
        $rawId = $work['id'] ?? null;
        $openalexId = $rawId ? basename($rawId) : 'unknown';

        $type = match ($work['type'] ?? '') {
            'journal-article' => 'article',
            'book'            => 'book',
            'book-chapter'    => 'incollection',
            'conference'      => 'inproceedings',
            'dissertation'    => 'phdthesis',
            default           => 'misc',
        };

        $authorships = $work['authorships'] ?? [];
        $bibtexAuthors = array_map(function ($a) {
            $name = $a['author']['display_name'] ?? 'Unknown';
            $parts = explode(' ', trim($name));
            if (count($parts) === 1) {
                return $parts[0];
            }
            $last = array_pop($parts);
            $first = implode(' ', $parts);
            return $last . ', ' . $first;
        }, $authorships);

        $authorStr = implode(' and ', $bibtexAuthors) ?: 'Unknown';

        $title  = $work['title'] ?? '';
        $year   = $work['publication_year'] ?? '';
        $journal = $work['primary_location']['source']['display_name'] ?? null;
        $volume  = $work['biblio']['volume'] ?? null;
        $number  = $work['biblio']['issue'] ?? null;
        $firstPage = $work['biblio']['first_page'] ?? null;
        $lastPage  = $work['biblio']['last_page'] ?? null;
        $pages = ($firstPage && $lastPage) ? $firstPage . '--' . $lastPage : ($firstPage ?? null);

        $doi = $work['doi'] ?? null;
        if ($doi && str_starts_with($doi, 'https://doi.org/')) {
            $doi = substr($doi, strlen('https://doi.org/'));
        }

        $doiUrl = $doi ? 'https://doi.org/' . $doi : null;

        $fields = [
            'author' => $authorStr,
            'title'  => $title,
            'year'   => (string) $year,
        ];

        if ($journal) {
            $fieldKey = in_array($type, ['inproceedings']) ? 'booktitle' : 'journal';
            $fields[$fieldKey] = $journal;
        }
        if ($volume)  $fields['volume'] = $volume;
        if ($number)  $fields['number'] = $number;
        if ($pages)   $fields['pages']  = $pages;
        if ($doi)     $fields['doi']    = $doi;
        if ($doiUrl)  $fields['url']    = $doiUrl;

        $lines = ["@{$type}{{$openalexId},"];
        foreach ($fields as $key => $value) {
            $escaped = str_replace('{', '\\{', str_replace('}', '\\}', (string) $value));
            $lines[] = "  {$key} = {{$escaped}},";
        }
        $lines[] = '}';

        return implode("\n", $lines);
    }
}
