<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\BookAudioController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use App\Services\BillingService;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Per-node TTS narration for a book — requester-pays, so this follows the same
 * estimate→confirm flow as import_document's PDF path: a bare call returns the
 * price and a confirm instruction; confirm:true reserves credits and queues
 * GenerateBookAudioJob. The tool never touches the narrated text itself —
 * SpeakableText output IS the per-node source_hash, so staleness/counting is
 * entirely the server's business (docs/audio.md).
 */
#[IsIdempotent(false)]
class CreateAudiobookTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::SPEND;

    protected string $name = 'create_audiobook';

    protected string $description = 'Generate (or resume/top-up) TTS narration for a book — one MP3 per paragraph, playable in the reader. PAID: bills the user\'s credits per character narrated (check get_credit_balance first). Call WITHOUT confirm to get the cost estimate; call again with confirm:true to start. Generation is a background job — poll get_audiobook_status. Already-narrated, unchanged nodes are never re-billed.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug.'),
            'confirm' => $schema->boolean()->description('true = reserve credits and start generating. Omit to get the estimate first.'),
            'voice' => $schema->string()->description('Optional TTS voice id; omit for the default (or the book\'s existing voice).'),
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

        $user = $this->user($request);

        $status = InternalCall::call(BookAudioController::class, 'status', [], $user, [$bookId]);
        if ($error = $this->errorFrom($status, 'estimate the audiobook')) {
            return $error;
        }
        $s = $status['json'] ?? [];

        if (! $request->boolean('confirm')) {
            $billable = (int) ($s['missing_chars'] ?? 0) + (int) ($s['stale_chars'] ?? 0);

            return Response::json([
                'book' => $bookId,
                'estimated_cost_usd' => $s['estimated_cost_user'] ?? null,
                'billable_chars' => $billable,
                'nodes_to_narrate' => max(0, (int) ($s['total_nodes'] ?? 0) - (int) ($s['audio_nodes'] ?? 0)) + (int) ($s['stale_nodes'] ?? 0),
                'already_narrated_nodes' => $s['audio_nodes'] ?? 0,
                'generating' => $s['generating'] ?? false,
                'next' => $billable === 0
                    ? 'Nothing to narrate — the book is fully narrated and fresh.'
                    : 'Tell the user the price. To proceed, call create_audiobook again with confirm:true.',
            ]);
        }

        if (($s['generating'] ?? false) === true) {
            return Response::error('Narration is already running for this book — poll get_audiobook_status, or cancel_audiobook first.');
        }

        $input = [];
        if (trim((string) $request->get('voice', '')) !== '') {
            $input['voice'] = trim((string) $request->get('voice'));
        }

        $result = InternalCall::call(
            BookAudioController::class, 'generate', $input, $user, [app(BillingService::class), $bookId]
        );
        if ($result['status'] === 402) {
            return Response::error($result['json']['message'] ?? 'Insufficient balance — top up in Account → Money, or check get_credit_balance.');
        }
        if ($error = $this->errorFrom($result, 'start the audiobook')) {
            return $error;
        }
        if (($result['json']['success'] ?? true) === false) {
            return Response::error($result['json']['message'] ?? 'Narration was not started.');
        }

        return Response::json([
            'book' => $bookId,
            'started' => true,
            'next' => 'Generation runs in the background — poll get_audiobook_status('.$bookId.') for progress, the per-node manifest, and playback URLs.',
        ]);
    }
}
