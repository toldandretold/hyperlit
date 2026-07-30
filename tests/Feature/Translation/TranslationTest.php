<?php

use App\Models\InferenceTicket;
use App\Services\LlmService;
use App\Services\Translation\LanguageRegistry;
use App\Services\Translation\Providers\HostedProvider;
use App\Services\Translation\Providers\OllamaProvider;
use App\Services\Translation\ScriptDetector;
use App\Services\Translation\TranslatableText;
use App\Services\Translation\TranslationPrompt;
use App\Services\Translation\TranslationProviderException;
use App\Services\Translation\TranslationProviderInterface;
use App\Services\Translation\TranslationResult;
use App\Services\Translation\TranslationService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * Translation plumbing: the provider seam, the language/script gates, the
 * gate ladder on POST /api/translate, and the billing + BYO-waiver semantics.
 *
 * No network anywhere — the hosted path fakes the LLM HTTP endpoint and the
 * local path fakes Ollama's.
 */

/** Fake an OpenAI-compatible chat/completions reply with fixed content. */
function fakeChatReply(string $content, int $promptTokens = 100, int $completionTokens = 50): array
{
    return [
        'choices' => [['message' => ['content' => $content]]],
        'usage' => ['prompt_tokens' => $promptTokens, 'completion_tokens' => $completionTokens],
    ];
}

function translationBook(): string
{
    return 'transrls_'.Str::lower(Str::random(10));
}

/**
 * Restore the RLS session context so post-request reads see the user's rows.
 *
 * MUST read on the DEFAULT connection, not pgsql_admin: billing_ledger and
 * inference_tickets rows are written in-request inside RefreshDatabase's
 * uncommitted transaction on `pgsql`, and a separate admin connection cannot
 * see them. (Admin-seeded fixture rows COMMIT, so those are visible either way —
 * which is exactly why this trips people up.)
 */
function actAsTranslationUser(\App\Models\User $user): void
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
}

// ── LanguageRegistry ────────────────────────────────────────────────────────

it('resolves script-split language codes and reports when it had to guess', function () {
    $r = app(LanguageRegistry::class);

    expect($r->normalize('pa-Arab'))->toBe('pa-Arab')
        ->and($r->normalize('PA_ARAB'))->toBe('pa-Arab')
        ->and($r->normalize('pa-pk'))->toBe('pa-Arab')
        ->and($r->normalize('zh-TW'))->toBe('zh-Hant')
        ->and($r->normalize('tl'))->toBe('fil')
        ->and($r->normalize('klingon'))->toBeNull();

    // A bare 'pa' is not a specification — it resolves, but says so.
    expect($r->normalize('pa'))->toBe('pa-Guru')
        ->and($r->isAmbiguousInput('pa'))->toBeTrue()
        ->and($r->isAmbiguousInput('pa-Arab'))->toBeFalse();
});

it('treats an enumerated model gap as unsupported but an unproven language as merely unverified', function () {
    $r = app(LanguageRegistry::class);

    // Hy-MT2 publishes 33 languages; Punjabi is enumerated as absent.
    expect($r->tier('pa-Guru', LanguageRegistry::FAMILY_HY_MT2))->toBe(LanguageRegistry::TIER_UNSUPPORTED)
        ->and($r->supports('pa-Guru', LanguageRegistry::FAMILY_HY_MT2))->toBeFalse()
        ->and($r->tier('hi', LanguageRegistry::FAMILY_HY_MT2))->toBe(LanguageRegistry::TIER_SUPPORTED);

    // TranslateGemma's benchmarked-55 list could not be sourced authoritatively,
    // so nothing is claimed — allowed, but flagged.
    expect($r->tier('pa-Guru', LanguageRegistry::FAMILY_TRANSLATEGEMMA))->toBe(LanguageRegistry::TIER_UNVERIFIED)
        ->and($r->supports('pa-Guru', LanguageRegistry::FAMILY_TRANSLATEGEMMA))->toBeTrue();

    // An unknown code is distinct from a model gap — different message, and
    // supports() refuses both.
    expect($r->tier('klingon', LanguageRegistry::FAMILY_GENERAL))->toBe(LanguageRegistry::TIER_UNKNOWN)
        ->and($r->supports('klingon', LanguageRegistry::FAMILY_GENERAL))->toBeFalse();
});

it('derives the model family from the model id', function () {
    $r = app(LanguageRegistry::class);

    expect($r->familyForModel('translategemma:12b'))->toBe(LanguageRegistry::FAMILY_TRANSLATEGEMMA)
        ->and($r->familyForModel('hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M'))->toBe(LanguageRegistry::FAMILY_HY_MT2)
        ->and($r->familyForModel('accounts/fireworks/models/gpt-oss-120b'))->toBe(LanguageRegistry::FAMILY_GENERAL)
        ->and($r->familyForModel(null))->toBe(LanguageRegistry::FAMILY_GENERAL);
});

