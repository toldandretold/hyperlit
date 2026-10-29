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
class SearchLibraryTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'search_library';

    protected string $description = 'Search Hyperlit\'s library by bibliographic metadata (title, author, year, journal). Returns matching books with their ids. Visibility follows the user: public books plus their own.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'query' => $schema->string()->min(2)->required()
                ->description('Title/author/metadata search terms (min 2 chars).'),
            'limit' => $schema->integer()->description('Max results (default 20).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['query' => 'required|string|min:2']);

        $result = InternalCall::call(SearchController::class, 'searchLibrary', [
            'q' => $request->get('query'),
            'limit' => min(50, (int) $request->get('limit', 20)),
        ], $this->user($request));

        if ($error = $this->errorFrom($result, 'search the library')) {
            return $error;
        }

        return Response::json([
            'results' => $result['json']['results'] ?? [],
            'count' => $result['json']['count'] ?? 0,
        ]);
    }
}
