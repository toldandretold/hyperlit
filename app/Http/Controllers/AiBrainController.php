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

            // 3. Fetch local context BEFORE router (so router can see it)
            $localContext = $this->retrievalService->executeLocalContext($bookId, $validated['nodeIds']);

            Log::info('AiBrain: local context fetched', ['nodes' => count($localContext)]);

            // 4. Route: answer directly OR plan a search
            $routerResult = $this->planRetrieval($llmService, $selectedText, $question, $bookId, $localContext, $brainModel);
            $authorName = $routerResult['author_name'];
            $bookTitle = $routerResult['book_title'];
            $routerType = $routerResult['type'];

            Log::info('AiBrain: router decided', [
                'type' => $routerType,
                'reasoning' => $routerResult['reasoning'] ?? '',
                'author' => $authorName,
            ]);

            $pipelineLog = [
                'router_model' => basename($brainModel),
                'router_type' => $routerType,
                'router_reasoning' => $routerResult['reasoning'] ?? '',
                'book_title' => $bookTitle,
                'book_author' => $authorName,
                'source_scope' => $sourceScope,
                'context_nodes' => count($localContext),
            ];

            $timestamp = now()->timestamp;
            $highlightId = $validated['highlightId'];
            $subBookId = SubBookIdHelper::build($bookId, $highlightId);
            $hypercites = [];
            $matches = [];
            $toolsUsed = [];
            $queryText = null;

            if ($routerType === 'answer') {
                // === DIRECT ANSWER PATH ===
                $processedHtml = $routerResult['answer'];
                $toolsUsed = ['local_context'];
                $pipelineLog['tools_used'] = $toolsUsed;
                $pipelineLog['prompt_summary'] = 'Router answered directly from context — no library search performed';

                Log::info('AiBrain: direct answer from router', ['html_length' => strlen($processedHtml)]);
            } else {
                // === SEARCH PATH ===
                $plan = $routerResult['plan'];
                $pipelineLog['keywords'] = $plan['keywords'] ?? '';
                $pipelineLog['library_keywords'] = $plan['library_keywords'] ?? '';

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
                $queryText = $result['queryText'];
                $toolsUsed = $result['toolsUsed'];

                // Local context was already fetched, mark it as used
                if (!empty($localContext)) {
                    $toolsUsed[] = 'local_context';
                }

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

                // 7. Parse citations and create hypercites
                $processedHtml = $llmResponse;

                if (!empty($matches)) {
                    [$processedHtml, $hypercites] = $this->processCitationsInResponse(
                        $llmResponse,
                        $matches,
                        $bookId,
                        $subBookId,
                        $user
                    );
                }

                Log::info('AiBrain: citations processed', [
                    'tools' => $toolsUsed,
                    'hypercites_count' => count($hypercites),
                    'html_length' => strlen($processedHtml),
                ]);
            }

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

            // Also update timestamps on each source book that received a hypercite
            if (!empty($hypercites)) {
                $sourceBookIds = array_unique(array_map(fn($h) => $h['book'], $hypercites));
                foreach ($sourceBookIds as $sourceBook) {
                    DB::select('SELECT update_annotations_timestamp(?, ?)', [$sourceBook, $nowMs]);
                }
                Log::info('AiBrain: annotations_updated_at updated', [
                    'parent_book' => $bookId,
                    'source_books' => array_values($sourceBookIds),
                ]);
            } else {
                Log::info('AiBrain: annotations_updated_at updated', ['book' => $bookId]);
            }

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
     * Route the query: either answer directly from context, or plan a search.
     *
     * Returns:
     *   'type' => 'answer' | 'search'
     *   'answer' => string (HTML, only when type=answer)
     *   'plan' => array (keywords/library_keywords/embedding_query, only when type=search)
     *   'author_name' => ?string
     *   'book_title' => string
     *   'reasoning' => string
     */
    private function planRetrieval(
        LlmService $llmService,
        string $selectedText,
        string $question,
        string $bookId,
        array $localContext,
        string $brainModel
    ): array {
        $bookMeta = DB::table('library')->where('book', $bookId)->select('author', 'title', 'year')->first();
        $authorName = $bookMeta->author ?? null;
        $bookTitle = $bookMeta->title ?? 'Unknown';

        $systemPrompt = <<<'PROMPT'
You are an AI Archivist — a scholarly research assistant for the Hyperlit archive.
The user has selected a passage from a book and asked a question about it.
You have the passage, its surrounding context, and the user's question.

OPTION A — If you can fully answer from the provided text and context:
Respond with your answer as HTML paragraphs (<p> tags) wrapped in <answer>...</answer> tags.
Follow these rules:
- Use <em> for emphasis and <blockquote> for longer quotes
- Do NOT include headings (h1-h6)
- Keep your response focused (2-6 paragraphs)

OPTION B — If you need external sources from the library:
Respond with a JSON search plan wrapped in <search>...</search> tags:
{
  "keywords": "specific terms for full-text keyword search across library nodes",
  "library_keywords": "author names or book titles mentioned/implied for library metadata search",
  "embedding_query": "the best sentence to use as a vector embedding for semantic similarity search",
  "reasoning": "brief explanation of what you're looking for"
}

Choose OPTION A when the question is about understanding/explaining the passage itself.
Choose OPTION B when the question asks about related ideas, other authors, or needs supporting sources.
PROMPT;

        // Build user message with surrounding context
        $userMessage = '';
        $preceding = '';
        $following = '';

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
            $userMessage .= "PRECEDING CONTEXT:\n" . trim($preceding) . "\n\n";
        }

        $sourceLabel = $authorName ? " (from \"{$bookTitle}\" by {$authorName})" : '';
        $userMessage .= "SELECTED PASSAGE{$sourceLabel}:\n{$selectedText}\n\n";

        if (trim($following)) {
            $userMessage .= "FOLLOWING CONTEXT:\n" . trim($following) . "\n\n";
        }

        $userMessage .= "QUESTION:\n{$question}";

        $result = $llmService->chat(
            $systemPrompt,
            $userMessage,
            0.3,      // temperature
            4096,     // max tokens (generous — may produce final answer)
            $brainModel,
            180,      // timeout
            null      // reasoning_effort
        );

        $base = [
            'author_name' => $authorName,
            'book_title' => $bookTitle,
        ];

        if ($result) {
            // Strip <think> tags
            $result = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $result);
            if (str_contains($result, '<think>')) {
                $result = preg_replace('/<think>[\s\S]*/i', '', $result);
            }
            $result = trim($result);

            // Check for <answer> tag — direct answer path
            if (preg_match('/<answer>([\s\S]*?)<\/answer>/i', $result, $answerMatch)) {
                return array_merge($base, [
                    'type' => 'answer',
                    'answer' => trim($answerMatch[1]),
                    'reasoning' => 'Answered directly from context',
                ]);
            }

            // Check for <search> tag — search path
            if (preg_match('/<search>([\s\S]*?)<\/search>/i', $result, $searchMatch)) {
                $json = trim($searchMatch[1]);
                $json = trim(preg_replace('/^```(?:json)?\s*|\s*```$/i', '', $json));
                $parsed = json_decode($json, true);

                if (is_array($parsed)) {
                    return array_merge($base, [
                        'type' => 'search',
                        'plan' => [
                            'keywords' => $parsed['keywords'] ?? '',
                            'library_keywords' => $parsed['library_keywords'] ?? '',
                            'embedding_query' => $parsed['embedding_query'] ?? '',
                        ],
                        'reasoning' => $parsed['reasoning'] ?? '',
                    ]);
                }
            }
        }

        // Fallback: treat as search with defaults
        Log::warning('AiBrain: router parse failed, using fallback search', ['raw' => Str::limit($result ?? '', 200)]);
        return array_merge($base, [
            'type' => 'search',
            'plan' => [
                'keywords' => '',
                'library_keywords' => '',
                'embedding_query' => $selectedText . "\n\n" . $question,
            ],
            'reasoning' => 'fallback — router parse failure',
        ]);
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
3. When referencing a source, use the author's name naturally (e.g. "As Smith argues [1]", "Hayek's intervention [3]") — never write "Source [N]"
4. Include actual brief quotes from the source passages where relevant, followed by the citation number
5. When multiple source passages support one claim, cite only the single most relevant one — never stack citations like [1][2][3]. Each [N] should appear at most once in your entire response.
6. Format your response as HTML paragraphs using <p> tags

