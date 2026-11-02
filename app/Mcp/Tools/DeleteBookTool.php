<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DbLibraryController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Permanently deletes a book (BookDeletionService: nodes, annotations,
 * sub-books, shelf rows, caches). Destructive and unrecoverable, so beyond the
 * server's creator-only check the tool demands BOTH confirm:true AND the
 * stored title typed back exactly — a model cannot stumble into it.
 */
#[IsIdempotent(false)]
class DeleteBookTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::WRITE;

    protected string $name = 'delete_book';

    protected string $description = 'PERMANENTLY delete a book the user owns — content, annotations, sub-books, shelf entries. Unrecoverable. Requires confirm:true AND title_confirmation matching the book\'s stored title exactly. Only do this when the user explicitly asked for deletion.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'confirm' => $schema->boolean()->required()->description('Must be true.'),
            'title_confirmation' => $schema->string()->required()
                ->description('The book\'s exact stored title (from get_book) — a typed-back safety check.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate([
            'book' => 'required|string',
            'confirm' => 'required|boolean',
            'title_confirmation' => 'required|string',
        ]);

        if (! $request->boolean('confirm')) {
            return Response::error('Deletion requires confirm:true.');
        }

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $stored = DB::table('library')->where('book', $bookId)->value('title');
        if ($stored === null) {
            return Response::error('Book not found.');
        }
        if (trim((string) $request->get('title_confirmation')) !== trim((string) $stored)) {
            return Response::error('title_confirmation does not match the stored title ("'.$stored.'"). Nothing was deleted.');
        }

        $result = InternalCall::call(DbLibraryController::class, 'destroy', [], $this->user($request), [$bookId]);
        if ($error = $this->errorFrom($result, 'delete the book')) {
            return $error;
        }
        $json = $result['json'] ?? [];
        if (($json['success'] ?? false) !== true) {
            return Response::error($json['message'] ?? 'The book was not deleted.');
        }

        return Response::json([
            'book' => $bookId,
            'deleted' => true,
            'stats' => $json['stats'] ?? null,
        ]);
    }
}
