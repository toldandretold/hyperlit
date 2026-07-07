<?php

/**
 * AiBrainController::mathAwareText — math is stored as EMPTY <latex data-math="b64">
 * elements (KaTeX renders them client-side), so a plain strip_tags would silently
 * drop every equation from the context sent to the LLM. This inlines the decoded
 * LaTeX so "16 to 511" reaches the model instead of "  to  ".
 */

use App\Http\Controllers\AiBrainController;

function mathAware(string $html): string
{
    $c = app(AiBrainController::class);
    $m = new ReflectionMethod($c, 'mathAwareText');
    $m->setAccessible(true);
    return $m->invoke($c, $html);
}

test('inlines empty inline <latex> as $tex$', function () {
    $html = '<p>with <latex data-math="' . base64_encode('511') . '"></latex> participants</p>';
    expect(mathAware($html))->toBe('with $511$ participants');
});

test('inlines block <latex-block> as $$tex$$', function () {
    $html = '<latex-block data-math="' . base64_encode('E = mc^2') . '"></latex-block>';
    expect(mathAware($html))->toContain('$$E = mc^2$$');
});

test('keeps surrounding words when math is interleaved', function () {
    $a = '<latex data-math="' . base64_encode('16') . '"></latex>';
    $b = '<latex data-math="' . base64_encode('511') . '"></latex>';
    expect(mathAware("<p>with {$a} to {$b} participants</p>"))->toBe('with $16$ to $511$ participants');
});

test('plain content without math is just tag-stripped', function () {
    expect(mathAware('<p>hello <b>world</b></p>'))->toBe('hello world');
});
