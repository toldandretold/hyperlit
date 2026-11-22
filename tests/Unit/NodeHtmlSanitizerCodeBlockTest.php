<?php

use App\Services\Security\NodeHtmlSanitizer as S;

/**
 * Code blocks through the write-path sanitiser.
 *
 * A code block's TEXT routinely looks like an attack — `<div onclick="…">`,
 * `javascript:` in a comment, or just `one = 1` (which the cheap on*= pre-filter
 * matches) — so code content trips looksDangerous() and takes the DOM scrub. The
 * contract still holds there: escaped markup is TEXT and must come back byte for
 * byte (whitespace, tabs, entities, language class), while a REAL element posted
 * inside a <pre> is stripped like anywhere else. NodeHtmlSanitizer is
 * denylist-based, so these are pinned explicitly.
 */

dataset('code_blocks_that_look_dangerous', [
    'escaped handler markup' => '<pre id="100" data-node-id="book_1_a"><code class="language-xml">&lt;div onclick="go()"&gt;\n  &lt;p&gt;Tom &amp;amp; Jerry&lt;/p&gt;\n&lt;/div&gt;</code></pre>',
    'escaped script tag' => '<pre id="101"><code class="language-html">&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
    'js scheme in a comment' => '<pre id="102"><code class="language-javascript">// link: javascript:void(0)\nconst one = 1;</code></pre>',
    'python one = 1 with tabs' => "<pre id=\"103\"><code class=\"language-python\">def f():\n\tone = 1\n\treturn one  # ‘quotes’ “too”</code></pre>",
    'data html in a string' => '<pre id="104"><code>url = "data:text/html,&lt;b&gt;hi&lt;/b&gt;"</code></pre>',
]);

test('a code block whose TEXT looks dangerous is stored byte-for-byte', function (string $html) {
    expect(S::clean($html))->toBe($html);
})->with('code_blocks_that_look_dangerous');

test('a real element smuggled into a code block is still stripped', function () {
    $out = S::clean('<pre id="200"><code class="language-js">let a = 1;<script>alert(1)</script><img src=x onerror="alert(2)"></code></pre>');
    expect($out)->not->toMatch('/<\s*script\b/i');
    expect($out)->not->toMatch('/\son[a-z]+\s*=/i');
    expect($out)->toContain('let a = 1;');
    expect($out)->toContain('class="language-js"');
});

test('a javascript: href inside a code block is neutralised, its text kept', function () {
    $out = S::clean('<pre><code><a href="javascript:alert(1)">click</a> and text</code></pre>');
    expect($out)->not->toMatch('/javascript\s*:/i');
    expect($out)->toContain('click')->toContain('and text');
});
