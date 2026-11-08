<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\DbLibraryController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use App\Support\Licenses;
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

    protected string $description = 'Set a book\'s visibility (public/private) and/or its licence, for books the user owns. Publishing can be refused by the publish gate (e.g. unverified email) — the refusal reason is reported honestly. Licence codes: CC-BY-SA-4.0-NO-AI (Hyperlit default), CC-BY-4.0, CC-BY-SA-4.0, CC-BY-NC-4.0, CC-BY-ND-4.0, CC-BY-NC-SA-4.0, CC-BY-NC-ND-4.0 (also -3.0/-2.5/-2.0/-1.0), CC0, PDM (public domain), All-Rights-Reserved, Unknown, custom. For a custom licence pass license=custom plus license_book (a PUBLIC book you own that holds the terms — the work is pinned to the terms as they read now) and/or license_url (an external terms page); custom_license_text is a short plain-text summary.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('Book id (book_…) or URL slug — must be a book the user owns.'),
            'visibility' => $schema->string()->enum(['public', 'private'])->description('New visibility.'),
            'license' => $schema->string()->description('Licence code (see description).'),
            'custom_license_text' => $schema->string()->description('Short plain-text summary of a custom licence.'),
            'license_book' => $schema->string()->description('For license=custom: id or slug of a PUBLIC book you own that holds the licence terms.'),
            'license_url' => $schema->string()->description('For license=custom: an http(s) URL of external licence terms.'),
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
            'license' => 'nullable|string|max:100',
            'custom_license_text' => 'nullable|string|max:5000',
            'license_book' => 'nullable|string|max:255',
            'license_url' => 'nullable|url:http,https|max:1000',
        ]);

        $licenseFields = ['license', 'custom_license_text', 'license_book', 'license_url'];
        if ($request->get('visibility') === null && collect($licenseFields)->every(fn ($f) => $request->get($f) === null)) {
            return Response::error('Pass visibility and/or a licence — there is nothing to change.');
        }

        // Refuse a code outside the vocabulary rather than letting the server file it as custom
        // text: from an agent, an unknown code is almost always a typo.
        $license = $request->get('license');
        if ($license !== null && Licenses::canonicalCode($license) === null) {
            return Response::error("Unknown licence code '{$license}'. Use one of: ".implode(', ', array_filter(
                Licenses::codes(), fn ($c) => Licenses::info($c)['selectable']
            )).' (CC codes also come in -3.0/-2.5/-2.0/-1.0).');
        }
        $customBits = $request->get('license_book') !== null || $request->get('license_url') !== null;
        if ($customBits && Licenses::canonicalCode($license ?? '') !== Licenses::CUSTOM) {
            return Response::error('license_book / license_url only apply with license=custom.');
        }

        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $data = ['book' => $bookId];
        foreach (['visibility', 'license', 'custom_license_text', 'license_url'] as $field) {
            if ($request->get($field) !== null) {
                $data[$field] = $request->get($field);
            }
        }
        if ($request->get('license_book') !== null) {
            [$licenseBookId, $lbRefusal] = $this->resolveBook((string) $request->get('license_book'));
            if ($lbRefusal) {
                return $lbRefusal;
            }
            $data['license_book'] = $licenseBookId;
        }

        // Bump library.timestamp: it is the freshness signal every client compares
        // against its IndexedDB copy (and BookCache against its prerender). Without it
        // an MCP edit lands in Postgres while every open/returning browser keeps
        // showing the old card until its cache is wiped (prod 2026-11-07: /terms
        // retitled via MCP, only a private window saw it).
        $data['timestamp'] = (int) round(microtime(true) * 1000);

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

        // The server silently refuses a licence book that is not the caller's own public,
        // unencrypted book (sync payloads must not hard-fail) — say so instead of "applied".
        if (isset($data['license_book']) && (($json['library']['license_book'] ?? null) !== $data['license_book'])) {
            return Response::error('The licence book was refused: it must be a PUBLIC, unencrypted book that you own. Other changes were applied.');
        }

        return Response::json([
            'book' => $bookId,
            'applied' => array_keys(array_diff_key($data, ['book' => true, 'timestamp' => true])),
            'library' => $json['library'] ?? null,
        ]);
    }
}
