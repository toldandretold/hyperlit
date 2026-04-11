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
    public function status(string $highlightId): JsonResponse
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['status' => 'error'], 401);
        }

        $highlight = DB::connection('pgsql_admin')->table('hyperlights')
            ->where('hyperlight_id', $highlightId)
            ->select('sub_book_id', 'preview_nodes', 'raw_json')
            ->first();

        if (!$highlight) {
            return response()->json(['status' => 'not_found'], 404);
        }

        if ($highlight->sub_book_id) {
            return response()->json([
                'status' => 'completed',
                'sub_book_id' => $highlight->sub_book_id,
                'preview_nodes' => json_decode($highlight->preview_nodes, true),
                'raw_json' => $highlight->raw_json,
            ]);
        }

        return response()->json(['status' => 'processing']);
    }

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
                'model'        => 'nullable|string|max:100',
                'sourceScope'  => 'nullable|string|in:public,mine,all,this',
            ]);

            $allowedModels = [
                'accounts/fireworks/models/deepseek-v3p2',
                'accounts/fireworks/models/deepseek-v3p1',
                'accounts/fireworks/models/qwen3p6-plus',
                'accounts/fireworks/models/kimi-k2p5',
                'accounts/fireworks/models/kimi-k2-instruct',
                'accounts/cogito/models/cogito-671b-v2-p1',
                'accounts/fireworks/models/llama-v3p3-70b-instruct',
                'accounts/fireworks/models/minimax-m2p5',
            ];
            $brainModel = in_array($validated['model'] ?? null, $allowedModels)
                ? $validated['model']
                : 'accounts/fireworks/models/deepseek-v3p2';

            $selectedText = $validated['selectedText'];
            $question = $validated['question'];
            $bookId = $validated['bookId'];
            $sourceScope = $validated['sourceScope'] ?? 'public';
            $creatorName = $user->name;

            Log::info('AiBrain: query started', [
                'user' => $user->name,
                'book' => $bookId,
                'question' => Str::limit($question, 100),
                'selectedText_len' => strlen($selectedText),
            ]);

            // 3. Classify the query via Qwen 3-8B router
            $routerResult = $this->classifyQuery($llmService, $selectedText, $question, $bookId);
            $strategy = $routerResult['strategy'];
            $authorName = $routerResult['author_name'];
            $bookTitle = $routerResult['book_title'];

            Log::info('AiBrain: router classified', [
                'strategy' => $strategy,
                'reasoning' => $routerResult['reasoning'],
                'author' => $authorName,
            ]);

            $pipelineLog = [
                'router_model' => 'qwen3-8b',
                'strategy' => $strategy,
                'router_reasoning' => $routerResult['reasoning'],
                'book_title' => $bookTitle,
                'book_author' => $authorName,
                'source_scope' => $sourceScope,
            ];

            // 4. Strategy-specific retrieval
            $queryText = null;
            $queryEmbedding = null;
            $matches = [];
            $localContext = [];

            if ($strategy === 'direct') {
                $localContext = $this->fetchSurroundingContext($bookId, $validated['nodeIds']);
                $pipelineLog['retrieval_method'] = 'Fetched surrounding nodes from same book (no embedding)';
                $pipelineLog['context_nodes'] = count($localContext);
                Log::info('AiBrain: direct strategy — local context', ['nodes' => count($localContext)]);
            } elseif ($strategy === 'same_author') {
                // Fall through to full_search if no author
                if (empty($authorName)) {
                    $strategy = 'full_search';
                    $pipelineLog['strategy'] = 'full_search';
                    $pipelineLog['router_reasoning'] .= ' (fallback: no author found)';
                    Log::info('AiBrain: same_author fallback to full_search — no author');
                } else {
                    $queryText = $selectedText . "\n\n" . $question;
                    $queryEmbedding = $embeddingService->embed($queryText, 'search_query: ');

                    if (!$queryEmbedding) {
                        Log::warning('AiBrain: embedding failed');
                        return response()->json(['success' => false, 'message' => 'Failed to generate query embedding'], 500);
                    }

                    $matches = $embeddingService->searchSimilarByAuthor($queryEmbedding, 10, $bookId, $authorName, $sourceScope, $creatorName);

                    // Fall through to full_search if <3 results
                    if (count($matches) < 3) {
                        Log::info('AiBrain: same_author fallback to full_search — only ' . count($matches) . ' results');
                        $matches = $embeddingService->searchSimilar($queryEmbedding, 10, $bookId, $sourceScope, $creatorName);
                        $strategy = 'full_search';
                        $pipelineLog['strategy'] = 'full_search';
                        $pipelineLog['router_reasoning'] .= ' (fallback: <3 same-author results)';
                    } else {
                        $pipelineLog['retrieval_method'] = "Selected text was vector-embedded and compared against books by {$authorName}"
                            . $this->scopeSuffix($sourceScope);
                    }
                }
            }

            // full_search: either originally classified or fell through from same_author
            if ($strategy === 'full_search') {
                $queryText = $queryText ?? ($selectedText . "\n\n" . $question);
                if (!$queryEmbedding) {
                    $queryEmbedding = $embeddingService->embed($queryText, 'search_query: ');
                    if (!$queryEmbedding) {
                        Log::warning('AiBrain: embedding failed');
                        return response()->json(['success' => false, 'message' => 'Failed to generate query embedding'], 500);
                    }
                }
                if (empty($matches)) {
                    $matches = $embeddingService->searchSimilar($queryEmbedding, 10, $bookId, $sourceScope, $creatorName);
                }
                $scopeDescriptions = [
                    'public' => 'all public books in the library',
                    'mine'   => 'your books',
                    'all'    => 'all public books and your books',
                    'this'   => 'this book only',
                ];
                $pipelineLog['retrieval_method'] = 'Selected text was vector-embedded and compared against '
                    . ($scopeDescriptions[$sourceScope] ?? 'all public books in the library');
            }

            // Check for matches in search strategies
            if ($strategy !== 'direct' && empty($matches)) {
                Log::info('AiBrain: no matches found', ['strategy' => $strategy]);
                return response()->json(['success' => false, 'message' => 'No relevant passages found in the library'], 404);
            }

            if (!empty($matches)) {
                $pipelineLog['matches_found'] = count($matches);
                $pipelineLog['sources_consulted'] = array_map(fn($m) => [
                    'title' => $m->book_title ?? 'Untitled',
                    'year' => $m->book_year ?? '',
                    'similarity' => round($m->similarity * 100, 1),
                    'excerpt' => Str::limit($m->plainText ?? '', 80),
                ], array_slice($matches, 0, 10));

                Log::info('AiBrain: vector search results', [
                    'strategy' => $strategy,
                    'match_count' => count($matches),
                    'top_similarity' => round($matches[0]->similarity * 100, 1) . '%',
                    'top_book' => $matches[0]->book ?? 'unknown',
                    'top_author' => $matches[0]->book_author ?? 'unknown',
                ]);
            }

            // 5. Build strategy-specific LLM prompts
            $systemPrompt = $this->buildSystemPromptForStrategy($strategy);

            switch ($strategy) {
                case 'direct':
                    $userMessage = $this->buildDirectUserMessage($selectedText, $question, $localContext);
                    $pipelineLog['prompt_summary'] = 'Selected passage + question + ' . count($localContext) . ' surrounding nodes';
                    break;
                case 'same_author':
                    $passageContext = $this->buildPassageContext($matches);
                    $userMessage = $this->buildSameAuthorUserMessage($selectedText, $question, $passageContext, $authorName, $bookTitle);
                    $pipelineLog['prompt_summary'] = 'Selected passage + question + ' . count($matches) . ' source passages from same author';
                    break;
                default:
                    $passageContext = $this->buildPassageContext($matches);
                    $userMessage = $this->buildUserMessage($selectedText, $question, $passageContext);
                    $pipelineLog['prompt_summary'] = 'Selected passage + question + ' . count($matches) . ' source passages from library';
                    break;
            }

            // 6. Call LLM via LlmService (model chosen by user)
            Log::info('AiBrain: calling LLM...', ['strategy' => $strategy, 'model' => $brainModel]);
            $llmResponse = $llmService->chat(
                $systemPrompt,
                $userMessage,
                0.3,      // temperature
                4096,     // max tokens
                $brainModel,
                180,      // timeout
                null      // reasoning_effort (let model decide)
            );

            if (!$llmResponse) {
                Log::warning('AiBrain: LLM returned empty response');
                return response()->json([
                    'success' => false,
                    'message' => 'The AI took too long to respond. Please try again.',
                ], 504);
            }

            Log::info('AiBrain: LLM response received', ['raw_length' => strlen($llmResponse)]);

            // Strip <think> tags if present
            $llmResponse = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $llmResponse);
            if (str_contains($llmResponse, '<think>')) {
                $llmResponse = preg_replace('/<think>[\s\S]*/i', '', $llmResponse);
            }
            $llmResponse = trim($llmResponse);

            // 7. Parse citations and create hypercites (skip for 'direct' — no external sources)
            $timestamp = now()->timestamp;
            $highlightId = $validated['highlightId'];
            $subBookId = SubBookIdHelper::build($bookId, $highlightId);
            $hypercites = [];
            $processedHtml = $llmResponse;

            if ($strategy !== 'direct' && !empty($matches)) {
                [$processedHtml, $hypercites] = $this->processCitationsInResponse(
                    $llmResponse,
                    $matches,
                    $bookId,
                    $user
                );
            }

            Log::info('AiBrain: citations processed', [
                'strategy' => $strategy,
                'hypercites_count' => count($hypercites),
                'html_length' => strlen($processedHtml),
            ]);

            // 8. Create library record for the sub-book (via pgsql_admin to bypass RLS)
            DB::connection('pgsql_admin')->table('library')->updateOrInsert(
                ['book' => $subBookId],
                [
                    'creator'       => $user->name,
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

            // Build conversational format: Username asks, AI Archivist answers
            $questionNode = '<p><b>Prompt</b>: "' . e(Str::limit($question, 1000)) . '"</p>';
            $aiLabel = '<p><b>AI Archivist</b>:</p>';
            $conversationHtml = $questionNode . $aiLabel . $processedHtml;

            $nodes = $this->createResponseNodes($conversationHtml, $subBookId);

            // 9b. Build and append pipeline appendix
            $usageStats = $llmService->getUsageStats();
            $totalCost = $this->calculateCost($usageStats, $embeddingService, $queryText);
            $pipelineLog['cost'] = $totalCost;
            $pipelineLog['llm_model'] = basename($brainModel);

            $appendixHtml = $this->buildAppendixHtml($pipelineLog);
            $appendixNodes = $this->createResponseNodes($appendixHtml, $subBookId, count($nodes));
            $nodes = array_merge($nodes, $appendixNodes);

            // 10. Upsert hyperlight record with full data + preview_nodes (via pgsql_admin to bypass RLS)
            $previewNodes = array_map(function ($node) {
                return [
                    'book'      => $node['book'],
                    'chunk_id'  => $node['chunk_id'],
                    'startLine' => $node['startLine'],
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
                'creator'         => $user->name,
                'creator_token'   => null,
                'time_since'      => $timestamp,
                'preview_nodes'   => json_encode($previewNodes),
                'raw_json'        => json_encode(['brain_query' => true, 'question' => Str::limit($question, 1000)]),
                'hidden'          => false,
            ];
            DB::connection('pgsql_admin')->table('hyperlights')->updateOrInsert(
                ['book' => $bookId, 'hyperlight_id' => $highlightId],
                $hyperlightData
            );
            Log::info('AiBrain: hyperlight record upserted', ['highlightId' => $highlightId]);

            // 10b. Update annotations_updated_at on parent book so other clients sync
            $nowMs = round(microtime(true) * 1000);
            DB::select('SELECT update_annotations_timestamp(?, ?)', [$bookId, $nowMs]);
            Log::info('AiBrain: annotations_updated_at updated', ['book' => $bookId]);

            // 11. Bill user (cost already calculated in step 9b)
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
                    'creator'    => $user->name,
                ],
                'hyperlight'  => $hyperlightData,
                'hypercites'  => $hypercites,
                'strategy'    => $strategy,
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
You are an AI Archivist — a scholarly research assistant helping users track down and analyse meaning across the Hyperlit archive of open access research. The user has selected a passage from a text and is asking a question about it.

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
    private function createResponseNodes(string $html, string $subBookId, int $startLineOffset = 0): array
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
                'startLine'  => $startLineOffset + $idx + 1,
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
                'startLine' => $startLineOffset + $idx + 1,
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
    private function calculateCost(array $usageStats, EmbeddingService $embeddingService, ?string $queryText): float
    {
        $pricing = config('services.llm.pricing');
        $totalCost = 0.0;

        // LLM cost (includes router + DeepSeek — both tracked by LlmService)
        foreach ($usageStats['by_model'] as $model => $usage) {
            $modelPricing = $pricing[$model] ?? null;
            if ($modelPricing) {
                $inputCost = ($usage['prompt_tokens'] / 1_000_000) * ($modelPricing['input'] ?? 0);
                $outputCost = ($usage['completion_tokens'] / 1_000_000) * ($modelPricing['output'] ?? 0);
                $totalCost += $inputCost + $outputCost;
            }
        }

        // Embedding cost (skipped for 'direct' strategy where no embedding is generated)
        if ($queryText !== null) {
            $embeddingPricing = $pricing['nomic-ai/nomic-embed-text-v1.5'] ?? null;
            if ($embeddingPricing) {
                $embeddingTokens = $embeddingService->estimateTokens($queryText);
                $totalCost += ($embeddingTokens / 1_000_000) * ($embeddingPricing['input'] ?? 0);
            }
        }

        return max($totalCost, 0.0001); // Minimum charge
    }

    /**
     * Classify the user's question into a retrieval strategy using Qwen 3-8B.
     */
    private function classifyQuery(LlmService $llmService, string $selectedText, string $question, string $bookId): array
    {
        $bookMeta = DB::table('library')->where('book', $bookId)->select('author', 'title', 'year')->first();
        $authorName = $bookMeta->author ?? null;
        $bookTitle = $bookMeta->title ?? 'Unknown';

        $systemPrompt = <<<'PROMPT'
You are a query classifier. The user selected a passage from a book and asked a question. Classify into ONE strategy:

1. "direct" — Question is about understanding/explaining/summarizing the selected text itself. No external sources needed.
2. "same_author" — Question asks about other work by the SAME author, or whether this author discussed a topic elsewhere.
3. "full_search" — Question asks what OTHER authors/sources say, or requests broad scholarly context.

Return ONLY valid JSON: {"strategy": "direct|same_author|full_search", "reasoning": "one sentence"}
PROMPT;

        $userMessage = "BOOK: \"{$bookTitle}\" by {$authorName}\nPASSAGE (excerpt): "
            . Str::limit($selectedText, 300) . "\nQUESTION: {$question}";

        $result = $llmService->chat($systemPrompt, $userMessage, 0.0, 80,
            'accounts/fireworks/models/qwen3-8b', 10, 'none');

        if ($result) {
            $result = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $result);
            $result = trim(preg_replace('/^```(?:json)?\s*|\s*```$/i', '', trim($result)));
            $parsed = json_decode($result, true);
            if (is_array($parsed) && in_array($parsed['strategy'] ?? '', ['direct', 'same_author', 'full_search'])) {
                return ['strategy' => $parsed['strategy'], 'reasoning' => $parsed['reasoning'] ?? '',
                        'author_name' => $authorName, 'book_title' => $bookTitle];
            }
        }

        Log::warning('AiBrain: router classification failed, defaulting to full_search', ['raw' => $result]);
        return ['strategy' => 'full_search', 'reasoning' => 'fallback', 'author_name' => $authorName, 'book_title' => $bookTitle];
    }

    /**
     * Fetch surrounding context nodes for the 'direct' strategy.
     */
    private function fetchSurroundingContext(string $bookId, array $nodeIds, int $radius = 5): array
    {
        $selectedNodes = DB::table('nodes')->where('book', $bookId)
            ->whereIn('node_id', $nodeIds)->orderBy('startLine')->get();

        if ($selectedNodes->isEmpty()) return [];

        $minLine = $selectedNodes->min('startLine');
        $maxLine = $selectedNodes->max('startLine');

        $lowerBound = DB::table('nodes')->where('book', $bookId)
            ->where('startLine', '<', $minLine)->orderByDesc('startLine')
            ->limit($radius)->pluck('startLine')->min();

        $upperBound = DB::table('nodes')->where('book', $bookId)
            ->where('startLine', '>', $maxLine)->orderBy('startLine')
            ->limit($radius)->pluck('startLine')->max();

        return DB::table('nodes')->where('book', $bookId)
            ->where('startLine', '>=', $lowerBound ?? $minLine)
            ->where('startLine', '<=', $upperBound ?? $maxLine)
            ->orderBy('startLine')
            ->get()
            ->map(fn($row) => tap($row, fn($r) => $r->is_selected = in_array($r->node_id, $nodeIds)))
            ->toArray();
    }

    /**
     * Build strategy-specific system prompt.
     */
    private function buildSystemPromptForStrategy(string $strategy): string
    {
        return match ($strategy) {
            'direct' => <<<'PROMPT'
You are an AI Archivist — a scholarly reading assistant helping users track down and analyse meaning across the Hyperlit archive of open access research. The user has selected a passage from a text and is asking a question about it.

Your task:
1. Answer the question using ONLY the selected passage and its surrounding context
2. Do NOT cite or reference external sources — everything you need is in the provided text
3. Format your response as HTML paragraphs using <p> tags

Rules:
- Focus on explaining, interpreting, or summarizing what the text says
- Use <em> for emphasis and <blockquote> for longer quotes from the passage
- Keep your response focused and substantive (2-6 paragraphs)
- Do NOT include headings (h1-h6) — the response will appear in a sub-book context
- Do NOT wrap the entire response in a container div
- Do NOT invent citations or reference works not in the provided context
PROMPT,
            'same_author' => <<<'PROMPT'
You are an AI Archivist — a scholarly research assistant helping users track down and analyse meaning across the Hyperlit archive of open access research. The user has selected a passage from a text and is asking about other work by the same author.

Your task:
1. Answer the question in relation to the selected passage
2. Draw on the provided source passages — all from the same author — to support your answer
3. When you reference a source, include the citation in [Title Year] format (e.g. [Unequal Development 1976], [Delinking 1990])
4. Include actual brief quotes from the source passages where relevant, followed by the citation
5. Highlight connections, developments, and continuities across the author's works
6. Format your response as HTML paragraphs using <p> tags

Rules:
- Only cite sources from the provided passages — do not invent citations
- Use the book title and year provided in the passage metadata
- Keep your response focused and substantive (3-8 paragraphs)
- Use <em> for emphasis and <blockquote> for longer quotes
- Do NOT include headings (h1-h6) — the response will appear in a sub-book context
- Do NOT wrap the entire response in a container div
PROMPT,
            default => $this->buildSystemPrompt(),
        };
    }

    /**
     * Build user message for the 'direct' strategy with surrounding context.
     */
    private function buildDirectUserMessage(string $selectedText, string $question, array $surroundingNodes): string
    {
        $preceding = '';
        $following = '';
        $passedSelected = false;

        foreach ($surroundingNodes as $node) {
            $text = $node->plainText ?? '';
            if (empty(trim($text))) continue;

            if ($node->is_selected) {
                $passedSelected = true;
                continue; // Skip selected nodes — they're in $selectedText
            }

            if (!$passedSelected) {
                $preceding .= $text . "\n";
            } else {
                $following .= $text . "\n";
            }
        }

        $msg = '';
        if (trim($preceding)) {
            $msg .= "PRECEDING CONTEXT:\n" . trim($preceding) . "\n\n";
        }
        $msg .= "SELECTED PASSAGE:\n{$selectedText}\n\n";
        if (trim($following)) {
            $msg .= "FOLLOWING CONTEXT:\n" . trim($following) . "\n\n";
        }
        $msg .= "QUESTION:\n{$question}";

        return $msg;
    }

    /**
     * Build user message for the 'same_author' strategy.
     */
    private function buildSameAuthorUserMessage(string $selectedText, string $question, string $passageContext, string $authorName, string $bookTitle): string
    {
        return <<<EOT
SELECTED PASSAGE (from "{$bookTitle}" by {$authorName}):
{$selectedText}

QUESTION:
{$question}

OTHER WORKS BY {$authorName}:
{$passageContext}
EOT;
    }

    /**
     * Build the pipeline appendix HTML showing router decision, retrieval, and cost.
     */
    private function buildAppendixHtml(array $log): string
    {
        $strategy = $log['strategy'] ?? 'unknown';
        $reasoning = e($log['router_reasoning'] ?? '');
        $retrieval = e($log['retrieval_method'] ?? '');
        $cost = number_format($log['cost'] ?? 0, 5);

        $scopeLabels = ['public' => 'Public library', 'mine' => 'My books', 'all' => 'Public + my books', 'this' => 'This book only'];

        $html = '<p data-appendix="true"><strong>Appendix</strong></p>';

        $html .= '<p data-appendix="true"><strong>Router (Qwen 3-8B):</strong> Classified this as a <em>'
            . e($strategy) . '</em> query — "' . $reasoning . '"</p>';

        $html .= '<p data-appendix="true"><strong>Source scope:</strong> ' . e($scopeLabels[$log['source_scope'] ?? 'public'] ?? 'Public library') . '</p>';

        $html .= '<p data-appendix="true"><strong>Retrieval:</strong> ' . $retrieval . '</p>';

        // Sources consulted (for same_author and full_search)
        if (!empty($log['sources_consulted'])) {
            $sourceLines = '';
            foreach ($log['sources_consulted'] as $src) {
                $title = e($src['title'] ?? 'Untitled');
                $year = e($src['year'] ?? '');
                $similarity = $src['similarity'] ?? '';
                $excerpt = e(Str::limit($src['excerpt'] ?? '', 80));
                $sourceLines .= "<em>{$title}</em> ({$year}) — {$similarity}% match — \"{$excerpt}\"<br>";
            }
            $html .= '<p data-appendix="true"><strong>Sources consulted:</strong><br>' . $sourceLines . '</p>';
        }

        if (!empty($log['context_nodes'])) {
            $html .= '<p data-appendix="true"><strong>Local context:</strong> '
                . (int)$log['context_nodes'] . ' surrounding nodes from the same book.</p>';
        }

        $llmModel = e($log['llm_model'] ?? 'deepseek-v3p2');
        $html .= '<p data-appendix="true"><strong>Sent to ' . $llmModel . ':</strong> '
            . e($log['prompt_summary'] ?? 'Selected passage + question') . '</p>';

        $html .= '<p data-appendix="true"><strong>Cost:</strong> $' . $cost . '</p>';

        return $html;
    }

    private function scopeSuffix(string $sourceScope): string
    {
        return match ($sourceScope) {
            'mine'  => ' (scoped to your books)',
            'all'   => ' (scoped to public + your books)',
            'this'  => ' (scoped to this book only)',
            default => '',
        };
    }
}
