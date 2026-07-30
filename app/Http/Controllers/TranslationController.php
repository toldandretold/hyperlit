<?php

namespace App\Http\Controllers;

use App\Models\PgLibrary;
use App\Services\BillingService;
use App\Services\E2ee\EncryptedBookGuard;
use App\Services\Llm\ClientInferenceUnavailableException;
use App\Services\Llm\ClientTicketTransport;
use App\Services\LlmService;
use App\Services\Translation\LanguageRegistry;
use App\Services\Translation\Providers\HostedProvider;
use App\Services\Translation\TranslatableText;
use App\Services\Translation\TranslationPrompt;
use App\Services\Translation\TranslationProviderException;
use App\Services\Translation\TranslationService;
use App\Services\Translation\UnsupportedLanguageException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * Synchronous passage translation.
 *
 * SCOPE: this translates text handed to it and returns the result. It does not
 * persist anything, so nothing here touches annotation offsets — the reason
 * whole-book/replacement reading modes are a separate piece of work is that they
 * DO, and `charData`'s per-node character ranges have to be realigned before a
 * translated node can stand in for the original.
 *
 * BILLING SHAPE: charged AFTER the work succeeds, never before, matching every
 * other paid feature. Waived under BYO (the user's own key paid) and for
 * providers that cost us nothing per token — a local Ollama, or a dedicated
 * endpoint billed by the GPU-hour where no honest per-token rate exists.
 *
 * NO QUEUE WORKER HERE, so the RLS trap that has shipped twice does not apply:
 * BillingService::charge() sets app.current_user but the users policy also needs
 * app.current_token, which HTTP middleware provides and a worker does not. The
 * moment a whole-book translation JOB exists it must set both and restore them
 * (see CitationReviewCommand::billReview for the restoring variant).
 */
class TranslationController extends Controller
{
    /** Hard ceiling on a single request, independent of the provider's own cap. */
    private const MAX_INPUT_CHARS = 20000;

    public function translate(
        Request $request,
        TranslationService $translation,
        BillingService $billingService,
        LlmService $llmService,
        LanguageRegistry $registry,
    ): JsonResponse {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }

        $data = $request->validate([
            'text' => 'required|string|max:'.self::MAX_INPUT_CHARS,
            'target_lang' => 'required|string|max:32',
            'source_lang' => 'nullable|string|max:32',
            'book' => 'nullable|string|max:255',
            'client_inference' => 'sometimes|boolean',
        ]);

        $clientInference = $request->boolean('client_inference');

        // Book context is optional (a selection can be translated without one),
        // but when given it gates exactly as audio does.
        if (! empty($data['book'])) {
            $book = $data['book'];

            // Encrypted books cannot be translated server-side for the same
            // reason they cannot be narrated: their plaintext must never reach
            // us. The local/on-device provider is the only path for those.
            // (isEncrypted resolves `book_<parent>/Fn<id>` sub-books to their
            // root itself, so a footnote of an encrypted book is caught too.)
            if (EncryptedBookGuard::isEncrypted($book)) {
                return response()->json([
                    'success' => false,
                    'message' => 'Encrypted books cannot use server-side translation',
                ], 403);
            }

            // RLS visibility: an invisible book reads as nonexistent.
            if (! PgLibrary::where('book', $book)->exists()) {
                return response()->json(['success' => false, 'message' => 'Book not found.'], 404);
            }
        }

        // BYO replaces the provider entirely: the user's own model answers, and
        // the ONLY shape that can be ticketised is the hosted one (the transport
        // is checked inside LlmService, which the local/dedicated providers
        // deliberately bypass). So swap in a hosted service for this request
        // rather than silently ignoring client_inference.
        $service = $clientInference
            ? $this->hostedServiceFor($llmService, $registry)
            : $translation;

        $provider = $service->provider();
        $billable = $provider->isBillable() && ! $clientInference;

        if ($billable && ! $billingService->canProceed($user)) {
            return response()->json(['success' => false, 'message' => 'Insufficient balance'], 402);
        }

        $text = $this->normalizeInput($data['text']);
        if ($text === '') {
            return response()->json([
                'success' => false,
                'message' => 'Nothing translatable in the supplied text.',
            ], 422);
        }

        // Usage is read AFTER the call to price it; reset first so a previous
        // request's counters on this singleton can't be billed to this user.
        if ($billable) {
            $llmService->resetUsageStats();
        }

        if ($clientInference) {
            $llmService->setTransport(new ClientTicketTransport(
                $user->name,
                'translation',
                contextId: null,
                ttlSeconds: (int) config('services.translation.byo_ttl_seconds', 300),
                waitTimeoutSeconds: (int) config('services.translation.byo_wait_seconds', 90),
            ));
        }

        try {
            $result = $service->translate(
                $text,
                $data['target_lang'],
                $data['source_lang'] ?? null,
            );
        } catch (UnsupportedLanguageException $e) {
            return response()->json([
                'success' => false,
                'message' => $e->getMessage(),
                'reason' => $e->reason,
                'requested' => $e->requestedCode,
            ], 422);
        } catch (ClientInferenceUnavailableException $e) {
            // The client never picked the ticket up (app closed, no key, timed
            // out). Not our failure and not the user's balance — say so plainly.
            return response()->json([
                'success' => false,
                'message' => 'Your own translation model did not respond: '.$e->getMessage(),
            ], 503);
        } catch (TranslationProviderException $e) {
            Log::warning('Translation failed', [
                'provider' => $provider::class,
                'model' => $provider->modelId(),
                'message' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'message' => 'Translation failed: '.$e->getMessage(),
            ], 502);
        } finally {
            // MANDATORY: LlmService is a singleton, so a leaked transport would
            // ticketise the next unrelated request's LLM calls.
            if ($clientInference) {
                $llmService->clearTransport();
            }
        }

        $cost = null;
        if ($billable) {
            $cost = $this->calculateCost($llmService->getUsageStats());
            $billingService->charge(
                $user,
                $cost,
                'Translation to '.$registry->promptName($result->targetLang).': '.Str::limit($text, 40),
                'translation',
                [],
                [
                    'target_lang' => $result->targetLang,
                    'source_lang' => $result->sourceLang,
                    'model' => $result->model,
                    'chars' => mb_strlen($text),
                    'book_id' => $data['book'] ?? null,
                ],
            );
        } elseif ($clientInference) {
            Log::info('Translation: BYO client inference — charge waived');
        }

        return response()->json([
            'success' => true,
            'translation' => $result->toArray(),
            // Surfaced so a UI can warn honestly rather than presenting an
            // unproven translation as sound.
            'unverified' => $result->tier === LanguageRegistry::TIER_UNVERIFIED,
            // The model answered in the wrong writing system (Shahmukhi asked
            // for, Gurmukhi or transliterated Latin returned). Fluent, confident
            // and wrong — a UI must not present this as a clean result.
            'wrong_script' => ! $result->scriptOk,
            'cost' => $cost,
        ]);
    }

    /** The languages this deployment can be asked for, for a UI picker. */
    public function languages(TranslationService $translation): JsonResponse
    {
        $provider = $translation->provider();
        $registry = $translation->registry();
        $family = $registry->familyForModel($provider->modelId());

        $languages = [];
        foreach ($registry->all() as $lang) {
            $tier = $registry->tier($lang['code'], $family);
            if ($tier === LanguageRegistry::TIER_UNSUPPORTED) {
                continue;
            }
            $languages[] = $lang + ['tier' => $tier];
        }

        return response()->json([
            'success' => true,
            'model' => $provider->modelId(),
            'family' => $family,
            'languages' => $languages,
        ]);
    }

    /**
     * A hosted service instance, used for the BYO path regardless of the
     * configured provider (see the call site).
     */
    private function hostedServiceFor(LlmService $llmService, LanguageRegistry $registry): TranslationService
    {
        return new TranslationService(
            new HostedProvider($llmService, $registry, app(TranslationPrompt::class)),
            $registry,
        );
    }

    /**
     * Callers may send either plain text or a selection's HTML. HTML is routed
     * through TranslatableText so markup, footnote markers and hypercite arrows
     * never reach the model or the response.
     *
     * Plain text is passed through UNCHANGED on purpose: TranslatableText
     * collapses whitespace, which would flatten deliberate paragraph breaks —
     * and those breaks are both meaningful to the translation and the preferred
     * split boundary for long passages.
     */
    private function normalizeInput(string $text): string
    {
        $looksLikeHtml = $text !== strip_tags($text);

        return $looksLikeHtml ? TranslatableText::fromContent($text) : trim($text);
    }

    /**
     * Price the tokens LlmService actually recorded. Mirrors
     * AiBrainController::calculateCost, minus embeddings (translation runs none).
     *
     * A model with no pricing entry contributes 0 — which would silently
     * under-bill, so it is logged loudly rather than passing quietly.
     */
    private function calculateCost(array $usageStats): float
    {
        $pricing = config('services.llm.pricing');
        $total = 0.0;

        foreach ($usageStats['by_model'] ?? [] as $model => $usage) {
            $modelPricing = $pricing[$model] ?? null;
            if (! $modelPricing) {
                Log::warning('Translation: no pricing entry for model — usage uncounted', [
                    'model' => $model,
                    'prompt_tokens' => $usage['prompt_tokens'] ?? 0,
                    'completion_tokens' => $usage['completion_tokens'] ?? 0,
                ]);

                continue;
            }

            $total += ($usage['prompt_tokens'] / 1_000_000) * ($modelPricing['input'] ?? 0);
            $total += ($usage['completion_tokens'] / 1_000_000) * ($modelPricing['output'] ?? 0);
        }

        // Floor matches the other AI features: a successful call always leaves a
        // ledger trace, even when the true cost rounds to nothing.
        return max($total, 0.0001);
    }
}
