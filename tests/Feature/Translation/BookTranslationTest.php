<?php

/**
 * "Translate this book": GET/POST /api/book-translation/{book} and the
 * TranslateBookJob behind it (runs synchronously under QUEUE_CONNECTION=sync).
 *
 * Locks: Chinese → English and English → Chinese only; the result is a NEW
 * copy for the requester with every node_id / startLine / footnoteId kept and
 * only the book moved, hypercite markers unwrapped, footnotes and their
 * sub-books translated too; Kimi K3 is pinned whatever the config says;
 * requester-pays (refused without credit, charged for tokens used); a failed
 * run writes nothing and a rerun only pays for what's left; a run that hits
 * its deadline hands off without writing.
 *
 * The COMMONS rules: a public original begets a PUBLIC copy (clamped to
 * private by PublishGate when the requester may not publish; a private
 * original always begets a private copy); lineage lives in the
 * translated_from / translation_target COLUMNS; canonical_source_id rides
 * along so the copy joins the work's versions; conversion_method is
 * 'book_translation' (never auto-pointer-eligible); ONE visible translation
 * blocks a second for everyone who can see it, while an invisible (private,
 * someone else's) one blocks nobody.
 *
 * No network — the Fireworks endpoint is faked.
 */

use App\Jobs\TranslateBookJob;
use App\Services\BillingService;
use App\Services\E2ee\EncryptedBookGuard;
use App\Services\LlmService;
use App\Services\Translation\BookTranslationService;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

const BOOK_TRANSLATION_ANSWERS = [
    '第一章' => 'Chapter One',
    '小六走进屋子<x1/>。<g2>他笑了</g2>。' => 'Xiao Liu walked into the room<x1/>. <g2>He laughed</g2>.',
    '注释内容。' => 'A note.',
];

beforeEach(function () {
    $this->storage = sys_get_temp_dir().'/hyperlit_book_translation_'.uniqid();
    $this->app->useStoragePath($this->storage);
    config([
        'services.llm.base_url' => 'https://llm.test/v1',
        'services.llm.api_key' => 'test-key',
        'services.translation.html.retry_backoff' => 0,
        'services.translation.html.max_attempts' => 1,
        // The in-app job must pin Kimi K3 regardless of this.
        'services.translation.html.model' => 'accounts/fireworks/models/gpt-oss-120b',
    ]);
    app()->forgetInstance(LlmService::class);

    // A two-node Chinese book with a footnote (and its sub-book) and a hypercite marker.
    // A closure, not a function: it calls the fixture trait's protected seeders.
    $this->seedChineseBook = function (string $creator, string $visibility = 'private'): string {
        $book = 'bt_'.Str::lower(Str::random(10));
        $this->seededBooks[] = $book;
        $this->seedLibrary(['book' => $book, 'title' => '长相思', 'creator' => $creator, 'visibility' => $visibility]);
        $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => "{$book}_n1", 'footnotes' => '[]',
            'content' => '<h2 id="1" data-node-id="'.$book.'_n1">第一章</h2>']);
        $this->seedNode(['book' => $book, 'startLine' => 2, 'node_id' => "{$book}_n2", 'footnotes' => '["'.$book.'Fn1"]',
            'content' => '<p id="2" data-node-id="'.$book.'_n2">小六走进屋子<sup fn-count-id="1" id="'.$book.'Fnref1"><a class="footnote-ref" href="#'.$book.'Fn1">1</a></sup>。<u id="hypercite_abc" class="single">他笑了</u>。</p>']);
        $this->seedNode(['book' => "{$book}/{$book}Fn1", 'startLine' => 1, 'node_id' => "{$book}_s1", 'footnotes' => '[]',
            'content' => '<p id="1" data-node-id="'.$book.'_s1">注释内容。</p>']);
        DB::connection('pgsql_admin')->table('footnotes')->insert([
            'book' => $book, 'footnoteId' => "{$book}Fn1", 'sub_book_id' => "{$book}/{$book}Fn1",
            'content' => '<p>注释内容。</p>', 'created_at' => now(), 'updated_at' => now(),
        ]);
        EncryptedBookGuard::forget($book);

        return $book;
    };
});

