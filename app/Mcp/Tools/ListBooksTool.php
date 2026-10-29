<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\CreatorStatsController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ListBooksTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'list_books';

    protected string $description = 'List the authenticated user\'s own books (title, author, id, view/like counts). Supports sorting, text filter and offset pagination. For OTHER people\'s public books use search_library instead.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'sort' => $schema->string()->enum(['recent', 'views', 'likes', 'title', 'author'])
                ->description('Sort order. Default: recent.'),
            'query' => $schema->string()->description('Optional title/author filter.'),
            'offset' => $schema->integer()->description('Pagination offset (pages of 100).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $result = InternalCall::call(CreatorStatsController::class, 'index', [
            'sort' => $request->get('sort', 'recent'),
            'q' => $request->get('query', ''),
            'offset' => (int) $request->get('offset', 0),
        ], $this->user($request));

        if ($error = $this->errorFrom($result, 'list your books')) {
            return $error;
        }

        $json = $result['json'];

        return Response::json([
            'books' => collect($json['books'] ?? [])->map(fn ($b) => [
                'book' => $b['book'],
                'title' => $b['title'],
                'author' => $b['author'],
                'views' => $b['total_views'] ?? 0,
                'likes' => $b['likes'] ?? 0,
            ])->all(),
            'total' => $json['total'] ?? 0,
            'offset' => $json['offset'] ?? 0,
        ]);
    }
}