// ── ScriptDetector: the Shahmukhi trap ──────────────────────────────────────

it('catches a translation returned in the wrong script', function () {
    // The motivating failure: Shahmukhi asked for, Gurmukhi delivered.
    expect(ScriptDetector::matches('ਜ਼ਮੀਨ ਵੰਡੀ ਗਈ', 'Arab'))->toBeFalse()
        ->and(ScriptDetector::matches('زمین ونڈی گئی', 'Arab'))->toBeTrue()
        // Transliteration into Latin is the other half of the same failure.
        ->and(ScriptDetector::matches('zameen vandi gayi', 'Guru'))->toBeFalse()
        // Japanese must not satisfy a Simplified-Chinese request just because
        // Han characters outnumber the kana.
        ->and(ScriptDetector::matches('資本蓄積は不均等に進む', 'Hans'))->toBeFalse()
        ->and(ScriptDetector::matches('资本积累不均衡', 'Hans'))->toBeTrue()
        // Script-neutral text is not a script failure.
        ->and(ScriptDetector::matches('[9] 1867', 'Guru'))->toBeTrue()
        // Latin proper nouns and citations inside a Gurmukhi translation are fine.
        ->and(ScriptDetector::matches('ਸਰਮਾਏ ਦਾ ਸੰਚਯ (Marx, 1867) [9]', 'Guru'))->toBeTrue();
});

// ── TranslatableText ────────────────────────────────────────────────────────

it('derives translatable prose differently from speakable text', function () {
    // Footnote markers are DROPPED, not narrated — narrating them would get the
    // word "footnote" translated into the reader's prose.
    expect(TranslatableText::fromContent('<p>Accumulation proceeds<sup fn-count-id="3">3</sup> unevenly.</p>'))
        ->toBe('Accumulation proceeds unevenly.');

    // Hypercite arrows are UI affordances, not language.
    expect(TranslatableText::fromContent('<p>See the debate<a class="open-icon"><sup>&nearr;</sup></a> here.</p>'))
        ->toBe('See the debate here.');

    // Numeric citations survive verbatim: reference numbers are language-neutral.
    expect(TranslatableText::fromContent('<p>Wages stagnated [<a class="in-text-citation">9</a>] after.</p>'))
        ->toBe('Wages stagnated [9] after.');

    // Author-year is prose and stays.
    expect(TranslatableText::fromContent('<p>As shown (Smith, 2020), demand fell.</p>'))
        ->toBe('As shown (Smith, 2020), demand fell.');

    // Pure furniture is not worth paying to translate.
    expect(TranslatableText::isTranslatable('<p><span class="pageNumber">42</span><img src="x.png"></p>'))->toBeFalse()
        ->and(TranslatableText::isTranslatable(null))->toBeFalse();
});

// ── Provider parity ─────────────────────────────────────────────────────────

it('returns the same result shape whichever provider answers', function () {
    Http::fake([
        '*/chat/completions' => Http::response(fakeChatReply('संचय असमान रूप से बढ़ता है।')),
    ]);

    $registry = app(LanguageRegistry::class);
    $prompt = app(TranslationPrompt::class);

    config(['services.translation.ollama.model' => 'translategemma:4b']);

    $providers = [
        'hosted' => new HostedProvider(app(LlmService::class), $registry, $prompt),
        'ollama' => new OllamaProvider($registry, $prompt),
    ];

    foreach ($providers as $label => $provider) {
        $result = (new TranslationService($provider, $registry))
            ->translate('Accumulation proceeds unevenly.', 'hi', 'en');

        expect($result)->toBeInstanceOf(TranslationResult::class, $label)
            ->and($result->text)->toBe('संचय असमान रूप से बढ़ता है।', $label)
            ->and($result->targetLang)->toBe('hi', $label)
            ->and($result->sourceLang)->toBe('en', $label)
            ->and($result->scriptOk)->toBeTrue($label)
            ->and($result->toArray())->toHaveKeys(
                ['text', 'target_lang', 'source_lang', 'model', 'tier', 'script_ok'],
                $label,
            );
    }
});