afterEach(function () {
    $db = DB::connection('pgsql_admin');
    foreach ($this->seededBooks ?? [] as $book) {
        // Two hops: a translation-of-a-translation's parent is itself a copy.
        $copies = $db->table('library')->where('translated_from', $book)->pluck('book');
        $copies = $copies->merge($db->table('library')->whereIn('translated_from', $copies)->pluck('book'));
        foreach ($copies as $copy) {
            $db->table('nodes')->where('book', $copy)->orWhere('book', 'like', $copy.'/%')->delete();
            foreach (['footnotes', 'bibliography', 'library'] as $table) {
                $db->table($table)->where('book', $copy)->delete();
            }
        }
        $db->table('footnotes')->where('book', $book)->delete();
    }
    File::deleteDirectory($this->storage);
});

/** Fake Fireworks from a paragraph → translation map, read by reference so a test can change it. */
function fakeFireworksBook(array &$answers): void
{
    Http::fake(['*/chat/completions' => function (Request $request) use (&$answers) {
        $sent = json_decode(Str::afterLast($request->data()['messages'][1]['content'], "\n\n"), true);
        $reply = [];
        foreach ($sent as $id => $text) {
            if (array_key_exists($text, $answers)) {
                $reply[$id] = $answers[$text];
            }
        }

        return Http::response([
            'choices' => [['message' => ['content' => json_encode($reply, JSON_UNESCAPED_UNICODE | JSON_FORCE_OBJECT)]]],
            'usage' => ['prompt_tokens' => 1000, 'completion_tokens' => 500],
        ]);
    }]);
}

function actAsBookTranslationUser(\App\Models\User $user): void
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
}

it('offers a Chinese book for translation into English, with an estimate', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($user->name);

    $this->actingAs($user)->getJson("/api/book-translation/{$book}")
        ->assertOk()
        ->assertJsonPath('available', true)
        ->assertJsonPath('source_lang', 'zh-Hans')
        ->assertJsonPath('target_lang', 'en')
        ->assertJsonPath('target_label', 'English')
        ->assertJsonPath('characters', mb_strlen('第一章小六走进屋子1。他笑了。注释内容。注释内容。'))
        // Two requests (one chapter, one footnotes section) at $0.02 dominate a
        // book this short — the per-character part is a fraction of a cent.
        ->assertJsonPath('estimated_cost', 0.04)
        ->assertJsonPath('running', false)
        ->assertJsonPath('existing', null);

    Http::assertNothingSent();
});

it('tells a guest what the button would do, so it can say "log in to translate"', function () {
    $owner = $this->seedUser();
    $public = ($this->seedChineseBook)($owner->name, 'public');
    $private = ($this->seedChineseBook)($owner->name, 'private');

    $this->getJson("/api/book-translation/{$public}")
        ->assertOk()
        ->assertJsonPath('available', true)
        ->assertJsonPath('logged_in', false)
        ->assertJsonPath('target_label', 'English')
        ->assertJsonPath('existing', null)
        ->assertJsonPath('progress', null);
    $this->getJson("/api/book-translation/{$private}")->assertStatus(404);

    // Starting one still needs an account.
    $this->postJson("/api/book-translation/{$public}")->assertStatus(401);
    Http::assertNothingSent();
});

it('offers an English book for translation into Chinese, and nothing else', function () {
    $user = $this->seedUser(['status' => 'premium']);
    $english = 'bt_'.Str::lower(Str::random(10));
    $french = 'bt_'.Str::lower(Str::random(10));
    $this->seededBooks = [$english, $french];
    $this->seedLibrary(['book' => $english, 'creator' => $user->name]);
    $this->seedNode(['book' => $english, 'startLine' => 1, 'content' => '<p id="1">Capital accumulates unevenly.</p>']);
    $this->seedLibrary(['book' => $french, 'creator' => $user->name]);
    $this->seedNode(['book' => $french, 'startLine' => 1, 'content' => '<p id="1">Привет, мир.</p>']);

    $this->actingAs($user)->getJson("/api/book-translation/{$english}")
        ->assertJsonPath('target_lang', 'zh-Hans')
        ->assertJsonPath('target_label', 'Chinese');
    $this->actingAs($user)->getJson("/api/book-translation/{$french}")
        ->assertJsonPath('available', false)
        ->assertJsonPath('reason', 'Only Chinese and English books can be translated for now.');
});

