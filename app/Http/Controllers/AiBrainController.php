<?php

namespace App\Http\Controllers;

use App\Helpers\SubBookIdHelper;
use App\Services\BillingService;
use App\Services\EmbeddingService;
use App\Services\Llm\ClientInferenceUnavailableException;
use App\Services\Llm\ClientTicketTransport;
use App\Services\LlmService;
use App\Services\RetrievalService;
use App\Services\Security\NodeHtmlSanitizer;
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
        private \App\Services\AiBrain\ReadingContextFormatter $readingContext,
    ) {}

    /**
     * Resolve the ROOT book's citation metadata (title/author/year) for any book id.
     * A selection may live in a sub-book (`foundation/…`) whose `library` row has no
     * author — so we resolve the foundation and read ITS metadata instead.
     */
    private function resolveRootBookMeta(string $bookId): array
    {
        $root = \App\Helpers\SubBookIdHelper::parse($bookId)['foundation'] ?? $bookId;
        $meta = DB::table('library')->where('book', $root)->select('title', 'author', 'year')->first();
        return [
            'title'  => $meta->title ?? 'Unknown',
            'author' => $meta->author ?? null,
            'year'   => $meta->year ?? null,
        ];
    }

    /**
     * Text of a node for the LLM. Prefers a MATH-AWARE render of its HTML content:
     * math is stored as EMPTY `<latex data-math="<base64 LaTeX>">` elements (KaTeX
     * renders them in the browser), so a plain `plainText`/strip_tags silently DROPS
     * every equation — "16 to 511" would reach the model as "  to  ". This inlines the
     * decoded LaTeX as `$…$` / `$$…$$` (which LLMs read natively). Falls back to plainText.
     */
    private function nodeText($node): string
    {
        $content = is_object($node) ? ($node->content ?? null) : null;
        if (is_string($content) && $content !== '') {
            $t = $this->mathAwareText($content);
            if ($t !== '') return $t;
        }
        return is_object($node) ? ($node->plainText ?? '') : '';
    }

    private function mathAwareText(string $html): string
    {
        $decode = fn(string $b64): string => (($tex = base64_decode($b64, true)) === false ? '' : trim($tex));
        $html = preg_replace_callback(
            '/<latex-block\b[^>]*\bdata-math="([^"]*)"[^>]*>.*?<\/latex-block>/is',
            fn($m) => ' $$' . $decode($m[1]) . '$$ ',
            $html
        );
        $html = preg_replace_callback(
            '/<latex\b[^>]*\bdata-math="([^"]*)"[^>]*>.*?<\/latex>/is',
            fn($m) => ' $' . $decode($m[1]) . '$ ',
            $html
        );
        $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return trim(preg_replace('/[ \t]+/', ' ', $text));
    }

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

        // BYO-key mode: the client executes the LLM calls with the user's own
        // key (via inference tickets), so no balance is needed and no charge is
        // made. Server-side costs (embeddings, pennies) are waived + logged.
        $clientInference = $request->boolean('client_inference');

        if (!$clientInference && !$billingService->canProceed($user)) {
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
                'client_inference' => 'nullable|boolean',

                // Optional selection framing (nesting chain + in-selection links) — see
                // App\Services\AiBrain\ReadingContextFormatter. Bounded so it can't blow the
                // token budget or inject huge strings; nullable so old clients still work.
                'selectionContext'                         => 'nullable|array',
                'selectionContext.chain'                   => 'nullable|array|max:5',
                'selectionContext.chain.*.type'            => 'required_with:selectionContext.chain|string|in:footnote,highlight,ai-response',
                'selectionContext.chain.*.creator'         => 'nullable|string|max:100',
                'selectionContext.chain.*.isAi'            => 'nullable|boolean',
                'selectionContext.chain.*.label'           => 'nullable|string|max:200',
                'selectionContext.chain.*.itemId'          => 'nullable|string|max:255',
                'selectionContext.chain.*.subBookId'       => 'nullable|string|max:255',
                'selectionContext.chainTruncated'          => 'nullable|boolean',
                'selectionContext.immediateContainer'      => 'nullable|array',
                'selectionContext.citations'               => 'nullable|array|max:8',
                'selectionContext.citations.*.referenceId' => 'required_with:selectionContext.citations|string|max:100',
                'selectionContext.citations.*.content'     => 'nullable|string|max:600',
                'selectionContext.citations.*.title'       => 'nullable|string|max:300',
                'selectionContext.citations.*.author'      => 'nullable|string|max:200',
                'selectionContext.citations.*.year'        => 'nullable|string|max:20',
                'selectionContext.hypercites'              => 'nullable|array|max:8',
                'selectionContext.hypercites.*.hyperciteId'     => 'required_with:selectionContext.hypercites|string|max:100',
                'selectionContext.hypercites.*.targetBook'      => 'required_with:selectionContext.hypercites|string|max:255',
                'selectionContext.hypercites.*.hypercitedText'  => 'nullable|string|max:1000',
                'selectionContext.hypercites.*.targetBookTitle' => 'nullable|string|max:300',
                'selectionContext.hypercites.*.targetBookAuthor'=> 'nullable|string|max:200',
                'selectionContext.hypercites.*.visibility'      => 'nullable|string|in:public,restricted',
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

        [$fallbackChain, $brainModel, $modelLabel, $modelLabels] = $this->resolveModelChain($validated['model'] ?? null);

        // Stream the pipeline as SSE events
        return response()->stream(function () use ($validated, $user, $brainModel, $modelLabel, $modelLabels, $fallbackChain, $llmService, $embeddingService, $billingService, $clientInference) {
            $sendEvent = function (string $event, array $data) {
                echo "event: {$event}\ndata: " . json_encode($data) . "\n\n";
                if (ob_get_level()) ob_flush();
                flush();
            };

            // BYO-key mode: every LLM call inside this request parks an inference
            // ticket; the open SSE stream is the delivery channel (the client
            // executes the prompt with its own key and posts the completion back
            // to /api/inference/{id}/complete while we poll the ticket row).
            if ($clientInference) {
                $llmService->setTransport(new ClientTicketTransport(
                    $user->name,
                    'ai_brain',
                    $validated['highlightId'],
                    onTicketCreated: function ($ticket) use ($sendEvent) {
                        $sendEvent('inference_request', [
                            'ticket_id' => $ticket->id,
                            'request' => $ticket->request,
                        ]);
                    },
                    onWait: function () {
                        // SSE comment heartbeat — keeps proxies from killing the
                        // idle stream while we wait on the client's answer.
                        echo ": heartbeat\n\n";
                        if (ob_get_level()) ob_flush();
                        flush();
                    },
                ));
            }

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
                        $sendEvent,
                        $clientInference
                    );
                    return;
                }

                // 3. Fetch local context BEFORE router (so router can see it)
                $sendEvent('status', ['message' => 'Reading your selection']);
                $sendEvent('status', ['message' => 'Gathering surrounding context...']);
                $localContext = $this->retrievalService->executeLocalContext($bookId, $validated['nodeIds']);

                $sc = $validated['selectionContext'] ?? null;
                if (!empty($sc['citations'])) {
                    $sendEvent('status', ['message' => 'Extracting citation details from your selection']);
                }
                if (!empty($sc['hypercites'])) {
                    $sendEvent('status', ['message' => 'Following the hypercite links in your selection']);
                }

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
                    $readingContext = $this->readingContext->build(
                        $validated['selectionContext'] ?? null,
                        $this->resolveRootBookMeta($bookId),
                        $user
                    );
                    $userMessage = $this->buildUserMessage(
                        $selectedText, $question, $localContext, $matches, $authorName, $bookTitle, $readingContext
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

                    // Sanitize before this HTML is written into nodes: an LLM
                    // completion is untrusted markup — doubly so under BYO where
                    // the "model" is whatever the client posted back.
                    $llmResponse = NodeHtmlSanitizer::clean($llmResponse) ?? '';

                    // 7. Parse citations and create hypercites
                    $processedHtml = $llmResponse;

                    if (!empty($matches)) {
                        $sendEvent('status', ['message' => 'Linking sources into your answer']);
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
                $sendEvent('status', ['message' => 'Saving to your library']);
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

                // 11. Bill user (cost already calculated in step 9b). BYO mode:
                // the LLM ran on the user's own key — waive the residual
                // server-side cost (embeddings, fractions of a cent) and log it.
                if ($clientInference) {
                    Log::info('AiBrain: BYO client inference — charge waived', ['residual_cost' => $totalCost]);
                } else {
                    $billingService->charge(
                        $user,
                        $totalCost,
                        'AI Brain: ' . Str::limit($question, 60),
                        'ai_brain',
                        [],
                        ['book_id' => $bookId, 'highlight_id' => $highlightId]
                    );
                }

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

            } catch (ClientInferenceUnavailableException $e) {
                Log::warning('AiBrainController::query - client inference unavailable', [
                    'error' => $e->getMessage(),
                ]);
                $sendEvent('error', ['message' => 'Your AI provider did not answer in time. Check your provider settings (⌘,) and try again.']);
            } catch (\Exception $e) {
                Log::error('AiBrainController::query - exception', [
                    'error' => $e->getMessage(),
                    'trace' => $e->getTraceAsString(),
                ]);

                $sendEvent('error', ['message' => 'AI query failed']);
            } finally {
                // LlmService is a singleton — a lingering transport would ticketise
                // the next request's calls (see LlmService::setTransport).
                $llmService->clearTransport();
            }
        }, 200, [
            'Content-Type'      => 'text/event-stream',
            'Cache-Control'     => 'no-cache',
            'X-Accel-Buffering' => 'no',
            'Connection'        => 'keep-alive',
        ]);
    }

    /**
     * Selection-free AI Archivist — the hero-page entry point (home, /j/, /a/).
     *
     * Same pipeline as query()'s archivist path minus everything selection-bound:
     * no local context, no hyperlight, no sub-book. The answer is written as a
     * PRIVATE standalone book owned by the asker and appended to their
     * "AI Archivist" shelf (find-or-create). Scope is derived, not chosen:
     * shelfId present ⇒ that PUBLIC shelf's corpus (any public shelf — the
     * deliberate inverse of query()'s owner-only shelf gate, because the hero
     * pages scope to journal/archive shelves the visitor does not own),
     * absent ⇒ the whole public library.
     *
     * 🔒 Contract locked by tests/Feature/AiBrain/AskScopeValidationTest.php,
     * AskStandaloneBookTest.php and AskBillingFailureTest.php.
     */
    public function ask(Request $request, EmbeddingService $embeddingService, LlmService $llmService, BillingService $billingService): JsonResponse|StreamedResponse
    {
        $user = Auth::user();
        if (!$user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }

        $user->refresh();

        $clientInference = $request->boolean('client_inference');

        if (!$clientInference && !$billingService->canProceed($user)) {
            return response()->json(['success' => false, 'message' => 'Insufficient balance'], 402);
        }

        try {
            $validated = $request->validate([
                'question'         => 'required|string|min:3|max:2000',
                'shelfId'          => 'nullable|string|uuid',
                'model'            => 'nullable|string|max:100',
                'client_inference' => 'nullable|boolean',
            ]);
        } catch (\Illuminate\Validation\ValidationException $e) {
            return response()->json([
                'success' => false,
                'message' => 'Validation failed',
                'errors'  => $e->errors(),
            ], 422);
        }

        $shelfId = $validated['shelfId'] ?? null;
        $shelfName = null;

        // PUBLIC-shelf gate. Mirrors ShelfController::publicSearch: read via
        // pgsql_admin because the shelves RLS select policy is owner-only, which
        // would make "public shelf" and "no shelf" indistinguishable here.
        // Private shelves 404 even for their owner — personal-shelf asks belong
        // to the in-reader flow (query()'s scope picker).
        if ($shelfId) {
            $shelf = DB::connection('pgsql_admin')->table('shelves')
                ->where('id', $shelfId)
                ->where('visibility', 'public')
                ->first(['name']);
            if (!$shelf) {
                return response()->json(['success' => false, 'message' => 'Shelf not found'], 404);
            }
            $shelfName = $shelf->name;
        }

        [$fallbackChain, $brainModel, $modelLabel, $modelLabels] = $this->resolveModelChain($validated['model'] ?? null);

        return response()->stream(function () use ($validated, $user, $brainModel, $modelLabel, $modelLabels, $fallbackChain, $llmService, $embeddingService, $billingService, $clientInference, $shelfId, $shelfName) {
            $sendEvent = function (string $event, array $data) {
                echo "event: {$event}\ndata: " . json_encode($data) . "\n\n";
                if (ob_get_level()) ob_flush();
                flush();
            };

            if ($clientInference) {
                $llmService->setTransport(new ClientTicketTransport(
                    $user->name,
                    'ai_brain',
                    null, // no highlight anchor for a standalone ask
                    onTicketCreated: function ($ticket) use ($sendEvent) {
                        $sendEvent('inference_request', [
                            'ticket_id' => $ticket->id,
                            'request' => $ticket->request,
                        ]);
                    },
                    onWait: function () {
                        echo ": heartbeat\n\n";
                        if (ob_get_level()) ob_flush();
                        flush();
                    },
                ));
            }

            try {
                $question = $validated['question'];
                $sourceScope = $shelfId ? 'shelf' : 'public';

                Log::info('AiBrain: ask started', [
                    'user' => $user->name,
                    'sourceScope' => $sourceScope,
                    'shelfId' => $shelfId,
                    'question' => Str::limit($question, 100),
                ]);

                $onRetry = function (int $attempt, int $maxAttempts, int $status) use ($sendEvent) {
                    $sendEvent('status', ['message' => "Server busy — retrying ({$attempt}/{$maxAttempts})..."]);
                };
                $onFallback = function (string $modelName) use ($sendEvent, $modelLabels) {
                    $label = $modelLabels["accounts/fireworks/models/{$modelName}"] ?? $modelName;
                    $sendEvent('status', ['message' => "Primary model unavailable — trying {$label}..."]);
                };

                $sendEvent('status', ['message' => 'Considering your question...']);
                $routerResult = $this->planStandaloneRetrieval($llmService, $question, $shelfName, $fallbackChain, $onRetry, $onFallback);

                if ($routerResult['type'] === 'error') {
                    $sendEvent('error', ['message' => 'The AI model is currently unavailable. Please try again shortly.']);
                    return;
                }

                $sendEvent('status', ['message' => 'Planning library search...']);

                $pipelineLog = [
                    'router_model' => $routerResult['router_model'] ?? 'unknown',
                    'router_reasoning' => $routerResult['reasoning'] ?? '',
                    'source_scope' => $sourceScope,
                    'context_nodes' => 0,
                ];

                $plan = $routerResult['plan'];
                $pipelineLog['keywords'] = $plan['keywords'] ?? '';
                $pipelineLog['library_keywords'] = $plan['library_keywords'] ?? '';

                $context = [
                    'bookId' => null,
                    'nodeIds' => [],
                    'selectedText' => '',
                    'question' => $question,
                    'authorName' => null,
                    'bookTitle' => null,
                    'sourceScope' => $sourceScope,
                    'shelfId' => $shelfId,
                    'creatorName' => $user->name,
                ];

                $sendEvent('status', ['message' => $shelfName
                    ? 'Searching "' . $shelfName . '" for relevant sources...'
                    : 'Searching library for relevant sources...']);

                $result = $this->retrievalService->execute($plan, $context);
                $matches = $result['matches'];
                $queryText = $result['queryText'];
                $toolsUsed = $result['toolsUsed'];

                $pipelineLog['retrieval_log'] = $result['log'];
                $pipelineLog['tools_used'] = $toolsUsed;

                // No billing happens past this point — early return skips
                // BillingService::charge below (mirrors query()'s no-match rule,
                // locked by tests/Feature/AiBrain/AskBillingFailureTest.php).
                if (empty($matches)) {
                    Log::info('AiBrain: ask — no matches found', ['tools' => $toolsUsed, 'scope' => $sourceScope]);
                    $noMatchMessage = $shelfId
                        ? 'No matches in this collection. Try rephrasing your question.'
                        : 'No relevant passages found in the library.';
                    $sendEvent('error', ['message' => $noMatchMessage]);
                    return;
                }

                $pipelineLog['matches_found'] = count($matches);
                $pipelineLog['sources_consulted'] = array_map(fn($m) => [
                    'title' => $m->book_title ?? 'Untitled',
                    'year' => $m->book_year ?? '',
                    'similarity' => round($m->similarity * 100, 1),
                    'excerpt' => Str::limit($m->plainText ?? '', 80),
                ], array_slice($matches, 0, 10));

                $sendEvent('status', ['message' => 'Found ' . count($matches) . ' relevant sources — sending to ' . $modelLabel . '...']);

                $systemPrompt = $this->buildStandaloneSystemPrompt();
                $userMessage = $this->buildStandaloneUserMessage($question, $matches, $shelfName);
                $pipelineLog['prompt_summary'] = 'Question + ' . count($matches) . ' source passages';

                $llmResult = $llmService->chatWithFallback(
                    $systemPrompt,
                    $userMessage,
                    0.3,
                    8192,
                    $fallbackChain,
                    180,
                    'low',
                    $onRetry,
                    $onFallback
                );

                if (!$llmResult) {
                    Log::warning('AiBrain: ask — LLM all models failed');
                    $sendEvent('error', ['message' => 'The AI model failed to respond. Please try again.']);
                    return;
                }

                $llmResponse = $llmResult['content'];
                $brainModel = $llmResult['model'];
                $modelLabel = $modelLabels[$brainModel] ?? basename($brainModel);

                $llmResponse = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $llmResponse);
                if (str_contains($llmResponse, '<think>')) {
                    $llmResponse = preg_replace('/<think>[\s\S]*/i', '', $llmResponse);
                }
                $llmResponse = trim($llmResponse);

                // Same rule as query(): an LLM completion is untrusted markup —
                // doubly so under BYO where the "model" is whatever the client
                // posted back.
                $llmResponse = NodeHtmlSanitizer::clean($llmResponse) ?? '';

                $answerBookId = $this->generateAnswerBookId();

                $sendEvent('status', ['message' => 'Linking sources into your answer']);
                // 3rd arg is unused inside the minter; 4th lands in citedIN — the
                // standalone answer book plays the sub-book's role there.
                [$processedHtml, $hypercites] = $this->processCitationsInResponse(
                    $llmResponse,
                    $matches,
                    $answerBookId,
                    $answerBookId,
                    $user
                );

                $sendEvent('status', ['message' => 'Saving to your library']);
                $nowMs = (int) round(microtime(true) * 1000);
                $title = 'AI Archivist: ' . Str::limit($question, 80);

                // PRIVATE standalone book (type 'book', not 'sub_book') — a normal
                // editable/deletable library row owned by the asker. Private ⇒
                // sanitizeCitedInForViewer hides its citedIN entries from everyone
                // else, and no docuverse connection edge is created.
                DB::connection('pgsql_admin')->table('library')->updateOrInsert(
                    ['book' => $answerBookId],
                    [
                        'creator'       => $user->name,
                        'creator_token' => null,
                        'visibility'    => 'private',
                        'listed'        => false,
                        'title'         => $title,
                        'author'        => 'AI Archivist',
                        'type'          => 'book',
                        'has_nodes'     => true,
                        'raw_json'      => json_encode([]),
                        'timestamp'     => $nowMs,
                    ]
                );

                $questionNode = '<p><b>Prompt</b>: "' . e(Str::limit($question, 1000)) . '"</p>';
                $aiLabel = '<p><b>AI Archivist</b>:</p>';
                $conversationHtml = $questionNode . $aiLabel . $processedHtml;

                $nodes = $this->createResponseNodes($conversationHtml, $answerBookId);

                $usageStats = $llmService->getUsageStats();
                $totalCost = $this->calculateCost($usageStats, $embeddingService, $queryText);
                $pipelineLog['cost'] = $totalCost;
                $pipelineLog['llm_model'] = basename($brainModel);

                $appendixHtml = $this->buildAppendixHtml($pipelineLog);
                $appendixNodes = $this->createResponseNodes($appendixHtml, $answerBookId, count($nodes));
                $nodes = array_merge($nodes, $appendixNodes);

                $shelf = $this->ensureArchivistShelf($user, $answerBookId);

                // Bump each cited source book so other clients sync the new hypercites.
                if (!empty($hypercites)) {
                    $sourceBookIds = array_unique(array_map(fn($h) => $h['book'], $hypercites));
                    foreach ($sourceBookIds as $sourceBook) {
                        DB::select('SELECT update_annotations_timestamp(?, ?)', [$sourceBook, $nowMs]);
                    }
                }

                if ($clientInference) {
                    Log::info('AiBrain: ask — BYO client inference, charge waived', ['residual_cost' => $totalCost]);
                } else {
                    $billingService->charge(
                        $user,
                        $totalCost,
                        'AI Archivist: ' . Str::limit($question, 60),
                        'ai_brain',
                        [],
                        ['book_id' => $answerBookId]
                    );
                }

                Log::info('AiBrain: ask complete', [
                    'bookId' => $answerBookId,
                    'nodes_count' => count($nodes),
                    'hypercites_count' => count($hypercites),
                    'cost' => $totalCost,
                    'tools_used' => $toolsUsed,
                    'shelf_id' => $shelf['id'],
                ]);

                $sendEvent('result', [
                    'success'    => true,
                    'bookId'     => $answerBookId,
                    'nodes'      => $nodes,
                    'library'    => [
                        'book'       => $answerBookId,
                        'title'      => $title,
                        'type'       => 'book',
                        'visibility' => 'private',
                        'has_nodes'  => true,
                        'creator'    => $user->name,
                    ],
                    'hypercites' => $hypercites,
                    'tools_used' => $toolsUsed,
                    'shelf'      => $shelf,
                ]);

            } catch (ClientInferenceUnavailableException $e) {
                Log::warning('AiBrainController::ask - client inference unavailable', [
                    'error' => $e->getMessage(),
                ]);
                $sendEvent('error', ['message' => 'Your AI provider did not answer in time. Check your provider settings (⌘,) and try again.']);
            } catch (\Exception $e) {
                Log::error('AiBrainController::ask - exception', [
                    'error' => $e->getMessage(),
                    'trace' => $e->getTraceAsString(),
                ]);

                $sendEvent('error', ['message' => 'AI query failed']);
            } finally {
                $llmService->clearTransport();
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
        \Closure $sendEvent,
        bool $clientInference = false
    ): void {
        $selectedText = $validated['selectedText'];
        $question = $validated['question'];
        $bookId = $validated['bookId'];
        $highlightId = $validated['highlightId'];
        $subBookId = SubBookIdHelper::build($bookId, $highlightId);
        $timestamp = now()->timestamp;

        $sendEvent('status', ['message' => 'Reading your selection']);

        $systemPrompt = <<<'PROMPT'
You are a helpful reading assistant. The user is reading a book and has
selected a passage and asked a question about it.

Use the selected passage as context for what they're reading. Answer their
question helpfully, drawing on your general knowledge where useful — e.g.
explaining a word, comparing to other ideas, suggesting related authors,
or giving background the passage assumes.

A READING CONTEXT block may precede the passage, describing where it sits
(inside a highlight / footnote / AI response, its author, the root book) and
any citations or hypercite links it contains. Use it to read as an informed
reader would — but treat it as framing only; never quote it back verbatim.

Rules:
- Format as HTML paragraphs using <p> tags. Use <em> for emphasis and
  <blockquote> for quoting back text.
- No headings (h1-h6) and no wrapping container div.
- Be honest about what the passage says vs. what is your wider knowledge.
- Don't fabricate citations or quotes that aren't there.
- Keep responses focused — usually 1-4 paragraphs.
PROMPT;
        // Surrounding paragraph + selection framing — Quick Chat now reads the same
        // local context the Archivist does (requirement: even Quick Chat should know
        // the node the selection came from), plus the nesting/author/link preamble.
        $sendEvent('status', ['message' => 'Gathering the surrounding passage']);
        $rootMeta = $this->resolveRootBookMeta($bookId);
        $localContext = $this->retrievalService->executeLocalContext($bookId, $validated['nodeIds']);

        $sc = $validated['selectionContext'] ?? null;
        if (!empty($sc['citations'])) {
            $sendEvent('status', ['message' => 'Extracting citation details from your selection']);
        }
        if (!empty($sc['hypercites'])) {
            $sendEvent('status', ['message' => 'Following the hypercite links in your selection']);
        }

        $readingContext = $this->readingContext->build($sc, $rootMeta, $user);
        $userMessage = $this->buildUserMessage(
            $selectedText, $question, $localContext, [], $rootMeta['author'], $rootMeta['title'], $readingContext
        );

        $sendEvent('status', ['message' => 'Composing the answer with ' . $modelLabel]);

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
        // Sanitize before this HTML is written into nodes (untrusted markup —
        // doubly so under BYO where the client posted the completion).
        $processedHtml = NodeHtmlSanitizer::clean(trim($llmResponse)) ?? '';

        // Library upsert
        $sendEvent('status', ['message' => 'Saving to your library']);
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

        // BYO mode: the LLM ran on the user's own key — waive the residual cost.
        if ($clientInference) {
            Log::info('AiBrain (quick): BYO client inference — charge waived', ['residual_cost' => $totalCost]);
        } else {
            $billingService->charge(
                $user,
                $totalCost,
                'AI Quick Chat: ' . Str::limit($question, 60),
                'ai_brain',
                [],
                ['book_id' => $bookId, 'highlight_id' => $highlightId]
            );
        }

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
        // Resolve the ROOT book (foundation) so a sub-book selection still labels the
        // passage with the real author/title rather than the sub-book's blank row.
        $rootMeta = $this->resolveRootBookMeta($bookId);
        $authorName = $rootMeta['author'] ?? null;
        $bookTitle = $rootMeta['title'] ?? 'Unknown';

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
                $text = $this->nodeText($node);
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

        return $this->runRouterLlm(
            $llmService,
            $systemPrompt,
            $userMessage,
            $fallbackChain,
            $selectedText . "\n\n" . $question,
            ['author_name' => $authorName, 'book_title' => $bookTitle],
            $onRetry,
            $onFallback
        );
    }

    /**
     * Standalone (selection-free) router variant for ask(): rewrite a bare
     * research question into a search plan. Same wire contract as planRetrieval
     * minus the passage framing; the parse-failure fallback embeds the question
     * itself.
     */
    private function planStandaloneRetrieval(
        LlmService $llmService,
        string $question,
        ?string $corpusLabel,
        array $fallbackChain,
        ?\Closure $onRetry = null,
        ?\Closure $onFallback = null
    ): array {
        $systemPrompt = <<<'PROMPT'
You are an AI Archivist — a scholarly research assistant for the Hyperlit archive.
The user has asked the archive a research question (no passage is selected).
Your job is to rewrite their question into a search plan for finding relevant
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

        $userMessage = '';
        if ($corpusLabel) {
            $userMessage .= "The question is scoped to the collection \"{$corpusLabel}\".\n\n";
        }
        $userMessage .= "QUESTION:\n{$question}";

        return $this->runRouterLlm(
            $llmService,
            $systemPrompt,
            $userMessage,
            $fallbackChain,
            $question,
            [],
            $onRetry,
            $onFallback
        );
    }

    /**
     * Shared router-LLM call + <search> JSON parse. Extracted verbatim from
     * planRetrieval (behaviour unchanged) so planStandaloneRetrieval can reuse
     * it; only the prompts and the parse-failure embedding_query differ per
     * caller.
     */
    private function runRouterLlm(
        LlmService $llmService,
        string $systemPrompt,
        string $userMessage,
        array $fallbackChain,
        string $fallbackEmbeddingQuery,
        array $base,
        ?\Closure $onRetry = null,
        ?\Closure $onFallback = null
    ): array {
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

        $base['router_model'] = $llmResult ? basename($llmResult['model']) : 'unavailable';

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
                'embedding_query' => $fallbackEmbeddingQuery,
            ],
            'reasoning' => 'fallback — router parse failure',
        ]);
    }

    /**
     * Build adaptive system prompt based on what retrieval results are available.
     */
    private function buildSystemPrompt(bool $hasExternalSources, bool $allSameAuthor, bool $hasLocalContext = false): string
    {
        // Shared note: how to treat the optional READING CONTEXT framing block.
        $readingNote = "\n\nA READING CONTEXT block may precede the passage, describing where it sits (inside a highlight / footnote / AI response, its author, the root book's citation) and any citations or hypercite links it contains. Use it to read as an informed reader — treat it as framing only, never quote it back verbatim, and never treat a withheld/private link's contents as known.";

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
PROMPT
                . $readingNote;
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

        $base .= $readingNote;

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
        string $bookTitle,
        string $readingContext = ''
    ): string {
        $msg = '';
        if ($readingContext !== '') {
            $msg .= $readingContext . "\n\n";
        }
        $preceding = '';
        $following = '';

        // Local context: split into preceding/following paragraphs
        if (!empty($localContext)) {
            $passedSelected = false;

            foreach ($localContext as $node) {
                $text = $this->nodeText($node);
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

        // Merge adjacent bracket runs into ONE group: [1][2] / [1] [3, 4] → [1, 2] /
        // [1, 3, 4]. NEVER two arrows in a row — a run becomes a single grouped
        // arrow whose click opens the member chooser.
        $html = preg_replace('/(?<=\d)\]\s*\[(?=\d)/', ', ', $html);

        // Extract quoted text near each citation for smart charData
        $quotedTextMap = $this->extractQuotesNearCitations($html, $matches);

        // Track seen citations globally so non-consecutive dupes are also removed;
        // num => member info so a later GROUP can still list an already-minted target.
        $seenCitations = [];

        // Matches single [N] AND comma groups like [1, 3, 4] — despite the prompt's
        // one-citation rule the model emits survey-style groups, and an unmatched
        // group would land in the answer as dead literal text instead of arrows.
        // A group renders as ONE ↗ carrying a data-cite-group payload (target +
        // source label + quote per member) for the client-side chooser; every
        // fresh member's citedIN points at the shared anchor id so source-side
        // deep-links land on the arrow (anchorId ≠ hyperciteId — the
        // HyperciteMinter precedent).
        $processedHtml = preg_replace_callback(
            '/\[(\d+(?:\s*,\s*\d+)*)\]/',
            function ($m) use (&$hypercites, &$seenCitations, $matches, $subBookId, $user, $quotedTextMap) {
                $nums = array_values(array_unique(array_map('intval', preg_split('/\s*,\s*/', $m[1]))));
                $valid = array_values(array_filter($nums, fn($n) => $n >= 1 && $n <= count($matches)));

                // Every number out of range → keep the literal token (old behaviour)
                if (empty($valid)) {
                    return $m[0];
                }

                // Single citation — unchanged semantics: dupes are burned, fresh
                // ones mint with anchor id = hypercite id.
                if (count($valid) === 1) {
                    $num = $valid[0];
                    if (isset($seenCitations[$num])) {
                        return '';
                    }
                    $info = $this->mintCitationMember($num, $matches, $subBookId, $user, $quotedTextMap, $hypercites, null);
                    $seenCitations[$num] = $info;
                    return '<a id="' . e($info['hyperciteId']) . '" href="' . e($info['targetHref']) . '" class="open-icon">↗</a>';
                }

                // Group: burn when nothing NEW is cited (all members are dupes),
                // mirroring the single-dupe rule.
                $freshNums = array_values(array_filter($valid, fn($n) => !isset($seenCitations[$n])));
                if (empty($freshNums)) {
                    return '';
                }

                $anchorId = 'hypercite_' . Str::random(8);
                $members = [];
                foreach ($valid as $num) {
                    if (!isset($seenCitations[$num])) {
                        $seenCitations[$num] = $this->mintCitationMember($num, $matches, $subBookId, $user, $quotedTextMap, $hypercites, $anchorId);
                    }
                    $members[] = $seenCitations[$num];
                }

                $payload = array_map(fn($i) => [
                    't' => $i['targetHref'],
                    's' => $i['label'],
                    'q' => $i['quote'],
                ], $members);

                return '<a id="' . e($anchorId) . '" href="' . e($members[0]['targetHref']) . '" class="open-icon"'
                    . ' data-cite-group="' . e(json_encode($payload, JSON_UNESCAPED_UNICODE)) . '">↗</a>';
            },
            $html
        );

        return [$processedHtml, $hypercites];
    }

    /**
     * Mint ONE citation number into a hypercite row. Returns the member info the
     * anchor builders need: hyperciteId, targetHref, source label, quote snippet.
     * $citedInAnchorId overrides the citedIN anchor for group members (they all
     * share the group arrow's id); null = the row's own hypercite id.
     */
    private function mintCitationMember(
        int $citationNum,
        array $matches,
        string $subBookId,
        $user,
        array $quotedTextMap,
        array &$hypercites,
        ?string $citedInAnchorId
    ): array {
                $index = $citationNum - 1; // LLM uses 1-indexed, array is 0-indexed (caller validated the range)
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
                    'citedIN'            => json_encode(["/{$subBookId}#" . ($citedInAnchorId ?? $hyperciteId)]),
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

                // NOTE the flat anchor shape the callers build (<a class="open-icon">↗</a>
                // with a literal arrow): NOT the legacy <a><sup>&nearr;</sup></a> —
                // HtmlBlockSplitter's libxml round-trip escapes the unknown &nearr;
                // entity to &amp;nearr;, which only the reader repairs at render.
                $label = trim(($match->book_title ?? 'Untitled')
                    . (($match->book_author ?? '') !== '' ? ' — ' . $match->book_author : ''));

                return [
                    'hyperciteId' => $hyperciteId,
                    'targetHref'  => "/{$match->book}#{$hyperciteId}",
                    'label'       => $label,
                    'quote'       => Str::limit($hypercitedText, 140),
                ];
    }

    /**
     * Find quoted text near each [N] citation in the LLM output.
     * Returns a map: citation_number => quoted_string (verified to exist in source plainText).
     */
    private function extractQuotesNearCitations(string $html, array $matches): array
    {
        $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');

        // Find all [N] positions in the plain text (a comma group like [1, 3]
        // counts as its FIRST number — that member gets the nearby quote; the
        // rest fall back to whole-node charData)
        $citationPositions = [];
        if (preg_match_all('/\[(\d+)(?:\s*,\s*\d+)*\]/', $text, $cMatches, PREG_OFFSET_CAPTURE)) {
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
        // Split into clean top-level blocks. This lifts <blockquote>/<ul>/… OUT of
        // <p> (LLMs nest them, which is invalid HTML — the browser then drops the
        // quote and everything after it when the node renders). One block = one node.
        $paragraphs = \App\Services\AiBrain\HtmlBlockSplitter::split($html);
        // Drop blocks with no visible text (empty <p>/<blockquote> the model emitted).
        $paragraphs = array_values(array_filter($paragraphs, fn($p) => trim(strip_tags($p)) !== ''));

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
                // Inject the id into whatever the leading block tag is (p, blockquote,
                // ul, …); only wrap in <p> when the fragment has no leading tag.
                if (preg_match('/^<([a-zA-Z][a-zA-Z0-9]*)/', $paragraph, $m)) {
                    $paragraph = preg_replace('/^<' . $m[1] . '/', '<' . $m[1] . ' data-node-id="' . $nodeId . '"', $paragraph, 1);
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

    /**
     * Fireworks AI fallback chain. Verified live 2026-05-27. Shared by query()
     * and ask(). Returns [$fallbackChain, $brainModel, $modelLabel, $modelLabels].
     *
     * TODO: when Fireworks credits run out, migrate to DeepInfra:
     *   LLM_BASE_URL=https://api.deepinfra.com/v1/openai
     *   primary: deepseek-ai/DeepSeek-V3.2                  ($0.26 in / $0.38 out per 1M)
     *   fallback: nvidia/NVIDIA-Nemotron-3-Super-120B-A12B  ($0.10/$0.50)
     *   fallback: Qwen/Qwen3.6-35B-A3B                      ($0.15/$0.95)
     * Reasons to switch: ~50% cheaper input + ~75% cheaper output, SOC 2 +
     * ISO 27001, zero-retention (in-memory only), no training-on-prompts.
     */
    private function resolveModelChain(?string $requestedModel): array
    {
        $fallbackChain = [
            'accounts/fireworks/models/deepseek-v4-pro-0813',  // primary — DeepSeek V4 Pro (GA; preview id serverless-decommissioned 2026-08-27)
            'accounts/fireworks/models/kimi-k2p6',             // fallback 1 — different family
            'accounts/fireworks/models/gpt-oss-120b',          // fallback 2 — cheap safety net
        ];

        $modelLabels = [
            'accounts/fireworks/models/deepseek-v4-pro-0813' => 'DeepSeek V4 Pro',
            'accounts/fireworks/models/kimi-k2p6'            => 'Kimi K2.6',
            'accounts/fireworks/models/gpt-oss-120b'         => 'GPT-OSS 120B',
        ];

        // Place user-selected model first in the chain (if valid)
        $allowedModels = array_keys($modelLabels);
        $brainModel = in_array($requestedModel, $allowedModels)
            ? $requestedModel
            : 'accounts/fireworks/models/deepseek-v4-pro-0813';

        // Reorder fallback chain: user's chosen model first, then the rest
        $fallbackChain = array_values(array_unique(array_merge([$brainModel], $fallbackChain)));

        return [$fallbackChain, $brainModel, $modelLabels[$brainModel] ?? basename($brainModel), $modelLabels];
    }

    /**
     * System prompt for the standalone (selection-free) answer call: a short
     * lit-review over the retrieved passages, same citation discipline as the
     * in-reader archivist prompt.
     */
    private function buildStandaloneSystemPrompt(): string
    {
        return <<<'PROMPT'
You are an AI Archivist — a scholarly research assistant helping users track down and analyse meaning across the Hyperlit archive of open access research. The user has asked the archive a research question.

Your task:
1. Answer the question as a short literature review, drawing on the provided source passages
2. When referencing a source, use the author's name naturally (e.g. "As Smith argues [1]", "Hayek's intervention [3]") — never write "Source [N]"
3. Include actual brief quotes from the source passages where relevant, followed by the citation number
4. When multiple source passages support one claim, cite only the single most relevant one — never stack citations like [1][2][3] and never group them like [1, 2, 3]. Each [N] should appear at most once in your entire response.
5. Format your response as HTML paragraphs using <p> tags

Rules:
- Only cite sources using the exact [N] reference numbers from the provided passages
- Do not invent citations or reference works not in the provided sources
- If the provided passages do not really answer the question, say so plainly and describe what they DO cover
- Keep your response focused and substantive (3-8 paragraphs)
- Use <em> for emphasis and <blockquote> for longer quotes
- Do NOT include headings (h1-h6)
- Do NOT wrap the entire response in a container div
- Always refer to source authors by name, not by "Source" — if you must use the word, use lowercase "source"
PROMPT;
    }

    private function buildStandaloneUserMessage(string $question, array $matches, ?string $corpusLabel = null): string
    {
        $msg = '';
        if ($corpusLabel) {
            $msg .= "The question is asked against the collection \"{$corpusLabel}\".\n\n";
        }
        $msg .= "QUESTION:\n{$question}";
        $msg .= "\n\nSOURCE PASSAGES FROM LIBRARY:\n" . $this->buildPassageContext($matches);
        return $msg;
    }

    /**
     * Standalone answer-book id, following the client convention for new books
     * (`book_<ms>`, see resources/js/SPA/createNewBook.ts). The bump loop
     * handles a same-millisecond collision.
     */
    private function generateAnswerBookId(): string
    {
        $ms = (int) round(microtime(true) * 1000);
        do {
            $id = 'book_' . $ms;
            $exists = DB::connection('pgsql_admin')->table('library')->where('book', $id)->exists();
            $ms++;
        } while ($exists);
        return $id;
    }

    /**
     * Find-or-create the asker's "AI Archivist" shelf and append the answer
     * book. All writes on pgsql_admin, mirroring ShelfController's write paths;
     * the unique (creator, name) index guarantees at most one shelf to find.
     * Returns ['id' => uuid, 'name' => 'AI Archivist'] for the result event.
     */
    private function ensureArchivistShelf($user, string $answerBookId): array
    {
        $admin = DB::connection('pgsql_admin');
        $name = 'AI Archivist';

        $shelf = $admin->table('shelves')
            ->where('creator', $user->name)
            ->where('name', $name)
            ->first(['id']);

        if ($shelf) {
            $shelfId = $shelf->id;
        } else {
            $slug = 'ai-archivist';
            while ($admin->table('shelves')->where('creator', $user->name)->where('slug', $slug)->exists()) {
                $slug = 'ai-archivist-' . strtolower(Str::random(4));
            }
            $shelfId = $admin->table('shelves')->insertGetId([
                'creator'       => $user->name,
                'creator_token' => null,
                'name'          => $name,
                'slug'          => $slug,
                'description'   => 'Answers written by the AI Archivist.',
                'visibility'    => 'private',
                'default_sort'  => 'recent',
                'created_at'    => now(),
                'updated_at'    => now(),
            ], 'id');
            Log::info('AiBrain: created AI Archivist shelf', ['user' => $user->name, 'shelf_id' => $shelfId]);
        }

        $admin->table('shelf_items')->updateOrInsert(
            ['shelf_id' => $shelfId, 'book' => $answerBookId],
            ['added_at' => now()]
        );
        $admin->table('shelves')->where('id', $shelfId)->update(['updated_at' => now()]);
        (new \App\Services\ShelfCacheInvalidator())->flush($shelfId);

        return ['id' => $shelfId, 'name' => $name];
    }
}
