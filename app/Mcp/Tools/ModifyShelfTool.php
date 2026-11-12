<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\ShelfController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;

class ModifyShelfTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::ANNOTATE;

    protected string $name = 'modify_shelf';

    protected string $description = 'Create, rename or delete one of the user\'s shelves, add/remove a book, or pin/unpin a book to the top of a shelf. Actions: create (name required), rename (shelf_id + name), delete (shelf_id), add_book / remove_book / pin / unpin (shelf_id + book). Shelf ids come from list_shelves. The Likes shelf is managed via like_book, never here.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'action' => $schema->string()->enum(['create', 'rename', 'delete', 'add_book', 'remove_book', 'pin', 'unpin'])
                ->required()->description('What to do.'),
            'shelf_id' => $schema->string()->description('Target shelf uuid (all actions except create).'),
            'name' => $schema->string()->description('Shelf name (create / rename).'),
            'book' => $schema->string()->description('Book id or slug (add_book / remove_book / pin / unpin).'),
            'visibility' => $schema->string()->enum(['private', 'public'])->description('create only. Default private.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate([
            'action' => 'required|in:create,rename,delete,add_book,remove_book,pin,unpin',
            'shelf_id' => 'required_unless:action,create|uuid',
            'name' => 'required_if:action,create,rename|string|max:255',
            'book' => 'required_if:action,add_book,remove_book,pin,unpin|string',
            'visibility' => 'nullable|in:private,public',
        ]);

        $user = $this->user($request);
        $action = (string) $request->get('action');
        $shelfId = (string) $request->get('shelf_id', '');

        $book = null;
        if (in_array($action, ['add_book', 'remove_book', 'pin', 'unpin'], true)) {
            [$book, $refusal] = $this->resolveBook((string) $request->get('book'));
            if ($refusal) {
                return $refusal;
            }
        }

        // The Likes shelf has ONE writer (LikesShelf, driven by the like
        // endpoints) — a direct membership write here would desync the like
        // rows from the shelf. Redirect to the tool that owns that invariant.
        if (in_array($action, ['add_book', 'remove_book'], true) && $shelfId !== '') {
            $kind = \Illuminate\Support\Facades\DB::table('shelves')->where('id', $shelfId)->value('kind');
            if ($kind === 'likes') {
                return Response::error('The Likes shelf is managed by liking/unliking books — use like_book instead of modify_shelf.');
            }
            if ($kind === \App\Services\Shelves\LicenceReviewShelf::KIND) {
                return Response::error('This shelf is kept up to date automatically: it lists the user\'s published books that might not be OK to publish. Make a book private (set_book_visibility) to take it off.');
            }
        }

        $result = match ($action) {
            'create' => InternalCall::call(ShelfController::class, 'store', [
                'name' => $request->get('name'),
                'visibility' => $request->get('visibility', 'private'),
            ], $user),
            'rename' => InternalCall::call(ShelfController::class, 'update', [
                'name' => $request->get('name'),
            ], $user, [$shelfId]),
            'delete' => InternalCall::call(ShelfController::class, 'destroy', [], $user, [$shelfId]),
            'add_book' => InternalCall::call(ShelfController::class, 'addItem', [
                'book' => $book,
            ], $user, [$shelfId]),
            'remove_book' => InternalCall::call(ShelfController::class, 'removeItem', [], $user, [$shelfId, $book]),
            'pin' => InternalCall::call(ShelfController::class, 'pin', ['book' => $book], $user, [$shelfId]),
            'unpin' => InternalCall::call(ShelfController::class, 'unpin', [], $user, [$shelfId, $book]),
        };

        if ($error = $this->errorFrom($result, "{$action} on the shelf")) {
            return $error;
        }
        $json = is_array($result['json']) ? $result['json'] : [];
        if (($json['error'] ?? null) || ($json['success'] ?? true) === false) {
            return Response::error($json['error'] ?? $json['message'] ?? "Could not {$action}.");
        }

        return Response::json(array_merge(['action' => $action, 'done' => true],
            $action === 'create' ? ['shelf' => $json['shelf'] ?? $json] : []));
    }
}