it('dispatches on the dedicated translation queue', function () {
    // The queue NAME is part of the prod topology: hyperlit-translation.conf,
    // package.json queue:translation and queue:probe all listen on
    // `translation` — a silent rename here would leave the job with no
    // consumer and translations hanging forever (supervisor invariant #1).
    \Illuminate\Support\Facades\Queue::fake();
    $user = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($user->name);

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);

    \Illuminate\Support\Facades\Queue::assertPushedOn('translation', \App\Jobs\TranslateBookJob::class);
});

it('translates a public book into a new PUBLIC copy for the requester, on Kimi K3, and charges them', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $owner = $this->seedUser();
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $book = ($this->seedChineseBook)($owner->name, 'public');
    // The original is canonical-linked; the copy must join the same work.
    $canonical = Str::uuid()->toString();
    DB::connection('pgsql_admin')->table('library')->where('book', $book)
        ->update(['canonical_source_id' => $canonical, 'canonical_match_method' => 'doi', 'conversion_method' => 'pdf_ocr_auto_raw']);

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")
        ->assertStatus(202)
        ->assertJsonPath('target_lang', 'en');

    $db = DB::connection('pgsql_admin');
    $copy = $db->table('library')->where('translated_from', $book)->first();
    expect($copy)->not->toBeNull()
        ->and($copy->title)->toBe('长相思 (English)')
        ->and($copy->creator)->toBe($user->name)
        // The commons rule: public original (and no publish gate configured
        // in testing) → public, listed copy. One reader paid; everyone reads.
        ->and($copy->visibility)->toBe('public')
        ->and($copy->listed)->toBeTrue()
        ->and($copy->language)->toBe('en')
        ->and($copy->translation_target)->toBe('en')
        // Same work, new expression — but never auto-pointer-eligible, and
        // the ORIGINAL's match provenance stays its own.
        ->and($copy->canonical_source_id)->toBe($canonical)
        ->and($copy->canonical_match_method)->toBeNull()
        ->and($copy->conversion_method)->toBe('book_translation')
        ->and(json_decode($copy->raw_json, true)['translation_model'])->toBe('accounts/fireworks/models/kimi-k3');

    // Same node ids and positions; only the book moved. The footnote marker
    // survives verbatim; the hypercite marker is unwrapped (its row isn't copied).
    $nodes = $db->table('nodes')->where('book', $copy->book)->orderBy('startLine')->get();
    expect($nodes->pluck('node_id')->all())->toBe(["{$book}_n1", "{$book}_n2"])
        ->and($nodes[0]->content)->toBe('<h2 id="1" data-node-id="'.$book.'_n1">Chapter One</h2>')
        ->and($nodes[1]->content)->toBe('<p id="2" data-node-id="'.$book.'_n2">Xiao Liu walked into the room<sup fn-count-id="1" id="'.$book.'Fnref1"><a class="footnote-ref" href="#'.$book.'Fn1">1</a></sup>. He laughed.</p>')
        ->and($nodes[1]->plainText)->toBe('Xiao Liu walked into the room1. He laughed.')
        ->and($nodes[1]->footnotes)->toBe('["'.$book.'Fn1"]');

    $footnote = $db->table('footnotes')->where('book', $copy->book)->first();
    expect($footnote->footnoteId)->toBe("{$book}Fn1")
        ->and($footnote->sub_book_id)->toBe("{$copy->book}/{$book}Fn1")
        ->and($footnote->content)->toBe('<p>A note.</p>');
    expect($db->table('nodes')->where('book', "{$copy->book}/{$book}Fn1")->value('content'))
        ->toBe('<p id="1" data-node-id="'.$book.'_s1">A note.</p>');

    // The original is untouched.
    expect($db->table('nodes')->where('book', $book)->where('startLine', 1)->value('content'))
        ->toBe('<h2 id="1" data-node-id="'.$book.'_n1">第一章</h2>');

    // Pinned to Kimi K3 at low effort even though the config said otherwise.
    Http::assertSent(fn (Request $r) => $r->data()['model'] === 'accounts/fireworks/models/kimi-k3'
        && $r->data()['reasoning_effort'] === 'low');

    // Charged for the tokens used, at Kimi K3 rates.
    actAsBookTranslationUser($user);
    $charge = DB::table('billing_ledger')->where('category', 'translation')->latest('created_at')->first();
    expect($charge)->not->toBeNull()
        ->and(json_decode($charge->metadata, true)['model'])->toBe('accounts/fireworks/models/kimi-k3');

    // The status now points at the copy — and carries the staged telemetry
    // the live-progress overlay renders (additive keys only).
    $this->actingAs($user)->getJson("/api/book-translation/{$book}")
        ->assertJsonPath('existing.book', $copy->book)
        ->assertJsonPath('progress.status', 'done')
        ->assertJsonPath('progress.stage', 'write')
        ->assertJsonPath('progress.stages.queued.status', 'completed')
        ->assertJsonPath('progress.stages.text.status', 'completed')
        ->assertJsonPath('progress.stages.notes.status', 'completed')
        ->assertJsonPath('progress.stages.write.status', 'completed')
        ->assertJsonPath('progress.stages.write.new_book', $copy->book)
        ->assertJsonPath('progress.new_book', $copy->book)
        ->assertJsonPath('telemetry.0.stage', 'queued');
});

