<?php

/**
 * HtmlTranslator + translate:html — book translation on Fireworks, ported from
 * the standalone script, with markup carried through by placeholder.
 *
 * Locks: paragraphs go out as a JSON object, batched per chapter, in order,
 * with the previous translations as context, chapters side by side; inline
 * markup is rebuilt from the original elements and an answer that breaks it is
 * retried and then translated node by node; <br>-separated novel paragraphs
 * keep their &nbsp; indents; a paragraph that never comes back is counted and
 * blocks the write; finished paragraphs are cached and not paid for twice.
 *
 * No network and no database — the LLM endpoint is faked.
 */

use App\Services\LlmService;
use App\Services\Translation\HtmlTranslationResult;
use App\Services\Translation\HtmlTranslator;
use App\Services\Translation\UnsupportedLanguageException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Tests\TestCase;

uses(TestCase::class);

beforeEach(function () {
    config([
        'services.llm.base_url' => 'https://llm.test/v1',
        'services.llm.api_key' => 'test-key',
        'services.translation.html.model' => 'accounts/fireworks/models/kimi-k3',
        'services.translation.html.reasoning_effort' => null,
        'services.translation.html.max_attempts' => 2,
        'services.translation.html.retry_backoff' => 0,
    ]);
    // LlmService is a singleton that reads config in its constructor.
    app()->forgetInstance(LlmService::class);
});

/** The {id: paragraph} object a request carried (it follows any context block). */
function bookPayload(Request $request): array
{
    return json_decode(Str::afterLast($request->data()['messages'][1]['content'], "\n\n"), true);
}

/**
 * Fake Fireworks from a "paragraph sent" → "translation" map. An unmapped
 * paragraph is left out of the reply, as a model that skips one would.
 */
function fakeBookTranslations(array $answers): void
{
    Http::fake(['*/chat/completions' => function (Request $request) use ($answers) {
        $reply = [];
        foreach (bookPayload($request) as $id => $text) {
            if (array_key_exists($text, $answers)) {
                $reply[$id] = $answers[$text];
            }
        }

        return Http::response([
            'choices' => [['message' => ['content' => json_encode($reply, JSON_UNESCAPED_UNICODE | JSON_FORCE_OBJECT)]]],
            'usage' => ['prompt_tokens' => 100, 'completion_tokens' => 50],
        ]);
    }]);
}

/** @return list<list<string>> the paragraphs of each request, in send order */
function sentParagraphs(): array
{
    return Http::recorded()->map(fn (array $pair) => array_values(bookPayload($pair[0])))->all();
}

function translateBook(string $html, string $to, ?string $from = null, mixed ...$options): HtmlTranslationResult
{
    return app(HtmlTranslator::class)->translate($html, $to, $from, ...$options);
}

it('translates a paragraph as one unit and rebuilds its markup from the original elements', function () {
    // Chinese moves the object to the front: the placeholders move with it.
    fakeBookTranslations([
        'The <g1>quick</g1> fox<x2/> jumps over <g3>the dog</g3>.' => '<g3>那只狗</g3>被<g1>敏捷的</g1>狐狸<x2/>跳过了。',
    ]);

    $result = translateBook(
        '<p id="n1" data-node="7">The <em class="k">quick</em> fox<sup fn-count-id="3" id="fn3">3</sup> jumps over <a href="/b#x" class="hypercite">the dog</a>.</p>',
        'zh-Hans',
        'en',
    );

    expect($result->html)->toBe(
        '<p id="n1" data-node="7"><a href="/b#x" class="hypercite">那只狗</a>被<em class="k">敏捷的</em>狐狸<sup fn-count-id="3" id="fn3">3</sup>跳过了。</p>'
    );
    expect($result->translated)->toBe(1)
        ->and($result->fallbacks)->toBe(0)
        ->and($result->failed)->toBe(0)
        ->and($result->targetLang)->toBe('zh-Hans');

    // The script's request shape: Kimi K3 at low effort, room for reasoning.
    Http::assertSent(function (Request $r) {
        $body = $r->data();

        return $body['model'] === 'accounts/fireworks/models/kimi-k3'
            && $body['reasoning_effort'] === 'low'
            && $body['temperature'] === 0.4
            && $body['max_tokens'] === 32000
            && str_contains($body['messages'][0]['content'], '<g1>…</g1>')
            && str_contains($body['messages'][0]['content'], 'Return ONLY a JSON object');
    });
    Http::assertSentCount(1);
});

