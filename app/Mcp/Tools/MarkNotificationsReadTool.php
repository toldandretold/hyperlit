<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\NotificationController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

#[IsIdempotent]
class MarkNotificationsReadTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::ANNOTATE;

    protected string $name = 'mark_notifications_read';

    protected string $description = 'Mark ALL of the user\'s notifications as read (the same action as opening the bell in the web app).';

    public function schema(JsonSchema $schema): array
    {
        return [];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $result = InternalCall::call(NotificationController::class, 'markRead', [], $this->user($request));
        if ($error = $this->errorFrom($result, 'mark notifications read')) {
            return $error;
        }

        return Response::json(array_merge(['done' => true], $result['json'] ?? []));
    }
}