it('sends the requester to their existing copy instead of paying twice', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($user->name);

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);
    $sent = Http::recorded()->count();

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")
        ->assertStatus(409)
        ->assertJsonStructure(['existing' => ['book', 'title']]);
    expect(Http::recorded()->count())->toBe($sent);
});

it('refuses without credit, without a login, and for a book the requester cannot see', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $owner = $this->seedUser();
    $broke = $this->seedUser(['status' => 'budget', 'credits' => 0]);
    $stranger = $this->seedUser(['status' => 'premium']);
    $visible = ($this->seedChineseBook)($owner->name, 'public');
    $private = ($this->seedChineseBook)($owner->name, 'private');

    $this->postJson("/api/book-translation/{$visible}")->assertStatus(401); // before any actingAs
    $this->actingAs($broke)->postJson("/api/book-translation/{$visible}")->assertStatus(402);
    $this->actingAs($stranger)->postJson("/api/book-translation/{$private}")->assertStatus(404);
    $this->actingAs($stranger)->getJson("/api/book-translation/{$private}")->assertStatus(404);

    Http::assertNothingSent();
});

it('writes nothing when a paragraph fails, and a rerun only pays for what is left', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    unset($answers['注释内容。']); // the model never answers the footnote
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($user->name);

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);

    expect(DB::connection('pgsql_admin')->table('library')->where('translated_from', $book)->exists())->toBeFalse();
    $this->actingAs($user)->getJson("/api/book-translation/{$book}")
        ->assertJsonPath('progress.status', 'failed')
        ->assertJsonPath('existing', null);

    // The model recovers; the rerun sends only the footnote text.
    $answers['注释内容。'] = 'A note.';
    $before = Http::recorded()->count();
    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);

    $rerun = Http::recorded()->slice($before)
        ->flatMap(fn (array $pair) => array_values(json_decode(Str::afterLast($pair[0]->data()['messages'][1]['content'], "\n\n"), true)))
        ->unique()->values()->all();
    expect($rerun)->toBe(['注释内容。'])
        ->and(DB::connection('pgsql_admin')->table('library')->where('translated_from', $book)->exists())->toBeTrue();
});

