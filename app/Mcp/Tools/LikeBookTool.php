<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\BookLikeController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Likes go through BookLikeController ONLY: it is the single writer that
 * mirrors like rows into the Likes shelf (LikesShelf). Writing that shelf
 * directly would desync the two — modify_shelf refuses likes-kind shelves
 * and points here.
 */
#[IsIdempotent]
class LikeBookTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::ANNOTATE;

    protected string $name = 'like_book';

    protected string $description = 'Like or unlike a book as the user (one like per book; liked books appear on their Likes shelf). action: like (default) or unlike.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'action' => $schema->string()->enum(['like', 'unlike'])->description('Default: like.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['book' => 'required|string', 'action' => 'nullable|in:like,unlike']);

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $action = $request->get('action', 'like');
        $result = InternalCall::call(BookLikeController::class, $action === 'unlike' ? 'unlike' : 'like', [], $this->user($request), [$bookId]);
        if ($error = $this->errorFrom($result, $action.' the book')) {
            return $error;
        }

        return Response::json(array_merge(['book' => $bookId, 'action' => $action], $result['json'] ?? []));
    }
}
