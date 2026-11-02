<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\BookAudioController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/** Stops a running narration; unspent reserved credits are released by the job. */
#[IsIdempotent]
class CancelAudiobookTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::SPEND;

    protected string $name = 'cancel_audiobook';

    protected string $description = 'Cancel a running audiobook narration (started with create_audiobook). Already-narrated nodes are kept and stay billed; the unspent credit reservation is released.';

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
        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $result = InternalCall::call(BookAudioController::class, 'cancel', [], $this->user($request), [$bookId]);
        if ($error = $this->errorFrom($result, 'cancel the narration')) {
            return $error;
        }

        return Response::json([
            'book' => $bookId,
            'cancelled' => true,
            'detail' => $result['json'] ?? null,
        ]);
    }
}
