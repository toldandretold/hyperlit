<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DbLibraryController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/** Creator-only; reserved root segments and taken slugs are refused server-side. */
#[IsIdempotent]
class SetBookSlugTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::WRITE;

    protected string $name = 'set_book_slug';

    protected string $description = 'Set a book\'s URL slug (hyperlit.test/<slug>), for books the user owns. Pass check_only:true to test availability without changing anything. Reserved words and slugs owned by other books/usernames are refused.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or current slug.'),
            'slug' => $schema->string()->min(2)->required()->description('The desired slug.'),
            'check_only' => $schema->boolean()->description('true = availability check only, no change.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['book' => 'required|string', 'slug' => 'required|string|min:2']);

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $user = $this->user($request);
        $slug = (string) $request->get('slug');

        if ($request->boolean('check_only')) {
            $check = InternalCall::call(DbLibraryController::class, 'checkSlug', [
                'slug' => $slug, 'book' => $bookId,
            ], $user);
            if ($error = $this->errorFrom($check, 'check the slug')) {
                return $error;
            }

            return Response::json(array_merge(['slug' => $slug], $check['json'] ?? []));
        }

        $result = InternalCall::call(DbLibraryController::class, 'setSlug', [
            'book' => $bookId, 'slug' => $slug,
        ], $user);
        if ($error = $this->errorFrom($result, 'set the slug')) {
            return $error;
        }
        $json = $result['json'] ?? [];
        if (($json['success'] ?? false) !== true) {
            return Response::error($json['message'] ?? 'The slug was not set.');
        }

        return Response::json([
            'book' => $bookId,
            'slug' => $json['slug'] ?? $slug,
            'url' => rtrim(config('app.url'), '/').'/'.($json['slug'] ?? $slug),
        ]);
    }
}
