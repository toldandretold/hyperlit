<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DatabaseToIndexedDBController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class GetReadingPositionTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'get_reading_position';

    protected string $description = 'Where the user last left off in a book (their saved reading position: element/node id + chunk). Use with read_book\'s after_line to continue from there.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['book' => 'required|string']);
        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $result = InternalCall::call(DatabaseToIndexedDBController::class, 'getReadingPosition', [], $this->user($request), [$bookId]);
        if ($error = $this->errorFrom($result, 'read the position')) {
            return $error;
        }

        return Response::json(array_merge(['book' => $bookId], $result['json'] ?? []));
    }
}
