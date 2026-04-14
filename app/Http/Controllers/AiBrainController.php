<?php

namespace App\Http\Controllers;

use App\Helpers\SubBookIdHelper;
use App\Services\BillingService;
use App\Services\EmbeddingService;
use App\Services\LlmService;
use App\Services\RetrievalService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class AiBrainController extends Controller
{
    public function __construct(
        private RetrievalService $retrievalService,
    ) {}

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

            // 3. Plan retrieval via DeepSeek v3 router
            $planResult = $this->planRetrieval($llmService, $selectedText, $question, $bookId);
            $plan = $planResult['plan'];
            $authorName = $planResult['author_name'];
            $bookTitle = $planResult['book_title'];

            Log::info('AiBrain: router planned', [
                'tools' => $plan['tools'],
                'reasoning' => $plan['reasoning'] ?? '',
                'keywords' => $plan['keywords'] ?? '',
                'author' => $authorName,
            ]);

            $pipelineLog = [
                'router_model' => 'deepseek-v3',
                'tools' => $plan['tools'],
                'router_reasoning' => $plan['reasoning'] ?? '',
                'keywords' => $plan['keywords'] ?? '',
                'book_title' => $bookTitle,
                'book_author' => $authorName,
                'source_scope' => $sourceScope,
            ];

            // 4. Execute retrieval plan
            $context = [
                'bookId' => $bookId,
                'nodeIds' => $validated['nodeIds'],
                'selectedText' => $selectedText,
                'question' => $question,
                'authorName' => $authorName,
                'bookTitle' => $bookTitle,
                'sourceScope' => $sourceScope,
                'creatorName' => $creatorName,
            ];

            $result = $this->retrievalService->execute($plan, $context);
            $matches = $result['matches'];
            $localContext = $result['localContext'];
            $queryText = $result['queryText'];
            $toolsUsed = $result['toolsUsed'];

            $pipelineLog['retrieval_log'] = $result['log'];
            $pipelineLog['tools_used'] = $toolsUsed;

            // Check for matches when search tools were used
            $hasSearchTools = !empty(array_intersect($toolsUsed, ['embedding_search', 'keyword_search', 'library_search']));
            if ($hasSearchTools && empty($matches)) {
                Log::info('AiBrain: no matches found', ['tools' => $toolsUsed]);
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

                Log::info('AiBrain: search results', [
                    'tools' => $toolsUsed,
                    'match_count' => count($matches),
                    'top_similarity' => round($matches[0]->similarity * 100, 1) . '%',
                    'top_book' => $matches[0]->book ?? 'unknown',
                    'top_author' => $matches[0]->book_author ?? 'unknown',
                ]);
            }

            // 5. Build unified LLM prompts
            $allSameAuthor = !empty($matches) && !empty($authorName)
                && count(array_unique(array_map(fn($m) => $m->book_author ?? '', $matches))) === 1
                && ($matches[0]->book_author ?? '') === $authorName;

            $hasLocalContext = !empty($localContext);
            $systemPrompt = $this->buildSystemPrompt($hasSearchTools, $allSameAuthor, $hasLocalContext);
            $userMessage = $this->buildUserMessage(
                $selectedText, $question, $localContext, $matches, $authorName, $bookTitle
            );

            $promptParts = [];
            if (!empty($localContext)) $promptParts[] = count($localContext) . ' surrounding nodes';
            if (!empty($matches)) $promptParts[] = count($matches) . ' source passages';
            $pipelineLog['prompt_summary'] = 'Selected passage + question' . (!empty($promptParts) ? ' + ' . implode(' + ', $promptParts) : '');

            // 6. Call LLM via LlmService (model chosen by user)
            Log::info('AiBrain: calling LLM...', ['tools' => $toolsUsed, 'model' => $brainModel]);
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

            // 7. Parse citations and create hypercites (skip if no external matches)
            $timestamp = now()->timestamp;
            $highlightId = $validated['highlightId'];
            $subBookId = SubBookIdHelper::build($bookId, $highlightId);
            $hypercites = [];
            $processedHtml = $llmResponse;

            if (!empty($matches)) {
                [$processedHtml, $hypercites] = $this->processCitationsInResponse(
                    $llmResponse,
                    $matches,
                    $bookId,
                    $user
                );
            }

            Log::info('AiBrain: citations processed', [
                'tools' => $toolsUsed,
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
                'tools_used' => $toolsUsed,
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
                'tools_used'  => $toolsUsed,
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

    /**
     * Plan which retrieval tools to use via DeepSeek v3 router.
     */
    private function planRetrieval(LlmService $llmService, string $selectedText, string $question, string $bookId): array
    {
        $bookMeta = DB::table('library')->where('book', $bookId)->select('author', 'title', 'year')->first();
        $authorName = $bookMeta->author ?? null;
        $bookTitle = $bookMeta->title ?? 'Unknown';

        $systemPrompt = <<<'PROMPT'
You are a retrieval planner for a scholarly archive. The user selected a passage from a book and asked a question. Choose which retrieval tools to use (1-3 tools):

- "local_context" — surrounding paragraphs from the same book. Use when the question is about understanding/explaining the selected text itself.
- "embedding_search" — semantic search across the library. Use when the question asks about related ideas, themes, or arguments.
- "keyword_search" — keyword search of book content. Use when the question mentions specific names, terms, or concepts that would appear verbatim.
- "library_search" — search book titles/authors. Use when the question asks about a specific book or author.

If using embedding_search, set embedding_scope:
- "same_author" — only books by the same author
- "all_books" — all books in the library

If using keyword_search or library_search, extract search terms into "keywords".

Return ONLY valid JSON:
{"tools": [...], "embedding_scope": "...", "keywords": "...", "reasoning": "..."}
PROMPT;

        $userMessage = "BOOK: \"{$bookTitle}\" by {$authorName}\nPASSAGE (excerpt): "
            . Str::limit($selectedText, 300) . "\nQUESTION: {$question}";

        $result = $llmService->chat($systemPrompt, $userMessage, 0.0, 150,
            'accounts/fireworks/models/deepseek-v3p2', 15, 'none');

        if ($result) {
            $result = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $result);
            $result = trim(preg_replace('/^```(?:json)?\s*|\s*```$/i', '', trim($result)));
            $parsed = json_decode($result, true);

            if (is_array($parsed) && !empty($parsed['tools']) && is_array($parsed['tools'])) {
                // Validate tool names
                $validTools = ['local_context', 'embedding_search', 'keyword_search', 'library_search'];
                $tools = array_values(array_intersect($parsed['tools'], $validTools));

                if (!empty($tools)) {
                    return [
                        'plan' => [
                            'tools' => $tools,
                            'embedding_scope' => $parsed['embedding_scope'] ?? 'all_books',
                            'keywords' => $parsed['keywords'] ?? '',
                            'reasoning' => $parsed['reasoning'] ?? '',
                        ],
                        'author_name' => $authorName,
                        'book_title' => $bookTitle,
                    ];
                }
            }
        }

        Log::warning('AiBrain: router planning failed, using fallback', ['raw' => $result]);
        return [
            'plan' => [
                'tools' => ['local_context', 'embedding_search'],
                'embedding_scope' => 'all_books',
                'keywords' => '',
                'reasoning' => 'fallback — router parse failure',
            ],
            'author_name' => $authorName,
            'book_title' => $bookTitle,
        ];
    }

    /**
     * Build adaptive system prompt based on what retrieval results are available.
     */
    private function buildSystemPrompt(bool $hasExternalSources, bool $allSameAuthor, bool $hasLocalContext = false): string
    {
        if (!$hasExternalSources) {
            // Local context only — no external sources
            return <<<'PROMPT'
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
PROMPT;
        }

        $base = <<<'PROMPT'
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

        if ($hasLocalContext) {
            $base .= "\n\nIMPORTANT — The user message includes PRECEDING CONTEXT and/or FOLLOWING CONTEXT from the same book as the selected passage. First, use this surrounding context to understand and directly answer the question in relation to the passage and the book it comes from. Then, supplement your answer with relevant source passages from the library.";
        }

        if ($allSameAuthor) {
            $base .= "\n- Highlight connections, developments, and continuities across the author's works";
        }

        return $base;
    }

    /**
     * Build unified user message that includes whichever sections are populated.
     */
    private function buildUserMessage(
        string $selectedText,
        string $question,
        array $localContext,
        array $matches,
        ?string $authorName,
        string $bookTitle
    ): string {
        $msg = '';
        $preceding = '';
        $following = '';

        // Local context: split into preceding/following paragraphs
        if (!empty($localContext)) {
            $passedSelected = false;

            foreach ($localContext as $node) {
                $text = $node->plainText ?? '';
                if (empty(trim($text))) continue;

                if ($node->is_selected) {
                    $passedSelected = true;
                    continue;
                }

                if (!$passedSelected) {
                    $preceding .= $text . "\n";
                } else {
                    $following .= $text . "\n";
                }
            }
        }

        if (trim($preceding)) {
            $msg .= "PRECEDING CONTEXT:\n" . trim($preceding) . "\n\n";
        }

        $sourceLabel = $authorName ? " (from \"{$bookTitle}\" by {$authorName})" : '';
        $msg .= "SELECTED PASSAGE{$sourceLabel}:\n{$selectedText}\n\n";

        if (trim($following)) {
            $msg .= "FOLLOWING CONTEXT:\n" . trim($following) . "\n\n";
        }

        $msg .= "QUESTION:\n{$question}";

        // Source passages from search results
        if (!empty($matches)) {
            $msg .= "\n\nSOURCE PASSAGES FROM LIBRARY:\n";
            $msg .= $this->buildPassageContext($matches);
        }

        return $msg;
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

        // Build a lookup: surname -> match data
        $authorLookup = [];
        foreach ($matches as $match) {
            $author = $match->book_author ?? '';
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
                    return $m[0];
                }

                $match = $authorLookup[$key];
                $hyperciteId = 'hypercite_' . Str::random(8);

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

                $linkHref = "/{$match->book}#{$hyperciteId}";
                return '<a href="' . e($linkHref) . '">' . e("{$surname} {$year}") . '<sup class="open-icon">&nearr;</sup></a>';
            },
            $html
        );

        return [$processedHtml, $hypercites];
    }

    private function extractSurname(string $author): ?string
    {
        $author = trim($author);
        if (empty($author)) {
            return null;
        }

        if (str_contains($author, ',')) {
            return trim(explode(',', $author)[0]);
        }

        $parts = preg_split('/\s+/', $author);
        return end($parts) ?: null;
    }

    /**
     * Split the processed HTML response into paragraph nodes and insert into DB.
     */
    private function createResponseNodes(string $html, string $subBookId, int $startLineOffset = 0): array
    {
        $paragraphs = preg_split('/(?<=<\/p>)\s*/', $html);
        $paragraphs = array_filter($paragraphs, fn($p) => trim(strip_tags($p)) !== '');
        $paragraphs = array_values($paragraphs);

        if (empty($paragraphs)) {
            $paragraphs = ['<p>' . $html . '</p>'];
        }

        $nodes = [];
        $chunkId = 0;

        foreach ($paragraphs as $idx => $paragraph) {
            $paragraph = trim($paragraph);
            if (empty($paragraph)) continue;

            $nodeId = (string) Str::uuid();

            if (!str_contains($paragraph, 'data-node-id')) {
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

        // LLM cost (includes router + main model — both tracked by LlmService)
        foreach ($usageStats['by_model'] as $model => $usage) {
            $modelPricing = $pricing[$model] ?? null;
            if ($modelPricing) {
                $inputCost = ($usage['prompt_tokens'] / 1_000_000) * ($modelPricing['input'] ?? 0);
                $outputCost = ($usage['completion_tokens'] / 1_000_000) * ($modelPricing['output'] ?? 0);
                $totalCost += $inputCost + $outputCost;
            }
        }

        // Embedding cost (skipped when no embedding search was used)
        if ($queryText !== null) {
            $embeddingPricing = $pricing['nomic-ai/nomic-embed-text-v1.5'] ?? null;
            if ($embeddingPricing) {
                $embeddingTokens = $embeddingService->estimateTokens($queryText);
                $totalCost += ($embeddingTokens / 1_000_000) * ($embeddingPricing['input'] ?? 0);
            }
        }

        return max($totalCost, 0.0001);
    }

    /**
     * Build the pipeline appendix HTML showing router decision, retrieval tools, and cost.
     */
    private function buildAppendixHtml(array $log): string
    {
        $reasoning = e($log['router_reasoning'] ?? '');
        $cost = number_format($log['cost'] ?? 0, 5);
        $toolsUsed = $log['tools_used'] ?? [];
        $keywords = $log['keywords'] ?? '';

        $scopeLabels = ['public' => 'Public library', 'mine' => 'My books', 'all' => 'Public + my books', 'this' => 'This book only'];

        $html = '<p data-appendix="true"><strong>Appendix</strong></p>';

        // Router decision
        $toolLabels = [
            'local_context' => 'Local context',
            'embedding_search' => 'Embedding search',
            'keyword_search' => 'Keyword search',
            'library_search' => 'Library search',
        ];
        $toolNames = array_map(fn($t) => $toolLabels[$t] ?? $t, $toolsUsed);
        $html .= '<p data-appendix="true"><strong>Router (DeepSeek v3):</strong> '
            . e(implode(' + ', $toolNames))
            . ' — "' . $reasoning . '"</p>';

        $html .= '<p data-appendix="true"><strong>Source scope:</strong> ' . e($scopeLabels[$log['source_scope'] ?? 'public'] ?? 'Public library') . '</p>';

        if (!empty($keywords)) {
            $html .= '<p data-appendix="true"><strong>Keywords:</strong> ' . e($keywords) . '</p>';
        }

        // Per-tool retrieval results
        if (!empty($log['retrieval_log'])) {
            $retrievalLines = implode('<br>', array_map('e', $log['retrieval_log']));
            $html .= '<p data-appendix="true"><strong>Retrieval:</strong><br>' . $retrievalLines . '</p>';
        }

        // Sources consulted
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
}
