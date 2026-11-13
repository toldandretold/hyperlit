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

    protected string $description = 'Check the progress of an import started with import_document. Returns status (queued/processing/complete/failed), percent, and the current stage. Poll until status is complete, then read the book with get_book / read_book. For a DOI / OpenAlex import the completed result carries the REAL `book` id (use that, not the id you polled with) and an `outcome`: "commons" = the shared copy, also placed on the user\'s "Imported works" shelf; "personal_copy" = a private copy, because the open copy found may not be hosted publicly. Status awaiting_confirmation means an open copy was found as a PDF and OCR must be approved: tell the user the estimate, then call import_document with the confirm_token. A failed status carries the reason.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('The id returned by import_document (its `book`, or `import` for a DOI / OpenAlex import).'),
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

        // A DOI / OpenAlex import is polled by its import id; once it lands, progress names
        // the book it became (the commons copy keeps its own id).
        return Response::json(array_filter([
            'book' => $json['book'] ?? $book,
            'status' => $json['status'] ?? 'unknown',
            'percent' => $json['percent'] ?? null,
            'stage' => $json['stage'] ?? null,
            'detail' => $json['detail'] ?? null,
            'queue_position' => $json['queue_position'] ?? null,
            'outcome' => $json['outcome'] ?? null,
            'reason' => $json['reason'] ?? null,
            'via' => $json['via'] ?? null,
            'estimated_pages' => $json['estimated_pages'] ?? null,
            'estimated_cost_usd' => $json['estimated_cost_usd'] ?? null,
            'confirm_token' => $json['confirm_token'] ?? null,
        ], fn ($v) => $v !== null) + ['book' => $json['book'] ?? $book, 'status' => $json['status'] ?? 'unknown']);
    }
}