it('translates a Chinese web-novel chapter into English, one <br>-separated paragraph at a time', function () {
    fakeBookTranslations([
        '长相思' => 'Endless Longing',
        '第三章' => 'Chapter Three',
        '小六走进屋子。' => 'Xiao Liu walked into the room.',
        '男子睁开眼睛。' => 'The man opened his eyes.',
    ]);

    $html = <<<'HTML'
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>长相思</title><style>p { color: red }</style></head>
<body><article class="chapter-section" id="ch-0-2"><h3 class="chapter-title">第三章</h3><div class="chapter-text">
<br>&nbsp;&nbsp;&nbsp;&nbsp;小六走进屋子。<br><br>&nbsp;&nbsp;&nbsp;&nbsp;男子睁开眼睛。<br><br></div></article><pre>代码 不译</pre></body></html>
HTML;

    $result = translateBook($html, 'en', 'zh');
    $indent = str_repeat("\u{00A0}", 4);

    expect($result->html)
        ->toStartWith("<!DOCTYPE html>\n<html lang=\"en\">")
        ->toContain('<title>Endless Longing</title>')
        ->toContain('<style>p { color: red }</style>')
        ->toContain('<h3 class="chapter-title">Chapter Three</h3>')
        // The &nbsp; indents survive (as raw U+00A0, which renders identically).
        ->toContain("<br>{$indent}Xiao Liu walked into the room.<br><br>{$indent}The man opened his eyes.<br><br>")
        ->toContain('<pre>代码 不译</pre>')
        // Raw UTF-8 wherever text survives, never &#20195;-style entities.
        ->not->toContain('&#');

    expect($result->segments)->toBe(4)
        ->and($result->translated)->toBe(4)
        ->and($result->sections)->toBe(1); // the <title> joins the chapter after it
});

it('sends a chapter in order with the previous translations as context, and chapters side by side', function () {
    config([
        'services.translation.html.batch_chars' => 1, // one paragraph per request
        'services.translation.html.workers' => 2,
    ]);
    fakeBookTranslations([
        '甲章' => 'Chapter A', '一。' => 'One.', '二。' => 'Two.',
        '乙章' => 'Chapter B', '三。' => 'Three.',
    ]);
    $events = [];

    $result = translateBook(
        '<h2>甲章</h2><p>一。</p><p>二。</p><h2>乙章</h2><p>三。</p>',
        'en',
        'zh',
        onProgress: function (array $event) use (&$events) {
            $events[] = $event['type'].':'.$event['section'];
        },
    );

    expect($result->html)->toBe('<h2>Chapter A</h2><p>One.</p><p>Two.</p><h2>Chapter B</h2><p>Three.</p>')
        ->and($result->sections)->toBe(2);

    // Round by round: both chapters' next paragraph go out together.
    expect(sentParagraphs())->toBe([['甲章'], ['乙章'], ['一。'], ['三。'], ['二。']]);

    // "二。" is sent with its own chapter's translations as context — never the other's.
    $request = Http::recorded()->first(fn (array $pair) => bookPayload($pair[0]) === ['二。'])[0];
    expect($request->data()['messages'][1]['content'])
        ->toStartWith("Previous translated paragraphs (context only, do not return):\nChapter A\nOne.\n\n")
        ->not->toContain('Chapter B');

    expect($events)->toContain('section:1', 'section:2', 'batch:1', 'section_done:1', 'section_done:2');
});

it('retries a paragraph whose placeholders come back broken, then translates it node by node', function (string $answer) {
    fakeBookTranslations([
        'A <g1>b <g2>c</g2></g1> d' => $answer,
        'A' => '甲', 'b' => '乙', 'c' => '丙', 'd' => '丁',
    ]);

    $result = translateBook('<p>A <em>b <strong>c</strong></em> d<br>.</p>', 'zh-Hans', 'en');

    expect($result->html)->toBe('<p>甲 <em>乙 <strong>丙</strong></em> 丁<br>.</p>')
        ->and($result->translated)->toBe(0)
        ->and($result->fallbacks)->toBe(1)
        ->and($result->failed)->toBe(0);

    // Two tries as a whole (max_attempts = 2), then its text nodes in one batch.
    $whole = 'A <g1>b <g2>c</g2></g1> d';
    expect(sentParagraphs())->toBe([[$whole], [$whole], ['A', 'b', 'c', 'd']]);
})->with([
    'dropped' => ['甲<g1>乙丙</g1>丁'],
    'duplicated' => ['甲<g1>乙<g2>丙</g2></g1>丁<g2>丙</g2>'],
    'invented' => ['甲<g1>乙<g2>丙</g2></g1>丁<x3/>'],
    'misnested' => ['甲<g1>乙<g2>丙</g1></g2>丁'],
    'kind swapped' => ['甲<g1>乙<x2/></g1>丁'],
]);