Rules:
- Only cite sources using the exact [N] reference numbers from the provided passages
- Do not invent citations or reference works not in the provided sources
- Keep your response focused and substantive (3-8 paragraphs)
- Use <em> for emphasis and <blockquote> for longer quotes
- Do NOT include headings (h1-h6) — the response will appear in a sub-book context
- Do NOT wrap the entire response in a container div
- Always refer to source authors by name, not by "Source" — if you must use the word, use lowercase "source"
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

            $context .= "--- Source [{$num}] ({$similarity}% match) ---\n";
            $context .= "Title: {$title}\n";
            $context .= "Author: {$author}\n";
            $context .= "Year: " . ($year ?: '—') . "\n";
            $context .= "Text: {$text}\n\n";
        }

        return $context;
    }

    /**
     * Parse [N] citation patterns in the LLM response and create hypercite records.
     * Returns [processedHtml, hypercitesArray].
     */
    private function processCitationsInResponse(string $html, array $matches, string $bookId, string $subBookId, $user): array
    {
        $hypercites = [];

        $processedHtml = preg_replace_callback(
            '/\[(\d+)\]/',
            function ($m) use (&$hypercites, $matches, $subBookId, $user) {
                $index = (int) $m[1] - 1; // LLM uses 1-indexed, array is 0-indexed

                if ($index < 0 || $index >= count($matches)) {
                    return $m[0];
                }

                $match = $matches[$index];
                $hyperciteId = 'hypercite_' . Str::random(8);

                $plainText = $match->plainText ?? '';
                $hyperciteData = [
                    'book'               => $match->book,
                    'hyperciteId'        => $hyperciteId,
                    'node_id'            => json_encode([$match->node_id]),
                    'charData'           => json_encode([
                        $match->node_id => [
                            'charStart' => 0,
                            'charEnd'   => mb_strlen($plainText),
                        ],
                    ]),
                    'citedIN'            => json_encode(["/{$subBookId}#{$hyperciteId}"]),
                    'hypercitedText'     => Str::limit($plainText, 300),
                    'relationshipStatus' => 'couple',
                    'creator'            => $user->name,
                    'creator_token'      => null,
                    'time_since'         => now()->timestamp,
                    'raw_json'           => json_encode([]),
                ];
                DB::connection('pgsql_admin')->table('hypercites')->insert($hyperciteData);
                Log::info('AiBrain: hypercite inserted', ['hyperciteId' => $hyperciteId, 'book' => $match->book]);

                $hypercites[] = $hyperciteData;

                $linkHref = "/{$match->book}#{$hyperciteId}";
                return '<a id="' . e($hyperciteId) . '" href="' . e($linkHref) . '"><sup class="open-icon">&nearr;</sup></a>';
            },
            $html
        );

        return [$processedHtml, $hypercites];
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
        $routerType = $log['router_type'] ?? 'search';
        $routerModel = e($log['router_model'] ?? 'unknown');

        $scopeLabels = ['public' => 'Public library', 'mine' => 'My books', 'all' => 'Public + my books', 'this' => 'This book only'];

        $html = '<p data-appendix="true"><strong>Appendix</strong></p>';

        // Router decision
        if ($routerType === 'answer') {
            $html .= '<p data-appendix="true"><strong>Router (' . $routerModel . '):</strong> '
                . 'Determined the question could be answered from the selected text and surrounding context. No library search was performed.</p>';
        } else {
            $toolLabels = [
                'local_context' => 'Local context',
                'embedding_search' => 'Embedding search',
                'keyword_search' => 'Keyword search',
                'library_search' => 'Library search',
            ];
            $toolNames = array_map(fn($t) => $toolLabels[$t] ?? $t, $toolsUsed);
            $html .= '<p data-appendix="true"><strong>Router (' . $routerModel . '):</strong> '
                . e(implode(' + ', $toolNames))
                . ' — "' . $reasoning . '"</p>';

            $html .= '<p data-appendix="true"><strong>Source scope:</strong> ' . e($scopeLabels[$log['source_scope'] ?? 'public'] ?? 'Public library') . '</p>';

            $keywords = $log['keywords'] ?? '';
            $libraryKeywords = $log['library_keywords'] ?? '';
            if (!empty($keywords)) {
                $html .= '<p data-appendix="true"><strong>Keywords:</strong> ' . e($keywords) . '</p>';
            }
            if (!empty($libraryKeywords)) {
                $html .= '<p data-appendix="true"><strong>Library keywords:</strong> ' . e($libraryKeywords) . '</p>';
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
        }

        if (!empty($log['context_nodes'])) {
            $html .= '<p data-appendix="true"><strong>Local context:</strong> '
                . (int)$log['context_nodes'] . ' surrounding nodes from the same book.</p>';
        }

        $llmModel = e($log['llm_model'] ?? $log['router_model'] ?? 'unknown');
        $html .= '<p data-appendix="true"><strong>Sent to ' . $llmModel . ':</strong> '
            . e($log['prompt_summary'] ?? 'Selected passage + question') . '</p>';

        $html .= '<p data-appendix="true"><strong>Cost:</strong> $' . $cost . '</p>';

        return $html;
    }
}