it('keeps reference-list nodes verbatim — citations are claims, not prose', function () {
    // The paste lane marks rendered bibliography entries. They are never
    // sent to the model (their span-thicket markup is what broke a real run,
    // and a citation should stay in its source language anyway): if this one
    // WERE sent, the fake has no answer for it and the run would fail.
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($user->name);
    $ref = '<p id="3" data-node-id="'.$book.'_n3" data-static-content="bibliography"><span><span>马克思</span></span><span> (1867) </span><i>资本论</i></p>';
    $this->seedNode(['book' => $book, 'startLine' => 3, 'node_id' => "{$book}_n3", 'footnotes' => '[]', 'content' => $ref]);

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);

    $db = DB::connection('pgsql_admin');
    $copy = $db->table('library')->where('translated_from', $book)->value('book');
    expect($copy)->not->toBeNull()
        ->and($db->table('nodes')->where('book', $copy)->where('startLine', 3)->value('content'))->toBe($ref);
});

it('clamps the copy to private when the requester may not publish, and says why', function () {
    // The same gate as DbLibraryController's publish clamp: post-cutoff
    // account, unverified email. Never a 422 — the translation still runs,
    // the copy is just private, and progress.json carries the reason.
    config(['publishing.verified_email_required_after' => '2020-01-01']);
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $owner = $this->seedUser();
    $user = $this->seedUser(['status' => 'premium', 'email_verified_at' => null]);
    $book = ($this->seedChineseBook)($owner->name, 'public');

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);

    $copy = DB::connection('pgsql_admin')->table('library')->where('translated_from', $book)->first();
    expect($copy->visibility)->toBe('private')
        ->and($copy->listed)->toBeFalse()
        ->and(app(BookTranslationService::class)->readProgress($book, 'en', $user->id)['publish_clamped'])
        ->toBe('unverified_email');
});

it('keeps a private original\'s translation private, whoever asks', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'premium']); // verified, gate off — still private
    $book = ($this->seedChineseBook)($user->name, 'private');

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);

    expect(DB::connection('pgsql_admin')->table('library')->where('translated_from', $book)->value('visibility'))
        ->toBe('private');
});

it('shows everyone an existing public translation instead of a paid button — the commons dedupe', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $owner = $this->seedUser();
    $payer = $this->seedUser(['status' => 'premium']);
    $reader = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($owner->name, 'public');

    $this->actingAs($payer)->postJson("/api/book-translation/{$book}")->assertStatus(202);
    $copy = DB::connection('pgsql_admin')->table('library')->where('translated_from', $book)->value('book');

    // A different logged-in reader: open-link, not a second bill.
    $this->actingAs($reader)->getJson("/api/book-translation/{$book}")
        ->assertJsonPath('existing.book', $copy)
        ->assertJsonPath('existing.own', false)
        ->assertJsonPath('existing.creator', $payer->name);
    $sent = Http::recorded()->count();
    $this->actingAs($reader)->postJson("/api/book-translation/{$book}")
        ->assertStatus(409)
        ->assertJsonPath('message', 'A translation of this book already exists.')
        ->assertJsonPath('existing.book', $copy);
    expect(Http::recorded()->count())->toBe($sent);

    // Even a guest gets the link — the status read is public.
    $this->flushSession();
    $this->getJson("/api/book-translation/{$book}")->assertJsonPath('existing.book', $copy);
});

it('lets a second user translate when the only existing copy is someone else\'s private one', function () {
    // userA's clamped-private copy is invisible to userB under RLS, so it
    // must not block them — they can't read it, so the commons gave them nothing.
    config(['publishing.verified_email_required_after' => '2020-01-01']);
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $owner = $this->seedUser();
    $unverified = $this->seedUser(['status' => 'premium', 'email_verified_at' => null]);
    $verified = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($owner->name, 'public');

    $this->actingAs($unverified)->postJson("/api/book-translation/{$book}")->assertStatus(202);

    $this->actingAs($verified)->getJson("/api/book-translation/{$book}")->assertJsonPath('existing', null);
    $this->actingAs($verified)->postJson("/api/book-translation/{$book}")->assertStatus(202);

    expect(DB::connection('pgsql_admin')->table('library')->where('translated_from', $book)->count())->toBe(2);
});

