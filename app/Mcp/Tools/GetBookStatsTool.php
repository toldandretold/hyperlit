<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\CreatorStatsController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/** Aggregates only, own books only — the same data as the web Stats overlay. */
#[IsReadOnly]
class GetBookStatsTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'get_book_stats';

    protected string $description = 'Reading analytics for the user\'s OWN books (views, likes, downloads by format — aggregates only). Omit `book` for the all-books overview; pass one for its detail. Pass `scope: "shelves"` for the user\'s shelves/archives instead (views = feed opens, downloads = vault/sqlite exports, plus whole-library export downloads). Public like counts for any book are on get_book.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->description('Optional book id/slug for per-book detail; omit for the overview.'),
            'sort' => $schema->string()->description('Overview sort column (as in the web Stats overlay). Optional.'),
            'scope' => $schema->string()->enum(['books', 'shelves'])->description('"books" (default) or "shelves". Optional.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $user = $this->user($request);
        $book = trim((string) $request->get('book', ''));
        $scope = trim((string) $request->get('scope', 'books'));

        if ($scope === 'shelves') {
            $result = InternalCall::call(CreatorStatsController::class, 'shelves', [], $user);
        } elseif ($book !== '') {
            [$bookId, $refusal] = $this->resolveBook($book);
            if ($refusal) {
                return $refusal;
            }
            $result = InternalCall::call(CreatorStatsController::class, 'show', [], $user, [$bookId]);
        } else {
            $input = [];
            if (trim((string) $request->get('sort', '')) !== '') {
                $input['sort'] = trim((string) $request->get('sort'));
            }
            $result = InternalCall::call(CreatorStatsController::class, 'index', $input, $user);
        }

        if ($error = $this->errorFrom($result, 'read the stats')) {
            return $error;
        }

        return Response::json($result['json'] ?? []);
    }
}
