<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\SearchController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class SearchTextTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'search_text';

    protected string $description = 'Search INSIDE book text — the research entry point, and how the AI Archivist finds sources. Default mode=semantic: meaning-based retrieval across all visible books (describe the TOPIC, not keywords). mode=fulltext is for exact words/phrases (e.g. locating a verbatim quote). Pass `book` to restrict a semantic search to one book. Results carry book + node references usable with read_book.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'query' => $schema->string()->min(3)->required()->description('Search terms. Semantic mode: phrase the topic/claim you want passages about.'),
            'mode' => $schema->string()->enum(['semantic', 'fulltext'])
                ->description('semantic = by meaning (DEFAULT — the archivist retrieval move); fulltext = exact/stemmed keywords, for verbatim phrases.'),
            'book' => $schema->string()->description('Optional book id/slug to scope a SEMANTIC search to one book.'),
            'limit' => $schema->integer()->description('Max results (default 20).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['query' => 'required|string|min:3']);

        // Semantic by DEFAULT: this tool is the research entry point, and the
        // archivist's defining move is meaning-based retrieval — an agent left
        // on a keyword default reaches for the wrong search every time.
        $mode = $request->get('mode', 'semantic');
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
            $method = $mode === 'semantic' ? 'searchSemantic' : 'searchNodes';
        }

        $result = InternalCall::call(SearchController::class, $method, $input, $this->user($request));

        if (($result['json']['success'] ?? true) === false && ($result['json']['message'] ?? null)) {
            return Response::error($result['json']['message']);
        }
        if ($error = $this->errorFrom($result, 'search text')) {
            return $error;
        }

        return Response::json([
            'mode' => $book !== '' ? 'in-book semantic' : $mode,
            'results' => $result['json']['results'] ?? [],
            'count' => $result['json']['count'] ?? 0,
        ]);
    }
}
