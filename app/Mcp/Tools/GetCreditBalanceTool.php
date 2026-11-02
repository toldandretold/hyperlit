<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\BillingController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Affordability check for the spend tools (create_audiobook, PDF import,
 * citation review, translate_passage) — read-only; a token with only `read`
 * can check the balance without being able to spend it.
 */
#[IsReadOnly]
class GetCreditBalanceTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'get_credit_balance';

    protected string $description = 'The user\'s current credit balance and billing tier multiplier. Check this BEFORE any paid tool (create_audiobook, PDF import confirm, run_citation_review, translate_passage) so you can tell the user whether they can afford it. Top-ups happen in the web app (Account → Money).';

    public function schema(JsonSchema $schema): array
    {
        return [];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $user = $this->user($request);
        $result = InternalCall::call(BillingController::class, 'balance', [], $user);
        if ($error = $this->errorFrom($result, 'read the balance')) {
            return $error;
        }

        return Response::json(array_merge($result['json'] ?? [], [
            'tier_multiplier' => $user->getBillingMultiplier(),
            'note' => 'Paid tools quote prices already adjusted to this user\'s tier.',
        ]));
    }
}
