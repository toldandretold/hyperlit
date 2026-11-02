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

    protected string $description = 'Reading analytics for the user\'s OWN books (views, readers, likes — aggregates only). Omit `book` for the all-books overview; pass one for its detail. Public like counts for any book are on get_book.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->description('Optional book id/slug for per-book detail; omit for the overview.'),
            'sort' => $schema->string()->description('Overview sort column (as in the web Stats overlay). Optional.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $user = $this->user($request);
        $book = trim((string) $request->get('book', ''));

        if ($book !== '') {
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