it('bills the hosted provider and never the local one', function () {
    $registry = app(LanguageRegistry::class);

    config(['services.translation.provider' => 'hosted']);
    app()->forgetInstance(TranslationProviderInterface::class);
    expect(app(TranslationProviderInterface::class)->isBillable())->toBeTrue();

    // Local compute is the user's own hardware — charging for it would be wrong,
    // and a dedicated endpoint is billed per GPU-hour, so it has no honest
    // per-token rate to charge against.
    foreach (['ollama', 'dedicated'] as $provider) {
        config(['services.translation.provider' => $provider]);
        app()->forgetInstance(TranslationProviderInterface::class);
        expect(app(TranslationProviderInterface::class)->isBillable())->toBeFalse($provider);
    }
});

// ── Request shape: the script-losing case ───────────────────────────────────

it('avoids the structured request shape when it would lose the script', function () {
    config([
        'services.translation.ollama.model' => 'translategemma:12b',
        'services.translation.ollama.request_shape' => 'auto',
    ]);
    $provider = new OllamaProvider(app(LanguageRegistry::class), app(TranslationPrompt::class));

    $payload = new ReflectionMethod($provider, 'payload');
    $payload->setAccessible(true);

    // Single-script target with a known source → structured (the model's native
    // interface) is safe.
    $structured = $payload->invoke($provider, 'The land was divided.', 'hi', 'en');
    expect($structured['messages'][0]['content'][0])
        ->toMatchArray(['type' => 'text', 'source_lang_code' => 'en', 'target_lang_code' => 'hi']);

    // Split-script target → the structured shape has NO slot for "in Shahmukhi",
    // so it must fall back to an instruction that can say so.
    $instruction = $payload->invoke($provider, 'The land was divided.', 'pa-Arab', 'en');
    expect($instruction['messages'][0]['role'])->toBe('system')
        ->and($instruction['messages'][0]['content'])->toContain('Shahmukhi')
        ->and($instruction['messages'][0]['content'])->toContain('Perso-Arabic');

    // Unknown source language also has no structured representation.
    $detect = $payload->invoke($provider, 'The land was divided.', 'hi', null);
    expect($detect['messages'][0]['role'])->toBe('system');
});

it('refuses to guess a source language when the structured shape is demanded', function () {
    config([
        'services.translation.ollama.model' => 'translategemma:4b',
        'services.translation.ollama.request_shape' => 'structured',
    ]);
    $provider = new OllamaProvider(app(LanguageRegistry::class), app(TranslationPrompt::class));

    $resolve = new ReflectionMethod($provider, 'resolveShape');
    $resolve->setAccessible(true);

    expect(fn () => $resolve->invoke($provider, 'hi', null))
        ->toThrow(TranslationProviderException::class, 'needs a known source language');
});

// ── Prompt cleanup ──────────────────────────────────────────────────────────

it('strips model scaffolding without mangling legitimate quotations', function () {
    $prompt = app(TranslationPrompt::class);

    expect($prompt->clean('Translation: संचय बढ़ता है।'))->toBe('संचय बढ़ता है।')
        ->and($prompt->clean("Here is the translation:\nसंचय बढ़ता है।"))->toBe('संचय बढ़ता है।')
        ->and($prompt->clean("```\nसंचय बढ़ता है।\n```"))->toBe('संचय बढ़ता है।')
        // Whole-output quote wrapping the source did not have → unwrap.
        ->and($prompt->clean('"संचय बढ़ता है।"', 'Accumulation grows.'))->toBe('संचय बढ़ता है।')
        // Source was itself a quotation → the marks are the author's, keep them.
        ->and($prompt->clean('"संचय बढ़ता है।"', '"Accumulation grows."'))->toBe('"संचय बढ़ता है।"')
        // An internal quotation is not a wrapper.
        ->and($prompt->clean('He said "no" and left.'))->toBe('He said "no" and left.');
});

// ── Endpoint gate ladder ────────────────────────────────────────────────────

it('requires authentication', function () {
    $this->postJson('/api/translate', ['text' => 'Hello', 'target_lang' => 'hi'])
        ->assertStatus(401);
});

it('rejects an unknown language distinctly from a model gap', function () {
    $user = $this->seedUser(['status' => 'premium']);

    $this->actingAs($user)
        ->postJson('/api/translate', ['text' => 'Hello', 'target_lang' => 'klingon'])
        ->assertStatus(422)
        ->assertJsonPath('reason', 'unknown');

    // Point the deployment at Hy-MT2, which enumerates Punjabi as absent.
    config([
        'services.translation.provider' => 'ollama',
        'services.translation.ollama.model' => 'hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M',
    ]);
    app()->forgetInstance(TranslationProviderInterface::class);

    $this->actingAs($user)
        ->postJson('/api/translate', ['text' => 'Hello', 'target_lang' => 'pa-Guru'])
        ->assertStatus(422)
        ->assertJsonPath('reason', 'unsupported');
});

