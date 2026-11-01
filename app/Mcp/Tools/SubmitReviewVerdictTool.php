<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\InferenceTicketController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * BYO-model loop, step 2. Post the answer to one prompt claimed via
 * claim_review_work. The review's LLM step unblocks and continues.
 * Idempotent — re-submitting a settled item is a no-op.
 */
#[IsIdempotent]
class SubmitReviewVerdictTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'submit_review_verdict';

    protected string $description = 'Post your answer to one analysis prompt from claim_review_work. Pass the work_id and your completion (the text the assistant turn would produce for that prompt — match any requested format exactly). Report `error` instead if you genuinely cannot answer it.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'work_id' => $schema->string()->required()->description('The work_id from claim_review_work.'),
            'answer' => $schema->string()->description('Your completion for the prompt (required unless reporting error).'),
            'error' => $schema->string()->description('Set this instead of answer if the prompt cannot be answered.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['work_id' => 'required|string']);
        $workId = (string) $request->get('work_id');
        $answer = (string) $request->get('answer', '');
        $error = (string) $request->get('error', '');

        if (trim($answer) === '' && trim($error) === '') {
            return Response::error('Provide an `answer` (your completion) or an `error`.');
        }

        $input = $error !== '' ? ['error' => $error] : ['content' => $answer];

        $result = InternalCall::call(
            InferenceTicketController::class, 'complete', $input, $this->user($request), [$workId]
        );

        if ($result['status'] === 404) {
            return Response::error('That work_id is unknown (or not yours).');
        }
        if ($err = $this->errorFrom($result, 'submit the answer')) {
            return $err;
        }

        return Response::json([
            'work_id' => $workId,
            'status' => $result['json']['status'] ?? 'completed',
        ]);
    }
}
