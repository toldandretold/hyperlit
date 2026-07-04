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
use Symfony\Component\HttpFoundation\StreamedResponse;

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

    public function query(Request $request, EmbeddingService $embeddingService, LlmService $llmService, BillingService $billingService): JsonResponse|StreamedResponse
    {
        // Pre-stream checks: auth, billing, validation — return normal JSON errors
        $user = Auth::user();
        if (!$user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }

        $user->refresh();

        if (!$billingService->canProceed($user)) {
            return response()->json(['success' => false, 'message' => 'Insufficient balance'], 402);
        }

        // 🔒 Privacy + scope contract is locked by tests/Feature/AiBrain/AiBrainScopeValidationTest.php
        //   — rejects retired 'all' / 'this' scopes (422)
        //   — rejects shelf scope without shelfId (422), non-uuid shelfId (422)
        //   — rejects shelfId belonging to another user (404)
        // If you change the allowed scopes here, update the tests.
        try {
            $validated = $request->validate([
                'selectedText' => 'required|string|min:5|max:5000',
                'question'     => 'required|string|min:3|max:2000',
                'bookId'       => 'required|string',
                'highlightId'  => 'required|string',
                'nodeIds'      => 'required|array',
                'charData'     => 'required|array',
                'model'        => 'nullable|string|max:100',
                'sourceScope'  => 'nullable|string|in:public,mine,shelf',
                'mode'         => 'nullable|string|in:quick,archivist',
                'shelfId'      => 'nullable|string|uuid',
            ]);
        } catch (\Illuminate\Validation\ValidationException $e) {
            return response()->json([
                'success' => false,
                'message' => 'Validation failed',
                'errors'  => $e->errors(),
            ], 422);
        }

        // E2EE (docs/e2ee.md): the AI brain reads highlighted content server-side —
        // impossible for an encrypted book (server only holds ciphertext).
        if (\App\Services\E2ee\EncryptedBookGuard::isEncrypted($validated['bookId'])) {
            return response()->json(['success' => false, 'message' => 'Encrypted books cannot use the AI brain'], 422);
        }

        // Shelf scope ownership check (cheap pre-flight before opening the stream).
        // Covered by: tests/Feature/AiBrain/AiBrainScopeValidationTest.php
        //   "rejects shelfId belonging to another user with 404"
        if (($validated['sourceScope'] ?? null) === 'shelf') {
            $shelfId = $validated['shelfId'] ?? null;
            if (!$shelfId) {
                return response()->json(['success' => false, 'message' => 'shelfId is required when sourceScope=shelf'], 422);
            }
            $owned = DB::table('shelves')->where('id', $shelfId)->where('creator', $user->name)->exists();
            if (!$owned) {
                return response()->json(['success' => false, 'message' => 'Shelf not found or not yours'], 404);
            }
        }

        // Fireworks AI fallback chain. Verified live 2026-05-27.
        //
        // TODO: when Fireworks credits run out, migrate to DeepInfra:
        //   LLM_BASE_URL=https://api.deepinfra.com/v1/openai
        //   primary: deepseek-ai/DeepSeek-V3.2                  ($0.26 in / $0.38 out per 1M)
        //   fallback: nvidia/NVIDIA-Nemotron-3-Super-120B-A12B  ($0.10/$0.50)
        //   fallback: Qwen/Qwen3.6-35B-A3B                      ($0.15/$0.95)
        // Reasons to switch: ~50% cheaper input + ~75% cheaper output, SOC 2 +
        // ISO 27001, zero-retention (in-memory only), no training-on-prompts.
        $fallbackChain = [
            'accounts/fireworks/models/deepseek-v4-pro',  // primary — DeepSeek V4 Pro
            'accounts/fireworks/models/kimi-k2p6',        // fallback 1 — different family
            'accounts/fireworks/models/gpt-oss-120b',     // fallback 2 — cheap safety net
        ];

        $modelLabels = [
            'accounts/fireworks/models/deepseek-v4-pro' => 'DeepSeek V4 Pro',
            'accounts/fireworks/models/kimi-k2p6'       => 'Kimi K2.6',
            'accounts/fireworks/models/gpt-oss-120b'    => 'GPT-OSS 120B',
        ];

        // Place user-selected model first in the chain (if valid)
        $allowedModels = array_keys($modelLabels);
        $brainModel = in_array($validated['model'] ?? null, $allowedModels)
            ? $validated['model']
            : 'accounts/fireworks/models/deepseek-v4-pro';

        // Reorder fallback chain: user's chosen model first, then the rest
        $fallbackChain = array_values(array_unique(array_merge([$brainModel], $fallbackChain)));

        $modelLabel = $modelLabels[$brainModel] ?? basename($brainModel);

        // Stream the pipeline as SSE events
        return response()->stream(function () use ($validated, $user, $brainModel, $modelLabel, $modelLabels, $fallbackChain, $llmService, $embeddingService, $billingService) {
            $sendEvent = function (string $event, array $data) {
                echo "event: {$event}\ndata: " . json_encode($data) . "\n\n";
                if (ob_get_level()) ob_flush();
                flush();
            };

            try {
                $selectedText = $validated['selectedText'];
                $question = $validated['question'];
                $bookId = $validated['bookId'];
                $sourceScope = $validated['sourceScope'] ?? 'public';
                $shelfId = $validated['shelfId'] ?? null;
                $mode = $validated['mode'] ?? 'archivist';
                $creatorName = $user->name;

                Log::info('AiBrain: query started', [
                    'user' => $user->name,
                    'book' => $bookId,
                    'mode' => $mode,
                    'sourceScope' => $sourceScope,
                    'shelfId' => $shelfId,
                    'question' => Str::limit($question, 100),
                    'selectedText_len' => strlen($selectedText),
                ]);

                if ($mode === 'quick') {
                    $this->runQuickChat(
                        $validated,
                        $user,
                        $brainModel,
                        $modelLabel,
                        $modelLabels,
                        $fallbackChain,
                        $llmService,
                        $billingService,
                        $embeddingService,
                        $sendEvent
                    );
                    return;
                }

                // 3. Fetch local context BEFORE router (so router can see it)
                $sendEvent('status', ['message' => 'Gathering surrounding context...']);
                $localContext = $this->retrievalService->executeLocalContext($bookId, $validated['nodeIds']);

                Log::info('AiBrain: local context fetched', ['nodes' => count($localContext)]);

                // Retry callback — sends SSE status so user sees retry progress
                $onRetry = function (int $attempt, int $maxAttempts, int $status) use ($sendEvent) {
                    $sendEvent('status', ['message' => "Server busy — retrying ({$attempt}/{$maxAttempts})..."]);
                };

                // 4. Route: answer directly OR plan a search
                $sendEvent('status', ['message' => 'Considering passage and question...']);
                $onFallback = function (string $modelName) use ($sendEvent, $modelLabels) {
                    $label = $modelLabels["accounts/fireworks/models/{$modelName}"] ?? $modelName;
                    $sendEvent('status', ['message' => "Primary model unavailable — trying {$label}..."]);
                };
                $routerResult = $this->planRetrieval($llmService, $selectedText, $question, $bookId, $localContext, $fallbackChain, $onRetry, $onFallback);
                $authorName = $routerResult['author_name'];
                $bookTitle = $routerResult['book_title'];
                $routerType = $routerResult['type'];

                Log::info('AiBrain: router decided', [
                    'type' => $routerType,
                    'reasoning' => $routerResult['reasoning'] ?? '',
                    'author' => $authorName,
                ]);

                if ($routerType === 'error') {
                    $sendEvent('error', ['message' => 'The AI model is currently unavailable. Please try again shortly.']);
                    return;
                }

                $sendEvent('status', ['message' => 'Planning library search...']);

                $pipelineLog = [
                    'router_model' => $routerResult['router_model'] ?? 'unknown',
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

                // === SEARCH PATH (the only path in Archivist mode) ===
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
                        'shelfId' => $shelfId,
                        'creatorName' => $creatorName,
                    ];

                    $sendEvent('status', ['message' => 'Searching library for relevant sources...']);

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

                    // Check for matches when search tools were used.
                    // No billing happens past this point — early return skips BillingService::charge below.
                    // Locked by tests/Feature/AiBrain/BillingFailurePathsTest.php:
                    //   "no billing when shelf scope retrieval returns empty matches"
                    $hasSearchTools = !empty(array_intersect($toolsUsed, ['embedding_search', 'keyword_search', 'library_search']));
                    if ($hasSearchTools && empty($matches)) {
                        Log::info('AiBrain: no matches found', ['tools' => $toolsUsed, 'scope' => $sourceScope]);
                        $noMatchMessage = $sourceScope === 'shelf'
                            ? 'No matches in this shelf. Try a different scope or shelf.'
                            : 'No relevant passages found in the library.';
                        $sendEvent('error', ['message' => $noMatchMessage]);
                        return;
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
                    if (!empty($matches)) {
                        $sendEvent('status', ['message' => 'Found ' . count($matches) . ' relevant sources — sending to ' . $modelLabel . '...']);
                    }

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

                    // 6. Call LLM via LlmService with fallback chain
                    Log::info('AiBrain: calling LLM...', ['tools' => $toolsUsed, 'model' => $brainModel]);
                    $llmResult = $llmService->chatWithFallback(
                        $systemPrompt,
                        $userMessage,
                        0.3,      // temperature
                        8192,     // max tokens — bumped from 4096 because V4 Pro reasoning
                                  // can eat into the budget and truncate the visible answer
                                  // mid-sentence. 8192 gives comfortable headroom.
                        $fallbackChain,
                        180,      // timeout
                        'low',    // reasoning_effort — bounded thinking so we keep tokens
                                  // for the visible response with citations
                        $onRetry,
                        $onFallback
                    );

                    if (!$llmResult) {
                        Log::warning('AiBrain: LLM — all models failed');
                        $sendEvent('error', ['message' => 'The AI model failed to respond. Please try again.']);
                        return;
                    }

                    $llmResponse = $llmResult['content'];
                    // Update model tracking so appendix shows the model that actually responded
                    $brainModel = $llmResult['model'];
                    $modelLabel = $modelLabels[$brainModel] ?? basename($brainModel);

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

                // 12. Send final result
                $sendEvent('result', [
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
                    'hyperlight'  => array_merge($hyperlightData, [
                        'node_id'       => $validated['nodeIds'],
                        'charData'      => $validated['charData'],
                        'preview_nodes' => $previewNodes,
                        'raw_json'      => ['brain_query' => true, 'question' => Str::limit($question, 1000)],
                    ]),
                    'hypercites'  => $hypercites,
                    'tools_used'  => $toolsUsed,
                ]);

            } catch (\Exception $e) {
                Log::error('AiBrainController::query - exception', [
                    'error' => $e->getMessage(),
                    'trace' => $e->getTraceAsString(),
                ]);

                $sendEvent('error', ['message' => 'AI query failed']);
            }
        }, 200, [
            'Content-Type'      => 'text/event-stream',
            'Cache-Control'     => 'no-cache',
            'X-Accel-Buffering' => 'no',
            'Connection'        => 'keep-alive',
        ]);
    }

    /**
     * Quick Chat path — one LLM call, no router, no retrieval, no hypercites.
     * Emits the same SSE result shape as the archivist path so the frontend doesn't
     * need to branch on the response side.
     */
    private function runQuickChat(
        array $validated,
        $user,
        string $brainModel,
        string $modelLabel,
        array $modelLabels,
        array $fallbackChain,
        LlmService $llmService,
        BillingService $billingService,
        EmbeddingService $embeddingService,
        \Closure $sendEvent
    ): void {
        $selectedText = $validated['selectedText'];
        $question = $validated['question'];
        $bookId = $validated['bookId'];
        $highlightId = $validated['highlightId'];
        $subBookId = SubBookIdHelper::build($bookId, $highlightId);
        $timestamp = now()->timestamp;

        $sendEvent('status', ['message' => 'Sending to ' . $modelLabel . '...']);

        $systemPrompt = <<<'PROMPT'
You are a helpful reading assistant. The user is reading a book and has
selected a passage and asked a question about it.

Use the selected passage as context for what they're reading. Answer their
question helpfully, drawing on your general knowledge where useful — e.g.
explaining a word, comparing to other ideas, suggesting related authors,
or giving background the passage assumes.

Rules:
- Format as HTML paragraphs using <p> tags. Use <em> for emphasis and
  <blockquote> for quoting back text.
- No headings (h1-h6) and no wrapping container div.
- Be honest about what the passage says vs. what is your wider knowledge.
- Don't fabricate citations or quotes that aren't there.
- Keep responses focused — usually 1-4 paragraphs.
PROMPT;
        $userMessage = "SELECTED PASSAGE:\n{$selectedText}\n\nQUESTION:\n{$question}";

        $onRetry = function (int $attempt, int $maxAttempts, int $status) use ($sendEvent) {
            $sendEvent('status', ['message' => "Server busy — retrying ({$attempt}/{$maxAttempts})..."]);
        };
        $onFallback = function (string $modelName) use ($sendEvent, $modelLabels) {
            $label = $modelLabels["accounts/fireworks/models/{$modelName}"] ?? $modelName;
            $sendEvent('status', ['message' => "Primary model unavailable — trying {$label}..."]);
        };

        // 'low' reasoning_effort so V4 Pro doesn't burn the budget on thinking and
        // truncate the visible Quick Chat reply mid-sentence.
        $llmResult = $llmService->chatWithFallback(
            $systemPrompt, $userMessage, 0.3, 4096, $fallbackChain, 180, 'low', $onRetry, $onFallback
        );

        if (!$llmResult) {
            Log::warning('AiBrain (quick): LLM — all models failed');
            $sendEvent('error', ['message' => 'The AI model failed to respond. Please try again.']);
            return;
        }

        $llmResponse = $llmResult['content'];
        $brainModel = $llmResult['model'];

        // Strip <think> tags
        $llmResponse = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $llmResponse);
        if (str_contains($llmResponse, '<think>')) {
            $llmResponse = preg_replace('/<think>[\s\S]*/i', '', $llmResponse);
        }
        $processedHtml = trim($llmResponse);

        // Library upsert
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

        // Clear existing nodes for this sub-book (synced from highlight creation) and render
        DB::connection('pgsql_admin')->table('nodes')->where('book', $subBookId)->delete();

        $questionNode = '<p><b>Prompt</b>: "' . e(Str::limit($question, 1000)) . '"</p>';
        $aiLabel = '<p><b>Quick Chat</b>:</p>';
        $conversationHtml = $questionNode . $aiLabel . $processedHtml;
        $nodes = $this->createResponseNodes($conversationHtml, $subBookId);

        // Minimal appendix: model + cost only
        $usageStats = $llmService->getUsageStats();
        $totalCost = $this->calculateCost($usageStats, $embeddingService, null);
        $appendixHtml = '<p data-appendix="true"><strong>Sent to ' . e(basename($brainModel))
            . '</strong> — <strong>Cost:</strong> $' . number_format($totalCost, 5) . '</p>';
        $appendixNodes = $this->createResponseNodes($appendixHtml, $subBookId, count($nodes));
        $nodes = array_merge($nodes, $appendixNodes);

        $previewNodes = array_map(fn($n) => [
            'book'      => $n['book'],
            'chunk_id'  => $n['chunk_id'],
            'startLine' => $n['startLine'],
            'node_id'   => $n['node_id'],
            'content'   => $n['content'],
            'plainText' => $n['plainText'],
        ], array_slice($nodes, 0, 5));

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
            'raw_json'        => json_encode(['brain_query' => true, 'mode' => 'quick', 'question' => Str::limit($question, 1000)]),
            'hidden'          => false,
        ];
        DB::connection('pgsql_admin')->table('hyperlights')->updateOrInsert(
            ['book' => $bookId, 'hyperlight_id' => $highlightId],
            $hyperlightData
        );

        $nowMs = round(microtime(true) * 1000);
        DB::select('SELECT update_annotations_timestamp(?, ?)', [$bookId, $nowMs]);

        $billingService->charge(
            $user,
            $totalCost,
            'AI Quick Chat: ' . Str::limit($question, 60),
            'ai_brain',
            [],
            ['book_id' => $bookId, 'highlight_id' => $highlightId]
        );

        Log::info('AiBrain (quick): complete', [
            'highlightId' => $highlightId,
            'subBookId' => $subBookId,
            'nodes_count' => count($nodes),
            'cost' => $totalCost,
        ]);

        $sendEvent('result', [
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
            'hyperlight' => array_merge($hyperlightData, [
                'node_id'       => $validated['nodeIds'],
                'charData'      => $validated['charData'],
                'preview_nodes' => $previewNodes,
                'raw_json'      => ['brain_query' => true, 'mode' => 'quick', 'question' => Str::limit($question, 1000)],
            ]),
            'hypercites'  => [],
            'tools_used'  => ['quick_chat'],
        ]);
    }

    /**
     * Extract a search plan from the user's selection + question.
     *
     * One LLM call that rewrites the question into good search terms — keywords,
     * library keywords (author/title hints), and an embedding query. The previous
     * "answer directly from context" auto path is gone: in Archivist mode the
     * user has explicitly asked for library sources, so we always retrieve.
     * Quick Chat skips this whole flow upstream.
     *
     * Returns:
     *   'type' => 'search' (always; 'error' on total LLM failure)
     *   'plan' => array (keywords/library_keywords/embedding_query)
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
        array $fallbackChain,
        ?\Closure $onRetry = null,
        ?\Closure $onFallback = null
    ): array {
        $bookMeta = DB::table('library')->where('book', $bookId)->select('author', 'title', 'year')->first();
        $authorName = $bookMeta->author ?? null;
        $bookTitle = $bookMeta->title ?? 'Unknown';

        $systemPrompt = <<<'PROMPT'
You are an AI Archivist — a scholarly research assistant for the Hyperlit archive.
The user has selected a passage from a book and asked a question about it.
Your job is to rewrite their question into a search plan for finding supporting
sources in the library.

Respond with a JSON search plan wrapped in <search>...</search> tags:
{
  "keywords": "3-5 distinctive terms for full-text search (terms are OR'd — each should be specific enough to find relevant passages on its own, e.g. 'counterfactual NIEO dependency' not a long list)",
  "library_keywords": "author names or book titles mentioned/implied for library metadata search",
  "embedding_query": "the best sentence to use as a vector embedding for semantic similarity search",
  "reasoning": "brief explanation of what you're looking for"
}

Always produce a search plan. Do NOT try to answer the question yourself —
that happens downstream once we have the source passages.
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

        $llmResult = $llmService->chatWithFallback(
            $systemPrompt,
            $userMessage,
            0.3,      // temperature
            4096,     // max tokens — router just outputs a short JSON plan
            $fallbackChain,
            180,      // timeout
            'low',    // reasoning_effort — light thinking is fine for keyword extraction;
                      // prevents the response from being truncated by deep reasoning
            $onRetry,
            function (string $modelName) use ($onFallback) {
                if ($onFallback) {
                    $onFallback($modelName);
                }
            }
        );

        $base = [
            'author_name' => $authorName,
            'book_title' => $bookTitle,
            'router_model' => $llmResult ? basename($llmResult['model']) : 'unavailable',
        ];

        if (!$llmResult) {
            Log::warning('AiBrain: router — all models unavailable, aborting pipeline');
            return array_merge($base, [
                'type' => 'error',
                'reasoning' => 'LLM service unavailable',
            ]);
        }

        $result = $llmResult['content'];

        // Strip <think> tags
        $result = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $result);
        if (str_contains($result, '<think>')) {
            $result = preg_replace('/<think>[\s\S]*/i', '', $result);
        }
        $result = trim($result);

        // Search plan path
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

        // LLM returned something but it couldn't be parsed — use embedding fallback
        Log::warning('AiBrain: router parse failed, using fallback search', ['raw' => Str::limit($result, 200)]);
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

        // Strip hallucinated citation markup the LLM sometimes copies into its output
        $html = preg_replace('/<sup[^>]*class=["\']open-icon["\'][^>]*>.*?<\/sup>/i', '', $html);
        $html = preg_replace('/\x{2197}|&nearr;/u', '', $html);

        // Deduplicate consecutive identical citations: [1][1][1] → [1]
        $html = preg_replace('/(\[\d+\])(?:\s*\1)+/', '$1', $html);

        // Extract quoted text near each citation for smart charData
        $quotedTextMap = $this->extractQuotesNearCitations($html, $matches);

        // Track seen citations globally so non-consecutive dupes are also removed
        $seenCitations = [];

        $processedHtml = preg_replace_callback(
            '/\[(\d+)\]/',
            function ($m) use (&$hypercites, &$seenCitations, $matches, $subBookId, $user, $quotedTextMap) {
                $citationNum = (int) $m[1];
                $index = $citationNum - 1; // LLM uses 1-indexed, array is 0-indexed

                if ($index < 0 || $index >= count($matches)) {
                    return $m[0];
                }

                // Global dedup: first occurrence wins, subsequent ones are burned
                if (isset($seenCitations[$citationNum])) {
                    return '';
                }
                $seenCitations[$citationNum] = true;

                $match = $matches[$index];
                $hyperciteId = 'hypercite_' . Str::random(8);

                $plainText = $match->plainText ?? '';

                // Smart charData: use quoted text range if available, else full node
                $charStart = 0;
                $charEnd = mb_strlen($plainText);
                $hypercitedText = Str::limit($plainText, 300);

                if (isset($quotedTextMap[$citationNum]) && $plainText !== '') {
                    $quoteInfo = $quotedTextMap[$citationNum];
                    $quoted = $quoteInfo['text'];

                    // Tokenize LLM surrounding context into words (skip short words)
                    $llmContext = $quoteInfo['contextBefore'] . ' ' . $quoteInfo['contextAfter'];
                    $llmWords = array_unique(array_filter(
                        preg_split('/\W+/u', mb_strtolower($llmContext)),
                        fn($w) => mb_strlen($w) > 3
                    ));

                    // Find ALL occurrences in source and pick best by context overlap
                    $bestPos = null;
                    $bestScore = -1;
                    $searchStart = 0;
                    while (($pos = mb_strpos($plainText, $quoted, $searchStart)) !== false) {
                        $srcBefore = mb_substr($plainText, max(0, $pos - 80), min($pos, 80));
                        $srcAfter = mb_substr($plainText, $pos + mb_strlen($quoted), 80);
                        $srcWords = array_unique(array_filter(
                            preg_split('/\W+/u', mb_strtolower($srcBefore . ' ' . $srcAfter)),
                            fn($w) => mb_strlen($w) > 3
                        ));

                        $score = count(array_intersect($srcWords, $llmWords));
                        if ($score > $bestScore) {
                            $bestScore = $score;
                            $bestPos = $pos;
                        }
                        $searchStart = $pos + 1;
                    }

                    if ($bestPos !== null) {
                        $charStart = $bestPos;
                        $charEnd = $bestPos + mb_strlen($quoted);
                        $hypercitedText = Str::limit($quoted, 300);
                    }
                }

                $hyperciteData = [
                    'book'               => $match->book,
                    'hyperciteId'        => $hyperciteId,
                    'node_id'            => json_encode([$match->node_id]),
                    'charData'           => json_encode([
                        $match->node_id => [
                            'charStart' => $charStart,
                            'charEnd'   => $charEnd,
                        ],
                    ]),
                    'citedIN'            => json_encode(["/{$subBookId}#{$hyperciteId}"]),
                    'hypercitedText'     => $hypercitedText,
                    'relationshipStatus' => 'couple',
                    'creator'            => 'AIarchivist',
                    'access_granted'     => json_encode([$user->name => 'co-author']),
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
     * Find quoted text near each [N] citation in the LLM output.
     * Returns a map: citation_number => quoted_string (verified to exist in source plainText).
     */
    private function extractQuotesNearCitations(string $html, array $matches): array
    {
        $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');

        // Find all [N] positions in the plain text
        $citationPositions = [];
        if (preg_match_all('/\[(\d+)\]/', $text, $cMatches, PREG_OFFSET_CAPTURE)) {
            foreach ($cMatches[0] as $i => $fullMatch) {
                $num = (int) $cMatches[1][$i][0];
                // Use mb-safe offset: convert byte offset to character offset
                $byteOffset = $fullMatch[1];
                $charOffset = mb_strlen(substr($text, 0, $byteOffset));
                $citationPositions[] = ['num' => $num, 'pos' => $charOffset];
            }
        }

        // Find all quoted strings (straight or curly quotes, min 30 chars)
        $quotes = [];
        if (preg_match_all('/["\x{201C}](.{30,}?)["\x{201D}]/u', $text, $qMatches, PREG_OFFSET_CAPTURE)) {
            foreach ($qMatches[1] as $qMatch) {
                $byteOffset = $qMatch[1];
                $charOffset = mb_strlen(substr($text, 0, $byteOffset));
                $quoteText = $qMatch[0];
                $quotes[] = ['text' => $quoteText, 'pos' => $charOffset, 'len' => mb_strlen($quoteText)];
            }
        }

        if (empty($quotes)) {
            return [];
        }

        $map = [];
        foreach ($citationPositions as $citation) {
            $num = $citation['num'];
            $cPos = $citation['pos'];

            // Skip if already mapped (first occurrence wins)
            if (isset($map[$num])) {
                continue;
            }

            $index = $num - 1;
            if ($index < 0 || $index >= count($matches)) {
                continue;
            }

            $sourcePlainText = $matches[$index]->plainText ?? '';
            if ($sourcePlainText === '') {
                continue;
            }

            // Find the nearest quote within ~150 chars of the citation
            $bestQuote = null;
            $bestDist = PHP_INT_MAX;
            foreach ($quotes as $q) {
                // Distance from end of quote to citation, or citation to start of quote
                $quoteEnd = $q['pos'] + $q['len'];
                $dist = min(abs($cPos - $quoteEnd), abs($q['pos'] - $cPos));
                if ($dist < $bestDist && $dist <= 150) {
                    $bestDist = $dist;
                    $bestQuote = $q['text'];
                }
            }

            // Verify quote exists in the source passage, and capture LLM context
            if ($bestQuote !== null && mb_strpos($sourcePlainText, $bestQuote) !== false) {
                // Grab ~80 chars of LLM text before/after the quote for disambiguation
                $bestQuotePos = null;
                foreach ($quotes as $q) {
                    if ($q['text'] === $bestQuote) {
                        $bestQuotePos = $q['pos'];
                        break;
                    }
                }
                $contextBefore = $bestQuotePos !== null
                    ? mb_substr($text, max(0, $bestQuotePos - 80), min($bestQuotePos, 80))
                    : '';
                $contextAfter = $bestQuotePos !== null
                    ? mb_substr($text, $bestQuotePos + mb_strlen($bestQuote), 80)
                    : '';

                $map[$num] = [
                    'text' => $bestQuote,
                    'contextBefore' => $contextBefore,
                    'contextAfter' => $contextAfter,
                ];
            }
        }

        return $map;
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
        $routerModel = e($log['router_model'] ?? 'unknown');

        $scopeLabels = ['public' => 'Public library', 'mine' => 'My public books', 'shelf' => 'Shelf'];

        $html = '<p data-appendix="true"><strong>Appendix</strong></p>';

        $toolLabels = [
            'local_context'    => 'Local context',
            'embedding_search' => 'Embedding search',
            'keyword_search'   => 'Keyword search',
            'library_search'   => 'Library search',
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

        if (!empty($log['retrieval_log'])) {
            $retrievalLines = implode('<br>', array_map('e', $log['retrieval_log']));
            $html .= '<p data-appendix="true"><strong>Retrieval:</strong><br>' . $retrievalLines . '</p>';
        }

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

        $llmModel = e($log['llm_model'] ?? $log['router_model'] ?? 'unknown');
        $html .= '<p data-appendix="true"><strong>Sent to ' . $llmModel . ':</strong> '
            . e($log['prompt_summary'] ?? 'Selected passage + question') . '</p>';

        $html .= '<p data-appendix="true"><strong>Cost:</strong> $' . $cost . '</p>';

        return $html;
    }
}
