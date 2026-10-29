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

    protected string $description = 'Search INSIDE book text. mode=fulltext is keyword/phrase search across all visible books; mode=semantic is meaning-based search across all visible books; pass `book` to restrict a semantic search to one book. Results carry book + node references usable with read_book.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'query' => $schema->string()->min(3)->required()->description('Search terms (min 3 chars).'),
            'mode' => $schema->string()->enum(['fulltext', 'semantic'])
                ->description('fulltext = exact/stemmed keywords; semantic = by meaning. Default: fulltext.'),
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

        $mode = $request->get('mode', 'fulltext');
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
