<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\ImportController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ImportStatusTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'import_status';

    protected string $description = 'Check the progress of an import started with import_document. Returns status (queued/processing/complete/failed), percent, and the current stage. Poll until status is complete, then read the book with get_book / read_book.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('The book id returned by import_document.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['book' => 'required|string']);
        $book = preg_replace('/[^a-zA-Z0-9_-]/', '', (string) $request->get('book'));

        // importProgress(string $bookId) takes NO Request — pass the book as
        // the sole arg (prependRequest: false).
        $result = InternalCall::call(
            ImportController::class, 'importProgress', [], $this->user($request), [$book], [], false
        );
        $json = is_array($result['json']) ? $result['json'] : [];

        if (($json['status'] ?? null) === 'not_found' || $result['status'] === 404) {
            return Response::error('No import found for that book id (it may not have started, or the id is wrong).');
        }

        return Response::json([
            'book' => $book,
            'status' => $json['status'] ?? 'unknown',
            'percent' => $json['percent'] ?? null,
            'stage' => $json['stage'] ?? null,
            'detail' => $json['detail'] ?? null,
            'queue_position' => $json['queue_position'] ?? null,
        ]);
    }
}