it('accepts placeholders a model has respaced', function () {
    fakeBookTranslations(['Read <g1>this</g1> now.' => '现在读< g1 >这个</ g1 >。']);

    expect(translateBook('<p>Read <a href="#a">this</a> now.</p>', 'zh-Hans')->html)
        ->toBe('<p>现在读<a href="#a">这个</a>。</p>');
});

it('digs the JSON out of reasoning, fences and chatter', function () {
    Http::fake(['*/chat/completions' => Http::response([
        'choices' => [['message' => ['content' => "<think>{\"0\": \"wrong\"}</think>\nSure! ```json\n{\"0\": \"你好。\"}\n```"]]],
        'usage' => ['prompt_tokens' => 10, 'completion_tokens' => 5],
    ])]);

    expect(translateBook('<p>Hello.</p>', 'zh-Hans')->html)->toBe('<p>你好。</p>');
});

it('leaves a paragraph that never comes back untranslated, and counts it', function () {
    fakeBookTranslations([]); // the model omits it every time

    $result = translateBook('<p>Hello <em>world</em>.</p>', 'zh-Hans');

    expect($result->html)->toBe('<p>Hello <em>world</em>.</p>')
        ->and($result->failed)->toBe(1)
        ->and($result->translated)->toBe(0);
    Http::assertSentCount(2); // max_attempts
});

it('puts the glossary, character genders and what the text is into the prompt', function () {
    fakeBookTranslations(['小夭笑了。' => 'Xiaoyao smiled.']);

    translateBook(
        '<p>小夭笑了。</p>',
        'en',
        'zh',
        glossary: ['小夭' => 'Xiaoyao', '涂山璟' => 'Tushan Jing'],
        characters: ['小夭' => 'female'],
        about: 'a Chinese xianxia/historical romance novel',
    );

    Http::assertSent(function (Request $r) {
        $system = $r->data()['messages'][0]['content'];

        return str_contains($system, 'rendering a Chinese xianxia/historical romance novel from Chinese (Simplified) into polished, natural English')
            && str_contains($system, "Glossary (always use these renderings):\n小夭 = Xiaoyao\n涂山璟 = Tushan Jing")
            && str_contains($system, '小夭: female')
            && str_contains($system, 'pinyin');
    });
});

it('resumes from the cache without paying for finished paragraphs again', function () {
    fakeBookTranslations(['第一段。' => 'First.', '第二段。' => 'Second.']);
    $cache = tempnam(sys_get_temp_dir(), 'html_translator_cache_');
    unlink($cache);
    $html = '<p>第一段。</p><p>第二段。</p>';

    try {
        $first = translateBook($html, 'en', cachePath: $cache);
        $sent = Http::recorded()->count();

        $second = translateBook($html, 'en', cachePath: $cache);

        expect($second->html)->toBe($first->html)->toBe('<p>First.</p><p>Second.</p>')
            ->and($second->cached)->toBe(2)
            ->and(Http::recorded()->count())->toBe($sent);
    } finally {
        @unlink($cache);
    }
});

it('never pays to translate digits, punctuation or kept furniture', function () {
    fakeBookTranslations([]);

    $html = '<p>1867</p><p>[<a class="in-text-citation" href="#r9">9</a>]</p><pre>Some code</pre><div class="pageNumber">Page 12</div>';
    $result = translateBook($html, 'zh-Hans');

    expect($result->html)->toBe($html)
        ->and($result->segments)->toBe(0);
    Http::assertNothingSent();
});

/**
 * The citation author rides its anchor's placeholder.
 *
 * The linker wraps only the YEAR, so the author sat outside the anchor as
 * prose and the model translated it: a real en→zh run returned 22 of 101
 * citations as 墨菲1984 / 普拉沙德2007, Chinese author with an intact Latin
 * year, orphaned from a bibliography that is deliberately NOT translated.
 */
