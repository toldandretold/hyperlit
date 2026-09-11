<?php

namespace App\Http\Controllers;

use App\Models\PgLibrary;
use App\Services\BillingService;
use App\Services\E2ee\EncryptedBookGuard;
use App\Services\Llm\ClientInferenceUnavailableException;
use App\Services\Llm\ClientTicketTransport;
use App\Services\LlmService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * The AI tier of "auto metadata" — read a document's opening and recover its
 * title / author / year so a library card stops saying "anon, Untitled (2026)".
 *
 * SCOPE: this reads text and returns fields. It writes NOTHING. The client shows
 * the answer as a proposal the user confirms, and the actual write goes through
 * the normal /api/db/library/upsert path, so there is one library write path and
 * ownership/staleness rules are enforced in one place.
 *
 * WHY CLIENT-SUPPLIED TEXT: the request carries the plain text rather than a
 * book id to read server-side. Same shape as TranslationController — stateless,
 * no RLS dance over `nodes`, and the model sees exactly what the user is looking
 * at. The book id still travels, because the guards below need it.
 *
 * WHY OWNER-ONLY (unlike translation): translating a stranger's public passage
 * is legitimate; spending credits to rewrite a stranger's library card is not.
 *
 * BILLING SHAPE: charged AFTER the work succeeds, never before. A null or
 * unparseable model response returns 422 and leaves no ledger row. Waived under
 * BYO, where the user's own key paid.
 *
 * NO QUEUE WORKER HERE, so the RLS trap that has shipped twice does not apply:
 * BillingService::charge() sets app.current_user but the users policy also needs
 * app.current_token, which HTTP middleware provides and a worker does not. If
 * this ever becomes a job it must set BOTH and restore them (see
 * CitationReviewCommand::billReview for the restoring variant).
 */
class CitationMetadataController extends Controller
{
    /** Hard ceiling on a single request. The client caps at 6000. */
    private const MAX_INPUT_CHARS = 8000;

    /**
     * gpt-oss reasoning tokens share this budget with the JSON, so it is sized
     * for the answer plus low-effort reasoning — not padding.
     */
    private const MAX_OUTPUT_TOKENS = 700;

    private const SYSTEM_PROMPT = <<<'PROMPT'
You are reading the opening of a document to recover its bibliographic metadata.
Return ONLY valid JSON, no prose, no code fence:
{"title": string|null, "author": string|null, "year": integer|null,
 "type": "book"|"article"|"incollection"|"phdthesis"|"misc"|null,
 "journal": string|null, "publisher": string|null,
 "self_authored": true|false, "confidence": "high"|"medium"|"low"}

Rules:
- Use ONLY what the text itself states or clearly implies. Never guess from
  general knowledge, and never invent a plausible-sounding author or year. Any
  field you cannot ground in the text MUST be null.
- "title": the work's own title, usually the first heading or a title block. Do
  not use a chapter or section heading when a document title is present, and
  never use a running header, "Contents", "Abstract", or a page number.
- "author": ONLY when the text names its own author — a byline, "by X", a
  title-page author block, a signature, an email/affiliation block, or a
  copyright line. If this reads like somebody's own notes, a draft, a to-do
  list, a journal entry or a transcript, and no author is named, set
  "author": null and "self_authored": true. When in doubt prefer null.
- Write the author as it appears, e.g. "Ursula K. Le Guin". Join multiple
  authors with "; " (semicolon + space) and include EVERY named author. Do not
  reformat to "Lastname, Firstname".
- "year": the publication or copyright year stated in the text, as an integer. A
  date occurring inside the prose (a diary entry, a quoted letter) is NOT a
  publication year — return null rather than that.
- "journal" only for a journal article. "publisher" only when the text names
  one. Otherwise null.
- "confidence": "high" only when a title AND (an author or a year) are
  explicitly present in the text.
PROMPT;

