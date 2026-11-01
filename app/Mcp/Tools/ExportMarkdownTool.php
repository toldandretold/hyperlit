<?php

namespace App\Mcp\Tools;

use App\Services\Export\BookMarkdownExporter;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ExportMarkdownTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'export_markdown';

    protected string $description = 'Export a book as Markdown — footnotes as [^n], citations resolved, a References section appended. Returned as text, paginated by character offset (use next_offset to continue) because a whole book can exceed the result size limit.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'offset' => $schema->integer()->description('Character offset to start from (default 0; use the previous response\'s next_offset).'),
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

        // Authorization: BookAccess, with a crafted request carrying the user
        // (canAccessBookContent reads Auth::user(), already the MCP user).
        if (! \App\Services\BookAccess::canAccessBookContent($bookId, request())) {
            return Response::error('Not authorized to export this book (it may be private and owned by someone else).');
        }

        try {
            $markdown = app(BookMarkdownExporter::class)->markdownFor($bookId);
        } catch (\Throwable $e) {
            return Response::error('Could not export this book: '.$e->getMessage());
        }

        $total = mb_strlen($markdown);
        $offset = max(0, (int) $request->get('offset', 0));
        $slice = mb_substr($markdown, $offset, self::CHAR_BUDGET);
        $nextOffset = $offset + mb_strlen($slice);

        return Response::json([
            'book' => $bookId,
            'markdown' => $slice,
            'total_chars' => $total,
            // null = you have the whole document.
            'next_offset' => $nextOffset < $total ? $nextOffset : null,
        ]);
    }
}
