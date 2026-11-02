<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\TranslationController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use App\Services\BillingService;
use App\Services\LlmService;
use App\Services\Translation\LanguageRegistry;
use App\Services\Translation\TranslationService;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Passage translation through the server's provider seam. Conditionally
 * billed: free while services.translation.passages_free (the default) or when
 * the provider itself is free; billable otherwise — hence the spend ability.
 * The response's honesty flags (unverified / wrong_script) pass through
 * verbatim: a fluent answer in the WRONG SCRIPT is the classic failure, and
 * the caller must see it, not a cleaned-up lie.
 */
#[IsReadOnly]
class TranslatePassageTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::SPEND;

    protected string $name = 'translate_passage';

    protected string $description = 'Translate a passage of text via Hyperlit\'s translation provider. Language codes are script-aware BCP-47 (e.g. "fr", "zh-Hans", "pa-Guru" vs "pa-Arab"). Usually FREE (server absorbs passage costs by default) but may bill credits depending on configuration — check get_credit_balance if unsure. The response carries script-verification flags; report them honestly.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'text' => $schema->string()->min(1)->required()->description('The passage to translate (plain text).'),
            'target_lang' => $schema->string()->required()->description('Target language code (script-aware, e.g. "es", "zh-Hans", "pa-Arab").'),
            'source_lang' => $schema->string()->description('Optional source language code; omit to auto-detect.'),
            'book' => $schema->string()->description('Optional book id/slug the passage came from (gates like audio: encrypted books refuse).'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate([
            'text' => 'required|string|max:20000',
            'target_lang' => 'required|string|max:32',
            'source_lang' => 'nullable|string|max:32',
            'book' => 'nullable|string',
        ]);

        $input = [
            'text' => $request->get('text'),
            'target_lang' => $request->get('target_lang'),
            'client_inference' => false,
        ];
        if ($request->get('source_lang')) {
            $input['source_lang'] = $request->get('source_lang');
        }
        if (trim((string) $request->get('book', '')) !== '') {
            [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
            if ($refusal) {
                return $refusal;
            }
            $input['book'] = $bookId;
        }

        $user = $this->user($request);
        $services = [
            app(TranslationService::class),
            app(BillingService::class),
            app(LlmService::class),
            app(LanguageRegistry::class),
        ];

        $result = InternalCall::call(TranslationController::class, 'translate', $input, $user, $services);
        if ($result['status'] === 402) {
            return Response::error('Insufficient balance for translation — top up in Account → Money.');
        }
        if ($error = $this->errorFrom($result, 'translate the passage')) {
            return $error;
        }
        $json = $result['json'] ?? [];
        if (($json['success'] ?? false) !== true) {
            // An unsupported target language is the common miss — offer the registry.
            $langs = InternalCall::call(TranslationController::class, 'languages', [], $user, [app(TranslationService::class)]);

            return Response::error(($json['message'] ?? 'Translation failed.')
                .' Supported languages: '.json_encode($langs['json']['languages'] ?? $langs['json'] ?? []));
        }

        return Response::json($json);
    }
}
