<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\SearchController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Meaning-based retrieval over book text — the research entry point, and the
 * same retrieval the AI Archivist runs on. Split out of search_text as its own
 * verb-task tool: an agent scanning a bare tools listing must be able to SEE
 * that semantic search exists (it shipped once as an invisible mode and every
 * agent reached for keyword search instead).
 */
#[IsReadOnly]
class SemanticSearchTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'semantic_search';

    protected string $description = 'Search book text BY MEANING — the research entry point, and the same retrieval the AI Archivist uses to find sources. Describe the topic or claim you want passages about ("the political economy of land enclosure"), not keywords. Searches all visible books, or ONE book when `book` is passed. Results carry book + node references usable with read_book. For exact words/phrases use search_text; for finding a work by title/author use search_library.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'query' => $schema->string()->min(3)->required()
                ->description('The topic/claim to find passages about, phrased in natural language (min 3 chars).'),
            'book' => $schema->string()->description('Optional book id/slug to search within one book only.'),
            'limit' => $schema->integer()->description('Max results (default 20).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['query' => 'required|string|min:3']);

        $book = trim((string) $request->get('book', ''));
        $input = [
            'q' => $request->get('query'),
            'limit' => min(50, (int) $request->get('limit', 20)),
        ];

        if ($book !== '') {
            [$resolved, $refusal] = $this->resolveBook($book);
            if ($refusal) {
                return $refusal;
            }
            $input['book'] = $resolved;
            $method = 'searchInBook';
        } else {
            $method = 'searchSemantic';
        }

        $result = InternalCall::call(SearchController::class, $method, $input, $this->user($request));

        if (($result['json']['success'] ?? true) === false && ($result['json']['message'] ?? null)) {
            return Response::error($result['json']['message']);
        }
        if ($error = $this->errorFrom($result, 'semantic search')) {
            return $error;
        }

        return Response::json([
            'mode' => $book !== '' ? 'in-book semantic' : 'semantic',
            'results' => $result['json']['results'] ?? [],
            'count' => $result['json']['count'] ?? count($result['json']['results'] ?? []),
        ]);
    }
}