it('points a translation of a translation at its immediate parent', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($user->name);

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);
    $copy = DB::connection('pgsql_admin')->table('library')->where('translated_from', $book)->value('book');

    // Back into Chinese: the round trip must cite the ENGLISH copy as its
    // source, not inherit the grandparent from the merged row.
    $answers['Chapter One'] = '第一章';
    $answers['Xiao Liu walked into the room<x1/>. He laughed.'] = '小六走进屋子<x1/>。他笑了。';
    $answers['A note.'] = '注释内容。';
    $this->actingAs($user)->postJson("/api/book-translation/{$copy}")->assertStatus(202);

    $second = DB::connection('pgsql_admin')->table('library')->where('translated_from', $copy)->first();
    expect($second)->not->toBeNull()
        ->and($second->translated_from)->toBe($copy)
        ->and($second->translation_target)->toBe('zh-Hans');
});

// ---------------------------------------------------------------------------
// Billing — audio-suite parity (reservation lifecycle, exact amounts)
// ---------------------------------------------------------------------------

/** What ONE faked Fireworks request costs raw: the fake's fixed 1000/500 tokens at Kimi K3 rates. */
function bookTranslationPerRequestCost(): float
{
    $rate = config('services.llm.pricing')['accounts/fireworks/models/kimi-k3'];

    return 1000 / 1_000_000 * $rate['input'] + 500 / 1_000_000 * $rate['output'];
}

it('releases the reservation hold when the run finishes — only the actual token cost stays debited', function () {
    // Same regression class as the audiobook hold: the start endpoint
    // reserves the ESTIMATE; if the job's finally didn't release it, a
    // pay-as-you-go user would carry hold + real charge forever.
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10, 'debits' => 0]);
    $book = ($this->seedChineseBook)($user->name);

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);

    actAsBookTranslationUser($user);
    // Reservations share the (fossil-named) tts_reservation category across
    // every feature; none may survive the run.
    expect(DB::table('billing_ledger')
        ->where('user_id', $user->id)->where('category', 'tts_reservation')->count())->toBe(0);
    $charges = DB::table('billing_ledger')
        ->where('user_id', $user->id)->where('category', 'translation')->get();
    expect($charges)->toHaveCount(1);
    $expected = Http::recorded()->count() * bookTranslationPerRequestCost() * $user->getBillingMultiplier();
    expect((float) $charges[0]->amount)->toEqualWithDelta($expected, 0.0001)
        ->and((float) \App\Models\User::find($user->id)->debits)->toEqualWithDelta($expected, 0.0001);
});

it('releases the reservation hold when the job FAILS (failed handler)', function () {
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10, 'debits' => 0]);
    $book = ($this->seedChineseBook)($user->name);

    actAsBookTranslationUser($user);
    $hold = app(BillingService::class)->reserveCredits($user, 2.00, "Book translation reservation: {$book}");
    expect($hold)->not->toBeNull();

    (new TranslateBookJob($book, $user->id, 'en', $hold->id))->failed(new RuntimeException('worker died'));

    actAsBookTranslationUser($user);
    expect((float) \App\Models\User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001)
        ->and(DB::table('billing_ledger')
            ->where('user_id', $user->id)->where('category', 'tts_reservation')->count())->toBe(0)
        ->and(app(BookTranslationService::class)->readProgress($book, 'en', $user->id)['status'])->toBe('failed');
});

it('never double-releases: failed() after a finished handle() changes nothing', function () {
    // handle() releases in its finally and nulls the reservation id — a late
    // failed() on the same instance (timeout race) must be a no-op.
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10, 'debits' => 0]);
    $book = ($this->seedChineseBook)($user->name);

    actAsBookTranslationUser($user);
    $hold = app(BillingService::class)->reserveCredits($user, 2.00, "Book translation reservation: {$book}");
    $job = new TranslateBookJob($book, $user->id, 'en', $hold->id);
    $job->handle(app(BookTranslationService::class), app(LlmService::class));

    actAsBookTranslationUser($user);
    $debitsAfterRun = (float) \App\Models\User::find($user->id)->debits;
    expect($debitsAfterRun)->toBeGreaterThan(0.0); // the real charge

    $job->failed(new RuntimeException('late failure after success'));

    actAsBookTranslationUser($user);
    expect((float) \App\Models\User::find($user->id)->debits)->toEqualWithDelta($debitsAfterRun, 0.0001);
});

