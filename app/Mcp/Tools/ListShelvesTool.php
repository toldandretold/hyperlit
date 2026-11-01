<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\ShelfController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ListShelvesTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'list_shelves';

    protected string $description = 'List the user\'s shelves (curated book collections), with item counts. Pass a book id to also see which shelves that book is already on.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()
                ->description('Optional book id — adds is_member per shelf for this book.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $input = [];
        $book = trim((string) $request->get('book', ''));
        if ($book !== '') {
            [$resolved, $refusal] = $this->resolveBook($book);
            if ($refusal) {
                return $refusal;
            }
            $input['book'] = $resolved;
        }

        $result = InternalCall::call(ShelfController::class, 'index', $input, $this->user($request));

        if ($error = $this->errorFrom($result, 'list shelves')) {
            return $error;
        }

        return Response::json([
            'shelves' => collect($result['json']['shelves'] ?? [])->map(fn ($s) => [
                'id' => $s['id'],
                'name' => $s['name'],
                'visibility' => $s['visibility'] ?? null,
                'kind' => $s['kind'] ?? 'user',
                'item_count' => $s['item_count'] ?? 0,
                'is_member' => $s['is_member'] ?? null,
            ])->all(),
        ]);
    }
}