it('keeps the author with its citation, and leaves no wrapper behind', function () {
    $sent = [];
    Http::fake(['*/chat/completions' => function (Request $request) use (&$sent) {
        $reply = [];
        foreach (bookPayload($request) as $id => $text) {
            $sent[] = $text;
            $reply[$id] = str_replace('Driven by the NIEO', '受新国际经济秩序推动', $text);
        }

        return Http::response(['choices' => [['message' => ['content' => json_encode($reply, JSON_UNESCAPED_UNICODE | JSON_FORCE_OBJECT)]]],
            'usage' => ['prompt_tokens' => 10, 'completion_tokens' => 5]]);
    }]);

    $anchor = '<a class="in-text-citation" href="#united1974a">1974a</a>';
    $result = translateBook('<p>Driven by the NIEO (UN '.$anchor.').</p>', 'zh-Hans');

    // The author never reaches the model — it is inside the placeholder.
    expect($sent[0])->toContain('<x1/>')
        ->and($sent[0])->not->toContain('UN');
    // …and comes back exactly as it went in, with no synthetic wrapper left.
    expect($result->html)->toContain('UN '.$anchor)
        ->and($result->html)->not->toContain('data-translate-keep')
        ->and($result->html)->not->toContain('<span');
});

it('absorbs a narrative author, and leaves an anchor that has none alone', function () {
    $sent = [];
    Http::fake(['*/chat/completions' => function (Request $request) use (&$sent) {
        $reply = [];
        foreach (bookPayload($request) as $id => $text) {
            $sent[] = $text;
            $reply[$id] = $text;
        }

        return Http::response(['choices' => [['message' => ['content' => json_encode($reply, JSON_UNESCAPED_UNICODE | JSON_FORCE_OBJECT)]]],
            'usage' => ['prompt_tokens' => 10, 'completion_tokens' => 5]]);
    }]);

    $a = '<a class="in-text-citation" href="#p2007">2007</a>';
    $b = '<a class="in-text-citation" href="#u1974b">1974b</a>';
    // Narrative "Prashad (2007)", and a second anchor whose only neighbour is
    // a comma — it carries no author and is already kept verbatim alone.
    $result = translateBook('<p>According to Prashad ('.$a.') and UN ('.$b.', '.$b.').</p>', 'zh-Hans');

    expect($sent[0])->not->toContain('Prashad')
        ->and($sent[0])->not->toContain('UN');
    expect($result->html)->toContain('Prashad ('.$a.')')
        ->and($result->html)->not->toContain('data-translate-keep');
});

/**
 * The failure mode that would be WORSE than the bug: absorbing real prose
 * leaves untranslated English sitting inside the Chinese text.
 */
it('absorbs the author only — never the capitalised prose before it', function () {
    $sent = [];
    Http::fake(['*/chat/completions' => function (Request $request) use (&$sent) {
        $reply = [];
        foreach (bookPayload($request) as $id => $text) {
            $sent[] = $text;
            $reply[$id] = $text;
        }

        return Http::response(['choices' => [['message' => ['content' => json_encode($reply, JSON_UNESCAPED_UNICODE | JSON_FORCE_OBJECT)]]],
            'usage' => ['prompt_tokens' => 10, 'completion_tokens' => 5]]);
    }]);

    $anchor = '<a class="in-text-citation" href="#u1">1974a</a>';
    translateBook('<p>The New International Economic Order (UN '.$anchor.') mattered.</p>', 'zh-Hans');

    // Every word of the title is still translatable prose; only "UN" is kept.
    expect($sent[0])->toContain('The New International Economic Order (')
        ->and($sent[0])->toContain('mattered')
        ->and($sent[0])->not->toContain('UN ');
});

it('counts sections and paragraphs without sending anything', function () {
    fakeBookTranslations([]);

    expect(app(HtmlTranslator::class)->measure('<h2>One</h2><p>Hello <em>world</em>.</p><p>42</p><h2>Two</h2><p>Bye.</p>'))
        ->toBe(['sections' => 2, 'segments' => 4, 'chars' => mb_strlen('OneHello <g1>world</g1>.TwoBye.')]);
    Http::assertNothingSent();
});

it('refuses an unknown target before parsing or spending anything', function () {
    fakeBookTranslations([]);

    expect(fn () => translateBook('<p>Hello.</p>', 'klingon'))->toThrow(UnsupportedLanguageException::class);
    Http::assertNothingSent();
});

it('translates a book node by node as one document, handing each node back under its own key', function () {
    config(['services.translation.html.batch_chars' => 100]);
    fakeBookTranslations([
        '第一章' => 'Chapter One',
        '小六笑了。' => 'Xiao Liu smiled.',
        '男子点头。' => 'The man nodded.',
    ]);

    $result = app(HtmlTranslator::class)->translateFragments(
        ['n1' => '<h2 id="1">第一章</h2>', 'n2' => '<p id="2">小六笑了。</p>', 'n3' => '<p id="3">男子点头。'],
        'en',
        'zh',
    );

    expect($result->fragments)->toBe([
        'n1' => '<h2 id="1">Chapter One</h2>',
        'n2' => '<p id="2">Xiao Liu smiled.</p>',
        // An unclosed node is closed within its own wrapper, never its neighbour's.
        'n3' => '<p id="3">The man nodded.</p>',
    ])->and($result->complete())->toBeTrue();

    // One chapter, one request: the nodes travel together, in order.
    expect(sentParagraphs())->toBe([['第一章', '小六笑了。', '男子点头。']]);
});

