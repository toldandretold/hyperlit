<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\SearchController;
use App\Http\Controllers\ShelfController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Exact-word search over book text. Semantic (by-meaning) retrieval lives in
 * its own tool, semantic_search — keeping it here as a mode made it invisible
 * in a tools listing. Shelf scoping rides ShelfController::search, which is
 * fulltext-only server-side (which is also why semantic_search has no shelf
 * param — we don't fake capabilities).
 */
#[IsReadOnly]
class SearchTextTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'search_text';

    protected string $description = 'Keyword/phrase search INSIDE book text — exact or stemmed words, e.g. locating a verbatim quote or a name. Searches all visible books, or one shelf when `shelf` is passed (a shelf id from list_shelves, or "public"/"private" for the system shelves). For topic/meaning searches use semantic_search instead; for finding a work by title/author use search_library.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'query' => $schema->string()->min(2)->required()->description('Exact search terms (min 2 chars).'),
            'shelf' => $schema->string()->description('Optional shelf id (from list_shelves) or "public"/"private" to search only that shelf\'s books.'),
            'limit' => $schema->integer()->description('Max results (default 20).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['query' => 'required|string|min:2']);

        $shelf = trim((string) $request->get('shelf', ''));
        $input = [
            'q' => $request->get('query'),
            'limit' => min(50, (int) $request->get('limit', 20)),
        ];

        $result = $shelf !== ''
            ? InternalCall::call(ShelfController::class, 'search', $input, $this->user($request), [$shelf])
            : InternalCall::call(SearchController::class, 'searchNodes', $input, $this->user($request));

        if (($result['json']['success'] ?? true) === false && ($result['json']['message'] ?? null)) {
            return Response::error($result['json']['message']);
        }
        if (($result['json']['error'] ?? null) !== null) {
            return Response::error((string) $result['json']['error']);
        }
        if ($error = $this->errorFrom($result, 'search text')) {
            return $error;
        }

        return Response::json([
            'mode' => $shelf !== '' ? 'shelf fulltext' : 'fulltext',
            'results' => $result['json']['results'] ?? [],
            'count' => $result['json']['count'] ?? count($result['json']['results'] ?? []),
        ]);
    }
}
