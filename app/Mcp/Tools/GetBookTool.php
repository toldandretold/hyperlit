<?php

namespace App\Mcp\Tools;

use App\Helpers\BookSlugHelper;
use App\Http\Controllers\DatabaseToIndexedDBController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use App\Services\E2ee\EncryptedBookGuard;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class GetBookTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'get_book';

    protected string $description = 'Get a book\'s bibliographic metadata and table of contents (headings with node ids). Call this BEFORE read_book to orient in a long text. Accepts a book id or URL slug.';

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

        // Metadata is deliberately available even for encrypted books (it is
        // citable); only CONTENT is refused, so resolve without the E2EE gate.
        $bookId = BookSlugHelper::resolve(trim((string) $request->get('book')));
        $user = $this->user($request);

        $libraryResult = InternalCall::call(
            DatabaseToIndexedDBController::class, 'getBookLibrary', [], $user, [$bookId]
        );
        $library = $libraryResult['json']['library'] ?? null;

        if (! $library) {
            return Response::error('Book not found.');
        }

        $encrypted = EncryptedBookGuard::isEncrypted($bookId);
        $meta = collect($library)->only([
            'book', 'title', 'author', 'year', 'type', 'publisher', 'journal',
            'booktitle', 'editor', 'volume', 'issue', 'pages', 'language',
            'visibility', 'creator', 'timestamp',
        ])->all();
        $meta['encrypted'] = $encrypted;

        if ($encrypted) {
            return Response::json([
                'library' => $meta,
                'note' => 'This book is end-to-end encrypted — metadata only; its content cannot be read or annotated through this server.',
            ]);
        }

        $headingsResult = InternalCall::call(
            DatabaseToIndexedDBController::class, 'getBookHeadings', [], $user, [$bookId]
        );
        if ($error = $this->errorFrom($headingsResult, 'read the table of contents')) {
            return $error;
        }

        return Response::json([
            'library' => $meta,
            'table_of_contents' => $headingsResult['json']['headings'] ?? $headingsResult['json'] ?? [],
        ]);
    }
}