it('refuses server-side translation of an encrypted book', function () {
    $user = $this->seedUser(['status' => 'premium']);
    $book = translationBook();
    $this->seedLibrary(['book' => $book, 'creator' => $user->name, 'encrypted' => true]);
    \App\Services\E2ee\EncryptedBookGuard::forget($book); // static memo persists across tests

    $this->actingAs($user)
        ->postJson('/api/translate', ['text' => 'Hello', 'target_lang' => 'hi', 'book' => $book])
        ->assertStatus(403);

    Http::assertNothingSent();
});

it('reads an invisible book as nonexistent', function () {
    $owner = $this->seedUser();
    $stranger = $this->seedUser(['status' => 'premium']);
    $book = translationBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'visibility' => 'private']);

    \App\Services\E2ee\EncryptedBookGuard::forget($book);

    $this->actingAs($stranger)
        ->postJson('/api/translate', ['text' => 'Hello', 'target_lang' => 'hi', 'book' => $book])
        ->assertStatus(404);
});

it('rejects text with nothing translatable in it', function () {
    $user = $this->seedUser(['status' => 'premium']);

    $this->actingAs($user)
        ->postJson('/api/translate', [
            'text' => '<p><span class="pageNumber">42</span><img src="x.png"></p>',
            'target_lang' => 'hi',
        ])
        ->assertStatus(422);

    Http::assertNothingSent();
});

// ── Billing ─────────────────────────────────────────────────────────────────

it('charges the hosted path after success and records the cost basis', function () {
    Http::fake(['*/chat/completions' => Http::response(fakeChatReply('संचय बढ़ता है।'))]);

    config([
        'services.translation.provider' => 'hosted',
        'services.translation.hosted.model' => 'accounts/fireworks/models/gpt-oss-120b',
    ]);
    app()->forgetInstance(TranslationProviderInterface::class);

    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);

    $this->actingAs($user)
        ->postJson('/api/translate', ['text' => 'Accumulation grows.', 'target_lang' => 'hi'])
        ->assertOk()
        ->assertJsonPath('success', true)
        ->assertJsonPath('translation.text', 'संचय बढ़ता है।');

    actAsTranslationUser($user);
    $row = DB::table('billing_ledger')
        ->where('category', 'translation')->latest('created_at')->first();

    expect($row)->not->toBeNull();
    $meta = json_decode((string) $row->metadata, true);
    expect($meta)->toHaveKeys(['raw_cost', 'multiplier', 'tier', 'target_lang', 'model'])
        ->and($meta['target_lang'])->toBe('hi')
        // budget tier is x1.5 on raw API cost.
        ->and((float) $meta['multiplier'])->toBe(1.5);
});

it('does not charge when the local provider did the work', function () {
    Http::fake(['*/chat/completions' => Http::response(fakeChatReply('संचय बढ़ता है।'))]);

    config([
        'services.translation.provider' => 'ollama',
        'services.translation.ollama.model' => 'translategemma:4b',
    ]);
    app()->forgetInstance(TranslationProviderInterface::class);

    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    actAsTranslationUser($user);
    $before = DB::table('billing_ledger')->where('category', 'translation')->count();

    $this->actingAs($user)
        ->postJson('/api/translate', ['text' => 'Accumulation grows.', 'target_lang' => 'hi'])
        ->assertOk();

    actAsTranslationUser($user);
    expect(DB::table('billing_ledger')->where('category', 'translation')->count())->toBe($before);
});

it('blocks the hosted path on an empty balance but not a local one', function () {
    Http::fake(['*/chat/completions' => Http::response(fakeChatReply('संचय बढ़ता है।'))]);
    $user = $this->seedUser(['status' => 'budget', 'credits' => 0, 'debits' => 0]);

    config(['services.translation.provider' => 'hosted']);
    app()->forgetInstance(TranslationProviderInterface::class);
    $this->actingAs($user)
        ->postJson('/api/translate', ['text' => 'Hello', 'target_lang' => 'hi'])
        ->assertStatus(402);

    // Local costs us nothing, so an empty balance is irrelevant.
    config(['services.translation.provider' => 'ollama', 'services.translation.ollama.model' => 'translategemma:4b']);
    app()->forgetInstance(TranslationProviderInterface::class);
    $this->actingAs($user)
        ->postJson('/api/translate', ['text' => 'Hello', 'target_lang' => 'hi'])
        ->assertOk();
});

// ── BYO inference ───────────────────────────────────────────────────────────