it('premium pays nothing out of balance: no reservation, ledger-only charge', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'premium', 'debits' => 0]);
    $book = ($this->seedChineseBook)($user->name);

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);

    actAsBookTranslationUser($user);
    expect(DB::table('billing_ledger')
        ->where('user_id', $user->id)->where('category', 'tts_reservation')->count())->toBe(0)
        ->and(DB::table('billing_ledger')
            ->where('user_id', $user->id)->where('category', 'translation')->count())->toBe(1)
        ->and((float) \App\Models\User::find($user->id)->debits)->toEqualWithDelta(0.0, 0.0001);
});

it('409s a second press while a run is live, and takes over a stale lock', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($user->name);

    // A run in flight: lock held + fresh heartbeat.
    Cache::lock(BookTranslationService::lockKey($book, 'en', $user->id), 3900)->get();
    app(BookTranslationService::class)->writeProgress($book, 'en', $user->id, ['status' => 'running']);

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")
        ->assertStatus(409)
        ->assertJsonPath('message', 'This book is already being translated.');
    Http::assertNothingSent();

    // The same lock with a DEAD heartbeat (a worker killed without failed())
    // must be taken over, not block the book until the TTL.
    $safe = preg_replace('/[^A-Za-z0-9_-]/', '_', "{$book}--en--{$user->id}");
    $path = storage_path("app/book-translations/{$safe}/progress.json");
    $progress = json_decode(File::get($path), true);
    $progress['updated_at'] = now()->subMinutes(30)->toIso8601String();
    File::put($path, json_encode($progress));

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);
});

it('charges a failed run only for the tokens it used, and the retry only for the remainder', function () {
    // The confirmed failure semantics: you pay for the work actually done
    // (those paragraphs are cached and NEVER re-billed) — a retry's charge
    // covers only what was left, not the whole book again.
    $answers = BOOK_TRANSLATION_ANSWERS;
    unset($answers['注释内容。']); // the model never answers the footnote
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10, 'debits' => 0]);
    $book = ($this->seedChineseBook)($user->name);

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);
    $failedRunRequests = Http::recorded()->count();

    actAsBookTranslationUser($user);
    $charges = DB::table('billing_ledger')->where('user_id', $user->id)->where('category', 'translation')->get();
    $charge1 = $failedRunRequests * bookTranslationPerRequestCost() * $user->getBillingMultiplier();
    expect($charges)->toHaveCount(1)
        ->and((float) $charges[0]->amount)->toEqualWithDelta($charge1, 0.0001)
        // Nothing stranded: the hold is released even on a failed outcome.
        ->and((float) \App\Models\User::find($user->id)->debits)->toEqualWithDelta($charge1, 0.0001);

    // The model recovers; the retry re-sends ONLY the footnote (one request).
    $answers['注释内容。'] = 'A note.';
    $this->actingAs($user)->postJson("/api/book-translation/{$book}")->assertStatus(202);
    $retryRequests = Http::recorded()->count() - $failedRunRequests;
    expect($retryRequests)->toBe(1);

    actAsBookTranslationUser($user);
    $charges = DB::table('billing_ledger')->where('user_id', $user->id)
        ->where('category', 'translation')->orderBy('created_at')->get();
    $charge2 = $retryRequests * bookTranslationPerRequestCost() * $user->getBillingMultiplier();
    expect($charges)->toHaveCount(2)
        ->and((float) $charges[1]->amount)->toEqualWithDelta($charge2, 0.0001)
        ->and((float) \App\Models\User::find($user->id)->debits)->toEqualWithDelta($charge1 + $charge2, 0.0001)
        ->and(DB::table('library')->where('translated_from', $book)->exists())->toBeTrue();
});

it('hands off without writing anything when it runs out of time', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($user->name);

    $outcome = app(BookTranslationService::class)->run($book, 'en', $user, deadline: microtime(true) - 1);

    expect($outcome)->toBe(['status' => 'continue'])
        ->and(DB::connection('pgsql_admin')->table('library')->where('translated_from', $book)->exists())->toBeFalse();
    Http::assertNothingSent();
});
