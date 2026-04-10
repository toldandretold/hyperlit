<?php

namespace App\Http\Controllers;

use App\Helpers\SubBookIdHelper;
use App\Services\BillingService;
use App\Services\EmbeddingService;
use App\Services\LlmService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class AiBrainController extends Controller
{
    public function query(Request $request, EmbeddingService $embeddingService, LlmService $llmService, BillingService $billingService): JsonResponse
    {
        try {
            // 1. Auth + billing check
            $user = Auth::user();
            if (!$user) {
                return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
            }

            $user->refresh();

            if (!$billingService->canProceed($user)) {
                return response()->json(['success' => false, 'message' => 'Insufficient balance'], 402);
            }

            // 2. Validate
            $validated = $request->validate([
                'selectedText' => 'required|string|min:5|max:5000',
                'question'     => 'required|string|min:3|max:2000',
                'bookId'       => 'required|string',
                'highlightId'  => 'required|string',
                'nodeIds'      => 'required|array',
                'charData'     => 'required|array',
            ]);

            $selectedText = $validated['selectedText'];
            $question = $validated['question'];
            $bookId = $validated['bookId'];

            Log::info('AiBrain: query started', [
                'user' => $user->name,
                'book' => $bookId,
                'question' => Str::limit($question, 100),
                'selectedText_len' => strlen($selectedText),
            ]);

            // 3. Embed the query (selectedText + question)
            $queryText = $selectedText . "\n\n" . $question;
            $queryEmbedding = $embeddingService->embed($queryText, 'search_query: ');

            if (!$queryEmbedding) {
                Log::warning('AiBrain: embedding failed');
                return response()->json(['success' => false, 'message' => 'Failed to generate query embedding'], 500);
            }

            Log::info('AiBrain: embedding generated', ['dimensions' => count($queryEmbedding)]);

            // 4. Vector similarity search → top 10 matching nodes
            $matches = $embeddingService->searchSimilar($queryEmbedding, 10, $bookId);

            if (empty($matches)) {
                Log::info('AiBrain: no matches found', ['excludeBook' => $bookId]);
                return response()->json(['success' => false, 'message' => 'No relevant passages found in the library'], 404);
            }

            Log::info('AiBrain: vector search results', [
                'match_count' => count($matches),
                'top_similarity' => round($matches[0]->similarity * 100, 1) . '%',
                'top_book' => $matches[0]->book ?? 'unknown',
                'top_author' => $matches[0]->book_author ?? 'unknown',
            ]);

            // 5. Build LLM prompt with matched passages + citation details
            $passageContext = $this->buildPassageContext($matches);
            $systemPrompt = $this->buildSystemPrompt();
            $userMessage = $this->buildUserMessage($selectedText, $question, $passageContext);

            // 6. Call DeepSeek via LlmService
            Log::info('AiBrain: calling LLM...');
            $llmResponse = $llmService->chat(
                $systemPrompt,
                $userMessage,
                0.3,      // temperature
                4096,     // max tokens
                'accounts/fireworks/models/deepseek-v3p2',
                120,      // timeout
                null      // reasoning_effort (let model decide)
            );

            if (!$llmResponse) {
                Log::warning('AiBrain: LLM returned empty response');
                return response()->json(['success' => false, 'message' => 'AI generation failed'], 500);
            }

            Log::info('AiBrain: LLM response received', ['raw_length' => strlen($llmResponse)]);

            // Strip <think> tags if present
            $llmResponse = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $llmResponse);
            if (str_contains($llmResponse, '<think>')) {
                $llmResponse = preg_replace('/<think>[\s\S]*/i', '', $llmResponse);
            }
            $llmResponse = trim($llmResponse);

            // 7. Parse citations and create hypercites
            $timestamp = now()->timestamp;
            $highlightId = $validated['highlightId'];
            $subBookId = SubBookIdHelper::build($bookId, $highlightId);

            [$processedHtml, $hypercites] = $this->processCitationsInResponse(
                $llmResponse,
                $matches,
                $bookId,
                $user
            );

            Log::info('AiBrain: citations processed', [
                'hypercites_count' => count($hypercites),
                'html_length' => strlen($processedHtml),
            ]);

            // 8. Create library record for the sub-book (via pgsql_admin to bypass RLS)
            DB::connection('pgsql_admin')->table('library')->updateOrInsert(
                ['book' => $subBookId],
                [
                    'creator'       => 'LLM-data-pipeline',
                    'creator_token' => null,
                    'visibility'    => 'public',
                    'listed'        => false,
                    'title'         => 'AI: ' . Str::limit($question, 80),
                    'type'          => 'sub_book',
                    'has_nodes'     => true,
                    'raw_json'      => json_encode([]),
                    'timestamp'     => 0,
                ]
            );
            Log::info('AiBrain: library record upserted', ['subBookId' => $subBookId]);

            // 9. Clear existing nodes for this sub-book (synced from highlight creation) and replace with LLM response
            DB::connection('pgsql_admin')->table('nodes')->where('book', $subBookId)->delete();
            $nodes = $this->createResponseNodes($processedHtml, $subBookId);

            // 10. Upsert hyperlight record with full data + preview_nodes (via pgsql_admin to bypass RLS)
            $previewNodes = array_map(function ($node) {
                return [
                    'node_id'   => $node['node_id'],
                    'content'   => $node['content'],
                    'plainText' => $node['plainText'],
                ];
            }, array_slice($nodes, 0, 5));

            $hyperlightData = [
                'book'            => $bookId,
                'hyperlight_id'   => $highlightId,
                'sub_book_id'     => $subBookId,
                'node_id'         => json_encode($validated['nodeIds']),
                'charData'        => json_encode($validated['charData']),
                'annotation'      => null,
                'highlightedText' => Str::limit($selectedText, 500),
                'creator'         => 'LLM-data-pipeline',
                'creator_token'   => null,
                'time_since'      => $timestamp,
                'preview_nodes'   => json_encode($previewNodes),
                'raw_json'        => json_encode([]),
                'hidden'          => false,
            ];
            DB::connection('pgsql_admin')->table('hyperlights')->updateOrInsert(
                ['book' => $bookId, 'hyperlight_id' => $highlightId],
                $hyperlightData
            );
            Log::info('AiBrain: hyperlight record upserted', ['highlightId' => $highlightId]);

            // 11. Bill user
            $usageStats = $llmService->getUsageStats();
            $totalCost = $this->calculateCost($usageStats, $embeddingService, $queryText);

            $billingService->charge(
                $user,
                $totalCost,
                'AI Brain: ' . Str::limit($question, 60),
                'ai_brain',
                [],
                ['book_id' => $bookId, 'highlight_id' => $highlightId]
            );

            // Verify writes actually landed in the DB
            $verifyNodes = DB::connection('pgsql_admin')->table('nodes')->where('book', $subBookId)->count();
            $verifyLib = DB::connection('pgsql_admin')->table('library')->where('book', $subBookId)->exists();
            $verifyHl = DB::connection('pgsql_admin')->table('hyperlights')->where('hyperlight_id', $highlightId)->exists();
            Log::info('AiBrain: DB verification', [
                'nodes_in_db'      => $verifyNodes,
                'library_exists'   => $verifyLib,
                'hyperlight_exists' => $verifyHl,
            ]);

            Log::info('AiBrain: complete', [
                'highlightId' => $highlightId,
                'subBookId' => $subBookId,
                'nodes_count' => count($nodes),
                'hypercites_count' => count($hypercites),
                'cost' => $totalCost,
            ]);

            // 12. Return everything
            return response()->json([
                'success'       => true,
                'highlightId'   => $highlightId,
                'subBookId'     => $subBookId,
                'nodes'         => $nodes,
                'preview_nodes' => $previewNodes,
                'library'       => [
                    'book'       => $subBookId,
                    'title'      => 'AI: ' . Str::limit($question, 80),
                    'type'       => 'sub_book',
                    'visibility' => 'public',
                    'has_nodes'  => true,
                ],
                'hyperlight'  => $hyperlightData,
                'hypercites'  => $hypercites,
            ]);

        } catch (\Illuminate\Validation\ValidationException $e) {
            return response()->json([
                'success' => false,
                'message' => 'Validation failed',
                'errors'  => $e->errors(),
            ], 422);
        } catch (\Exception $e) {
            Log::error('AiBrainController::query - exception', [
                'error' => $e->getMessage(),
                'trace' => $e->getTraceAsString(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'AI query failed',
            ], 500);
        }
    }

    private function buildSystemPrompt(): string
    {
        return <<<'PROMPT'
You are a scholarly research assistant embedded within a reading platform. The user has selected a passage from a text and is asking a question about it.

Your task:
1. Answer the question in relation to the selected passage
2. Draw on the provided source passages from the user's library to support your answer
3. When you quote or reference a source, include the citation in [Surname Year] format (e.g. [Marx 1867], [Amin 1974])
4. Include actual brief quotes from the source passages where relevant, followed by the citation
5. Format your response as HTML paragraphs using <p> tags

Rules:
- Only cite sources from the provided passages — do not invent citations
- Use the author surname and year provided in the passage metadata
- Keep your response focused and substantive (3-8 paragraphs)
- Use <em> for emphasis and <blockquote> for longer quotes
- Do NOT include headings (h1-h6) — the response will appear in a sub-book context
- Do NOT wrap the entire response in a container div
PROMPT;
    }

    private function buildUserMessage(string $selectedText, string $question, string $passageContext): string
    {
        return <<<EOT
SELECTED PASSAGE:
{$selectedText}

QUESTION:
{$question}

SOURCE PASSAGES FROM LIBRARY:
{$passageContext}
EOT;
    }

    private function buildPassageContext(array $matches): string
    {
        $context = '';
        foreach ($matches as $idx => $match) {
            $num = $idx + 1;
            $author = $match->book_author ?? 'Unknown';
            $year = $match->book_year ?? '';
            $title = $match->book_title ?? 'Untitled';
            $text = $match->plainText ?? '';
            $similarity = round($match->similarity * 100, 1);

            $context .= "--- Passage {$num} (similarity: {$similarity}%) ---\n";
            $context .= "Source: {$author} ({$year}). {$title}\n";
            $context .= "Book ID: {$match->book}\n";
            $context .= "Node ID: {$match->node_id}\n";
            $context .= "Text: {$text}\n\n";
        }

        return $context;
    }

    /**
     * Parse [Surname Year] patterns in the LLM response and create hypercite records.
     * Returns [processedHtml, hypercitesArray].
     */
    private function processCitationsInResponse(string $html, array $matches, string $bookId, $user): array
    {
        $hypercites = [];

        // Build a lookup: surname → match data
        $authorLookup = [];
        foreach ($matches as $match) {
            $author = $match->book_author ?? '';
            // Extract surname (first word, or last part before comma)
            $surname = $this->extractSurname($author);
            if ($surname) {
                $key = strtolower($surname);
                if (!isset($authorLookup[$key])) {
                    $authorLookup[$key] = $match;
                }
            }
        }

        // Find [Surname Year] patterns
        $processedHtml = preg_replace_callback(
            '/\[([A-Z][a-zA-Zàáâãäéèêëíìîïóòôõöúùûüçñ\'-]+)\s+(\d{4})\]/',
            function ($m) use (&$hypercites, $authorLookup, $bookId, $user) {
                $surname = $m[1];
                $year = $m[2];
                $key = strtolower($surname);

                if (!isset($authorLookup[$key])) {
                    // No matching source — keep the citation text as-is
                    return $m[0];
                }

                $match = $authorLookup[$key];
                $hyperciteId = 'hypercite_' . Str::random(8);

                // Create hypercite record — whole-node position (via pgsql_admin to bypass RLS)
                $plainText = $match->plainText ?? '';
                $hyperciteData = [
                    'book'               => $match->book,
                    'hyperciteId'        => $hyperciteId,
                    'node_id'            => json_encode([$match->node_id]),
                    'charData'           => json_encode([
                        $match->node_id => [
                            'charStart' => 0,
                            'charEnd'   => strlen($plainText),
                        ],
                    ]),
                    'citedIN'            => json_encode([$bookId]),
                    'hypercitedText'     => Str::limit($plainText, 300),
                    'relationshipStatus' => 'ai_generated',
                    'creator'            => $user->name,
                    'creator_token'      => null,
                    'time_since'         => now()->timestamp,
                    'raw_json'           => json_encode([]),
                ];
                DB::connection('pgsql_admin')->table('hypercites')->insert($hyperciteData);
                Log::info('AiBrain: hypercite inserted', ['hyperciteId' => $hyperciteId, 'book' => $match->book]);

                $hypercites[] = $hyperciteData;

                // Build the clickable link
                $linkHref = "/{$match->book}#{$hyperciteId}";
                return '<a href="' . e($linkHref) . '">' . e("{$surname} {$year}") . '<sup class="open-icon">&nearr;</sup></a>';
            },
            $html
        );

        return [$processedHtml, $hypercites];
    }

    /**
     * Extract the primary surname from an author string.
     * Handles "Surname, Firstname", "Firstname Surname", "Surname" formats.
     */
    private function extractSurname(string $author): ?string
    {
        $author = trim($author);
        if (empty($author)) {
            return null;
        }

        // "Surname, Firstname" format
        if (str_contains($author, ',')) {
            return trim(explode(',', $author)[0]);
        }

        // "Firstname Surname" format — take last word
        $parts = preg_split('/\s+/', $author);
        return end($parts) ?: null;
    }

    /**
     * Split the processed HTML response into paragraph nodes and insert into DB.
     */
    private function createResponseNodes(string $html, string $subBookId): array
    {
        // Split on </p> boundaries, keeping the tags
        $paragraphs = preg_split('/(?<=<\/p>)\s*/', $html);
        $paragraphs = array_filter($paragraphs, fn($p) => trim(strip_tags($p)) !== '');
        $paragraphs = array_values($paragraphs);

        // If the response wasn't already in <p> tags, wrap it
        if (empty($paragraphs)) {
            $paragraphs = ['<p>' . $html . '</p>'];
        }

        $nodes = [];
        $chunkId = 0;

        foreach ($paragraphs as $idx => $paragraph) {
            $paragraph = trim($paragraph);
            if (empty($paragraph)) continue;

            $nodeId = (string) Str::uuid();

            // Ensure paragraph has a data-node-id attribute
            if (!str_contains($paragraph, 'data-node-id')) {
                // Wrap in a <p> with data-node-id if not already a <p>
                if (preg_match('/^<p[\s>]/i', $paragraph)) {
                    $paragraph = preg_replace('/^<p/i', '<p data-node-id="' . $nodeId . '"', $paragraph, 1);
                } elseif (preg_match('/^<blockquote[\s>]/i', $paragraph)) {
                    $paragraph = preg_replace('/^<blockquote/i', '<blockquote data-node-id="' . $nodeId . '"', $paragraph, 1);
                } else {
                    $paragraph = '<p data-node-id="' . $nodeId . '">' . $paragraph . '</p>';
                }
            }

            $plainText = strip_tags($paragraph);

            DB::connection('pgsql_admin')->table('nodes')->insert([
                'book'       => $subBookId,
                'chunk_id'   => $chunkId,
                'startLine'  => $idx + 1,
                'node_id'    => $nodeId,
                'content'    => $paragraph,
                'plainText'  => $plainText,
                'raw_json'   => json_encode([]),
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            $nodes[] = [
                'book'      => $subBookId,
                'chunk_id'  => $chunkId,
                'startLine' => $idx + 1,
                'node_id'   => $nodeId,
                'content'   => $paragraph,
                'plainText' => $plainText,
            ];
        }

        return $nodes;
    }

    /**
     * Calculate the total cost of this AI brain operation.
     */
    private function calculateCost(array $usageStats, EmbeddingService $embeddingService, string $queryText): float
    {
        $pricing = config('services.llm.pricing');
        $totalCost = 0.0;

        // LLM cost
        foreach ($usageStats['by_model'] as $model => $usage) {
            $modelPricing = $pricing[$model] ?? null;
            if ($modelPricing) {
                $inputCost = ($usage['prompt_tokens'] / 1_000_000) * ($modelPricing['input'] ?? 0);
                $outputCost = ($usage['completion_tokens'] / 1_000_000) * ($modelPricing['output'] ?? 0);
                $totalCost += $inputCost + $outputCost;
            }
        }

        // Embedding cost
        $embeddingPricing = $pricing['nomic-ai/nomic-embed-text-v1.5'] ?? null;
        if ($embeddingPricing) {
            $embeddingTokens = $embeddingService->estimateTokens($queryText);
            $totalCost += ($embeddingTokens / 1_000_000) * ($embeddingPricing['input'] ?? 0);
        }

        return max($totalCost, 0.0001); // Minimum charge
    }
}