it('parks a translation ticket under BYO and waives the charge', function () {
    config([
        'services.translation.byo_wait_seconds' => 0, // don't actually block
        'services.llm.ticket_poll_seconds' => 0,
    ]);

    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    actAsTranslationUser($user);

    $before = DB::table('billing_ledger')->where('category', 'translation')->count();

    // With a zero wait the ticket is parked and the wait times out immediately →
    // 503, which is the honest answer when the user's own model never answered.
    $this->actingAs($user)
        ->postJson('/api/translate', [
            'text' => 'Accumulation grows.',
            'target_lang' => 'hi',
            'client_inference' => true,
        ])
        ->assertStatus(503);

    // The request was parked for the client under the new feature name...
    actAsTranslationUser($user);
    expect(InferenceTicket::where('creator', $user->name)->where('feature', 'translation')->exists())
        ->toBeTrue();

    // ...and nothing was billed: the user's own key would have paid.
    expect(DB::table('billing_ledger')->where('category', 'translation')->count())->toBe($before);

    // No server-side provider call happened.
    Http::assertNothingSent();
});

it('never leaks the BYO transport onto the next request', function () {
    config(['services.translation.byo_wait_seconds' => 0, 'services.llm.ticket_poll_seconds' => 0]);

    $user = $this->seedUser(['status' => 'premium']);
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);

    // A BYO request that fails mid-flight (the wait times out).
    $this->actingAs($user)->postJson('/api/translate', [
        'text' => 'Accumulation grows.',
        'target_lang' => 'hi',
        'client_inference' => true,
    ])->assertStatus(503);

    // LlmService is a SINGLETON: a leaked transport would ticketise this next,
    // unrelated call instead of hitting the provider. It must reach HTTP.
    Http::fake(['*/chat/completions' => Http::response(fakeChatReply('संचय बढ़ता है।'))]);
    config(['services.translation.provider' => 'hosted']);
    app()->forgetInstance(TranslationProviderInterface::class);

    $this->actingAs($user)
        ->postJson('/api/translate', ['text' => 'Accumulation grows.', 'target_lang' => 'hi'])
        ->assertOk()
        ->assertJsonPath('translation.text', 'संचय बढ़ता है।');

    Http::assertSentCount(1);
});

// ── Wrong-script reporting ──────────────────────────────────────────────────

it('flags a wrong-script answer instead of presenting it as clean', function () {
    // Asked for Shahmukhi, model answers in Gurmukhi — fluent and wrong.
    Http::fake(['*/chat/completions' => Http::response(fakeChatReply('ਜ਼ਮੀਨ ਵੰਡੀ ਗਈ ਸੀ।'))]);

    config(['services.translation.provider' => 'hosted']);
    app()->forgetInstance(TranslationProviderInterface::class);

    $user = $this->seedUser(['status' => 'premium']);

    $this->actingAs($user)
        ->postJson('/api/translate', ['text' => 'The land was divided.', 'target_lang' => 'pa-Arab'])
        ->assertOk()
        ->assertJsonPath('wrong_script', true)
        ->assertJsonPath('translation.script_ok', false);
});

it('reports that it guessed the script for a bare language code', function () {
    Http::fake(['*/chat/completions' => Http::response(fakeChatReply('ਜ਼ਮੀਨ ਵੰਡੀ ਗਈ ਸੀ।'))]);

    config(['services.translation.provider' => 'hosted']);
    app()->forgetInstance(TranslationProviderInterface::class);

    $user = $this->seedUser(['status' => 'premium']);

    // A bare 'pa' could have meant either script; we chose Gurmukhi and say so.
    $this->actingAs($user)
        ->postJson('/api/translate', ['text' => 'The land was divided.', 'target_lang' => 'pa'])
        ->assertOk()
        ->assertJsonPath('translation.target_lang', 'pa-Guru')
        ->assertJsonPath('translation.target_was_ambiguous', true);
});

// ── Language listing ────────────────────────────────────────────────────────

it('omits a model gap from the offered languages and tiers the rest', function () {
    config([
        'services.translation.provider' => 'ollama',
        'services.translation.ollama.model' => 'hf.co/tencent/Hy-MT2-7B-GGUF:Q4_K_M',
    ]);
    app()->forgetInstance(TranslationProviderInterface::class);

    $user = $this->seedUser(['status' => 'premium']);

    $response = $this->actingAs($user)->getJson('/api/translate/languages')->assertOk();
    $codes = array_column($response->json('languages'), 'code');

    expect($response->json('family'))->toBe(LanguageRegistry::FAMILY_HY_MT2)
        ->and($codes)->not->toContain('pa-Guru')
        ->and($codes)->not->toContain('pa-Arab')
        ->and($codes)->toContain('hi');
});