it('stops at the deadline, leaving the rest pending rather than failed', function () {
    fakeBookTranslations([]);

    $result = app(HtmlTranslator::class)->translateFragments(
        ['n1' => '<p>小六笑了。</p>', 'n2' => '<p>男子点头。</p>'],
        'en',
        deadline: microtime(true) - 1,
    );

    expect($result->pending)->toBe(2)
        ->and($result->failed)->toBe(0)
        ->and($result->complete())->toBeFalse()
        ->and($result->fragments)->toBe(['n1' => '<p>小六笑了。</p>', 'n2' => '<p>男子点头。</p>']);
    Http::assertNothingSent();
});

// ── translate:html ──────────────────────────────────────────────────────────

/** A scratch directory holding book.html, removed after $test runs. */
function withBookFile(string $html, Closure $test): void
{
    $dir = sys_get_temp_dir().'/html_translator_'.uniqid();
    mkdir($dir);
    file_put_contents("{$dir}/book.html", $html);

    try {
        $test($dir);
    } finally {
        File::deleteDirectory($dir);
    }
}

it('reports a dry run without a key or a single request', function () {
    config(['services.llm.api_key' => null]);
    app()->forgetInstance(LlmService::class);
    fakeBookTranslations([]);

    withBookFile('<h2>一</h2><p>甲。</p><h2>二</h2><p>乙。</p>', function (string $dir) {
        $this->artisan('translate:html', ['input' => "{$dir}/book.html", '--to' => 'en', '--dry-run' => true])
            ->expectsOutput('2 sections, 4 paragraphs, 6 characters')
            ->assertSuccessful();
    });
    Http::assertNothingSent();
});

it('writes the translated book and its cache beside the input', function () {
    fakeBookTranslations(['长相思，在长安。' => "Endless longing, in Chang'an."]);

    withBookFile('<p>长相思，在长安。</p>', function (string $dir) {
        $this->artisan('translate:html', ['input' => "{$dir}/book.html", '--to' => 'en', '--from' => 'zh'])
            ->expectsOutputToContain('model: kimi-k3 | reasoning effort: low')
            ->expectsOutputToContain('1 translated whole')
            ->assertSuccessful();

        expect(file_get_contents("{$dir}/book_en.html"))->toBe("<p>Endless longing, in Chang'an.</p>")
            ->and(json_decode(file_get_contents("{$dir}/book_en.cache.json"), true))->toContain("Endless longing, in Chang'an.");
    });
});

it('does not write a partly translated book', function () {
    fakeBookTranslations(['第一段。' => 'First.']); // the second never comes back

    withBookFile('<p>第一段。</p><p>第二段。</p>', function (string $dir) {
        $this->artisan('translate:html', ['input' => "{$dir}/book.html", '--to' => 'en'])
            ->expectsOutputToContain('Rerun the same command to retry them')
            ->assertFailed();

        expect(file_exists("{$dir}/book_en.html"))->toBeFalse()
            ->and(file_exists("{$dir}/book_en.cache.json"))->toBeTrue(); // "First." is kept for the rerun
    });
});

it('refuses to start without an LLM key rather than failing every paragraph', function () {
    config(['services.llm.api_key' => null]);
    app()->forgetInstance(LlmService::class);
    fakeBookTranslations([]);

    withBookFile('<p>Hello.</p>', function (string $dir) {
        $this->artisan('translate:html', ['input' => "{$dir}/book.html", '--to' => 'zh-Hans'])
            ->expectsOutputToContain('LLM_API_KEY is not set')
            ->assertFailed();
    });
    Http::assertNothingSent();
});

it('rejects a glossary that is not a JSON object of strings', function () {
    fakeBookTranslations([]);

    withBookFile('<p>Hello.</p>', function (string $dir) {
        file_put_contents("{$dir}/glossary.json", '["not", "a", "map"]');

        $this->artisan('translate:html', ['input' => "{$dir}/book.html", '--to' => 'zh-Hans', '--glossary' => "{$dir}/glossary.json"])
            ->expectsOutputToContain('must be a JSON object of strings')
            ->assertFailed();
    });
    Http::assertNothingSent();
});
