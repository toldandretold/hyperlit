<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\NotificationController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/** RLS scopes rows to the recipient — the controller adds pagination. */
#[IsReadOnly]
class ListNotificationsTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::READ;

    protected string $name = 'list_notifications';

    protected string $description = 'The user\'s notifications (someone cited their book, liked it, published a citing book, …), newest first, with unread count. Paginate with offset. Mark them handled with mark_notifications_read.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'offset' => $schema->integer()->description('Pagination offset (default 0).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $result = InternalCall::call(NotificationController::class, 'index', [
            'offset' => max(0, (int) $request->get('offset', 0)),
        ], $this->user($request));
        if ($error = $this->errorFrom($result, 'list notifications')) {
            return $error;
        }

        return Response::json($result['json'] ?? []);
    }
}
