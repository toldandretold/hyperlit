<?php

/**
 * "Translate this book": GET/POST /api/book-translation/{book} and the
 * TranslateBookJob behind it (runs synchronously under QUEUE_CONNECTION=sync).
 *
 * Locks: Chinese → English and English → Chinese only; the result is a NEW
 * private copy for the requester with every node_id / startLine / footnoteId
 * kept and only the book moved, hypercite markers unwrapped, footnotes and
 * their sub-books translated too; Kimi K3 is pinned whatever the config says;
 * requester-pays (refused without credit, charged for tokens used); a failed
 * run writes nothing and a rerun only pays for what's left; a run that hits
 * its deadline hands off without writing.
 *
 * No network — the Fireworks endpoint is faked.
 */

use App\Services\E2ee\EncryptedBookGuard;
use App\Services\LlmService;
use App\Services\Translation\BookTranslationService;
use Illuminate\Http\Client\Request;
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
        $copies = $db->table('library')->whereRaw("raw_json->>'translated_from' = ?", [$book])->pluck('book');
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

it('translates the book into a new private copy for the requester, on Kimi K3, and charges them', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $owner = $this->seedUser();
    $user = $this->seedUser(['status' => 'budget', 'credits' => 10]);
    $book = ($this->seedChineseBook)($owner->name, 'public');

    $this->actingAs($user)->postJson("/api/book-translation/{$book}")
        ->assertStatus(202)
        ->assertJsonPath('target_lang', 'en');

    $db = DB::connection('pgsql_admin');
    $copy = $db->table('library')->whereRaw("raw_json->>'translated_from' = ?", [$book])->first();
    expect($copy)->not->toBeNull()
        ->and($copy->title)->toBe('长相思 (English)')
        ->and($copy->creator)->toBe($user->name)
        ->and($copy->visibility)->toBe('private')
        ->and($copy->language)->toBe('en')
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

    // The status now points at the copy.
    $this->actingAs($user)->getJson("/api/book-translation/{$book}")
        ->assertJsonPath('existing.book', $copy->book)
        ->assertJsonPath('progress.status', 'done');
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

    expect(DB::connection('pgsql_admin')->table('library')->whereRaw("raw_json->>'translated_from' = ?", [$book])->exists())->toBeFalse();
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
        ->and(DB::connection('pgsql_admin')->table('library')->whereRaw("raw_json->>'translated_from' = ?", [$book])->exists())->toBeTrue();
});

it('hands off without writing anything when it runs out of time', function () {
    $answers = BOOK_TRANSLATION_ANSWERS;
    fakeFireworksBook($answers);
    $user = $this->seedUser(['status' => 'premium']);
    $book = ($this->seedChineseBook)($user->name);

    $outcome = app(BookTranslationService::class)->run($book, 'en', $user, deadline: microtime(true) - 1);

    expect($outcome)->toBe(['status' => 'continue'])
        ->and(DB::connection('pgsql_admin')->table('library')->whereRaw("raw_json->>'translated_from' = ?", [$book])->exists())->toBeFalse();
    Http::assertNothingSent();
});
