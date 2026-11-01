<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\InferenceTicketController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * BYO-model loop, step 1. When a citation review is running with
 * use_my_model=true, its LLM steps are parked as work items for the caller.
 * This claims a batch and returns the prompts; answer EACH as instructed and
 * post the answer with submit_review_verdict. Only the caller's own work is
 * visible (RLS-scoped). Keep calling until get_citation_review says completed.
 */
#[IsReadOnly]
class ClaimReviewWorkTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'claim_review_work';

    protected string $description = 'Claim a batch of analysis prompts parked by a use_my_model citation review. Returns [{work_id, messages}] — answer each prompt yourself (follow its instructions/format exactly, e.g. return the requested JSON), then call submit_review_verdict(work_id, answer). Returns an empty list when there is nothing to do right now (the review may be fetching sources — wait briefly and claim again, or poll get_citation_review).';

    public function schema(JsonSchema $schema): array
    {
        return [
            'limit' => $schema->integer()->description('Max prompts to claim at once (1-8, default 4).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $limit = min(8, max(1, (int) $request->get('limit', 4)));

        $result = InternalCall::call(InferenceTicketController::class, 'claim', [
            'feature' => 'ai_review',
            'limit' => $limit,
        ], $this->user($request));

        if ($error = $this->errorFrom($result, 'claim review work')) {
            return $error;
        }

        $tickets = $result['json']['tickets'] ?? [];
        $work = collect($tickets)->map(function ($t) {
            $req = $t['request'] ?? [];
            if (is_string($req)) {
                $req = json_decode($req, true) ?: [];
            }

            return [
                'work_id' => $t['id'] ?? null,
                // The engineered prompt to answer. Produce the completion the
                // assistant turn would — honour the system instructions and
                // any requested output format exactly.
                'messages' => $req['messages'] ?? [],
            ];
        })->all();

        return Response::json([
            'work' => $work,
            'count' => count($work),
            'note' => $work === []
                ? 'Nothing to answer yet. If the review is still running (get_citation_review), wait a few seconds and claim again.'
                : 'Answer each item\'s prompt and submit with submit_review_verdict(work_id, answer). Claimed items expire in ~15 minutes.',
        ]);
    }
}