    public function extract(
        Request $request,
        BillingService $billingService,
        LlmService $llmService,
    ): JsonResponse {
        $user = Auth::user();
        if (! $user) {
            return response()->json(['success' => false, 'message' => 'Authentication required'], 401);
        }

        $data = $request->validate([
            'book' => 'required|string|max:255',
            'text' => 'required|string|max:'.self::MAX_INPUT_CHARS,
            'client_inference' => 'sometimes|boolean',
        ]);

        $bookId = $data['book'];
        $clientInference = $request->boolean('client_inference');

        // Encrypted books must never have their plaintext reach us — the same
        // rule as translation, narration and the AI brain. (isEncrypted resolves
        // `book_<parent>/Fn<id>` sub-books to their root itself.) The client's
        // FREE local tier still works for these; it never leaves the browser.
        if (EncryptedBookGuard::isEncrypted($bookId)) {
            return response()->json([
                'success' => false,
                'message' => 'Encrypted books cannot use server-side metadata extraction',
            ], 403);
        }

        // RLS visibility: an invisible book reads as nonexistent.
        $library = PgLibrary::where('book', $bookId)->first();
        if (! $library) {
            return response()->json(['success' => false, 'message' => 'Book not found.'], 404);
        }

        if ($library->creator !== $user->name) {
            return response()->json([
                'success' => false,
                'message' => 'Only the owner can change this library card.',
            ], 403);
        }

        $billable = ! $clientInference;

        if ($billable && ! $billingService->canProceed($user)) {
            return response()->json(['success' => false, 'message' => 'Insufficient balance'], 402);
        }

        $text = trim(mb_substr($data['text'], 0, self::MAX_INPUT_CHARS));
        if ($text === '') {
            return response()->json([
                'success' => false,
                'message' => 'Nothing readable in the supplied text.',
            ], 422);
        }

        // Usage is read AFTER the call to price it; reset first so a previous
        // request's counters on this SINGLETON can't be billed to this user.
        if ($billable) {
            $llmService->resetUsageStats();
        }

        if ($clientInference) {
            $llmService->setTransport(new ClientTicketTransport(
                $user->name,
                'citation_meta',
                contextId: $bookId,
                ttlSeconds: 300,
                waitTimeoutSeconds: 90,
            ));
        }

        try {
            $raw = $llmService->chat(
                self::SYSTEM_PROMPT,
                $text,
                0.0,
                self::MAX_OUTPUT_TOKENS,
                config('services.llm.extraction_model'),
                30,
                'none',
            );
        } catch (ClientInferenceUnavailableException $e) {
            // The client never picked the ticket up (app closed, no key, timed
            // out). Not our failure and not the user's balance — say so plainly.
            return response()->json([
                'success' => false,
                'message' => 'Your own AI model did not respond: '.$e->getMessage(),
            ], 503);
        } finally {
            // MANDATORY: LlmService is a singleton, so a leaked transport would
            // ticketise the next unrelated request's LLM calls.
            if ($clientInference) {
                $llmService->clearTransport();
            }
        }

        $metadata = $this->parseResponse($raw);
        if ($metadata === null) {
            // No usable work happened, so nothing is charged.
            return response()->json([
                'success' => false,
                'message' => 'Could not read metadata from this text.',
            ], 422);
        }

        $cost = null;
        $charged = null;
        if ($billable) {
            $cost = $this->calculateCost($llmService->getUsageStats());
            $entry = $billingService->charge(
                $user,
                $cost,
                'Auto metadata: '.Str::limit($metadata['title'] ?? $bookId, 40),
                'citation_meta',
                [],
                [
                    'book' => $bookId,
                    'model' => config('services.llm.extraction_model'),
                    'chars' => mb_strlen($text),
                ],
            );
            // The POST-multiplier figure, straight off the ledger row. Returned
            // so the client can state what was actually charged without keeping
            // its own copy of the tier table to drift out of sync.
            $charged = (float) $entry->amount;
        }

        return response()->json([
            'success' => true,
            'metadata' => $metadata,
            'cost' => $cost,
            'charged' => $charged,
        ]);
    }

    /**
     * Fence-strip + decode, the same idiom as LlmService::extractCitationMetadata.
     * Returns null when the model gave us nothing usable — which the caller turns
     * into a 422 BEFORE charging.
     */
    private function parseResponse(?string $raw): ?array
    {
        if (! $raw) {
            return null;
        }

        $raw = trim($raw);
        $raw = preg_replace('/^```(?:json)?\s*/i', '', $raw);
        $raw = preg_replace('/\s*```$/', '', $raw);

        $parsed = json_decode($raw, true);
        if (! is_array($parsed)) {
            Log::warning('Auto metadata: invalid JSON response', ['raw' => Str::limit($raw, 500)]);

            return null;
        }

        $str = function ($v): ?string {
            if (! is_string($v)) {
                return null;
            }
            $v = trim($v);

            return $v === '' ? null : $v;
        };

        $type = $str($parsed['type'] ?? null);
        $confidence = $str($parsed['confidence'] ?? null);

        $metadata = [
            'title' => $str($parsed['title'] ?? null),
            'author' => $str($parsed['author'] ?? null),
            'year' => is_numeric($parsed['year'] ?? null) ? (int) $parsed['year'] : null,
            'type' => in_array($type, ['book', 'article', 'incollection', 'phdthesis', 'misc'], true) ? $type : null,
            'journal' => $str($parsed['journal'] ?? null),
            'publisher' => $str($parsed['publisher'] ?? null),
            'self_authored' => ($parsed['self_authored'] ?? false) === true,
            'confidence' => in_array($confidence, ['high', 'medium', 'low'], true) ? $confidence : 'medium',
        ];

        // An answer of all-nulls is a failure, not a result — charging for it
        // would bill the user for "the model found nothing".
        $hasSomething = $metadata['title'] !== null
            || $metadata['author'] !== null
            || $metadata['year'] !== null
            || $metadata['journal'] !== null
            || $metadata['publisher'] !== null;

        return $hasSomething ? $metadata : null;
    }

    /**
     * Price the tokens LlmService actually recorded. Mirrors
     * TranslationController::calculateCost.
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
                Log::warning('Auto metadata: no pricing entry for model — usage uncounted', [
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
