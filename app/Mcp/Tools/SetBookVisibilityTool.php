<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DbLibraryController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Visibility + license through DbLibraryController::upsert, which merges with
 * the stored record (partial payloads are safe). CRITICAL: the publish gate
 * fails SOFT — a refused publish CLAMPS to the stored value and returns 200
 * with publish_denied set, so this tool must check that field and report a
 * refusal, never success.
 */
#[IsIdempotent]
class SetBookVisibilityTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::WRITE;

    protected string $name = 'set_book_visibility';

    protected string $description = 'Set a book\'s visibility (public/private) and/or its license, for books the user owns. Publishing can be refused by the publish gate (e.g. unverified email) — the refusal reason is reported honestly. Licenses are SPDX-ish strings as used in the web UI (e.g. CC-BY-SA-4.0-NO-AI); custom_license_text for a bespoke license.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug — must be a book the user owns.'),
            'visibility' => $schema->string()->enum(['public', 'private'])->description('New visibility.'),
            'license' => $schema->string()->description('License identifier.'),
            'custom_license_text' => $schema->string()->description('Free-text license (pairs with a custom license).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate([
            'book' => 'required|string',
            'visibility' => 'nullable|in:public,private',
            'license' => 'nullable|string|max:120',
            'custom_license_text' => 'nullable|string|max:5000',
        ]);

        if ($request->get('visibility') === null && $request->get('license') === null && $request->get('custom_license_text') === null) {
            return Response::error('Pass visibility and/or license — there is nothing to change.');
        }

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $data = ['book' => $bookId];
        foreach (['visibility', 'license', 'custom_license_text'] as $field) {
            if ($request->get($field) !== null) {
                $data[$field] = $request->get($field);
            }
        }

        $result = InternalCall::call(DbLibraryController::class, 'upsert', ['data' => $data], $this->user($request));
        if ($error = $this->errorFrom($result, 'update the book')) {
            return $error;
        }
        $json = $result['json'] ?? [];
        if (($json['success'] ?? false) !== true) {
            return Response::error($json['message'] ?? 'The update was not applied.');
        }

        // The publish gate clamps instead of erroring — surface it as a refusal.
        if (! empty($json['publish_denied'])) {
            return Response::error('Publishing was refused: '.(is_string($json['publish_denied'])
                ? $json['publish_denied']
                : json_encode($json['publish_denied'])).' The book\'s visibility is unchanged.');
        }

        return Response::json([
            'book' => $bookId,
            'applied' => array_keys(array_diff_key($data, ['book' => true])),
            'library' => $json['library'] ?? null,
        ]);
    }
}
