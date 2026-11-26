<?php

use App\Services\Conversion\SourceWitness;
use Illuminate\Support\Facades\File;

/**
 * What a born-digital source says of its own structure — the evidence conversion:lint uses to
 * tell "the converter did this" from "the source prints it this way".
 */

uses(Tests\TestCase::class);

it('reads block openings, headings and unlinked raised numbers from markup', function () {
    $out = ['blocks' => [], 'headings' => [], 'bare_sups' => []];
    SourceWitness::read(
        '<h3>Capital &amp; labour. <em>Exchange value</em></h3>'
        . '<p class="fst">bastards, a large succession that made him a rich man</p>'
        . '<blockquote><p>A quoted passage of some length.</p></blockquote>'
        . '<p>accounts of profit.<sup class="ratio">29</sup> And a linked one.<sup><a href="#n1">1</a></sup></p>',
        $out,
    );

    expect($out['headings'])->toBe(['capitallabourexchangevalue']);
    expect($out['blocks'])->toHaveKey('bastardsalargesuccessionthatmadehimarich');
    expect($out['blocks'])->toHaveKey('aquotedpassageofsomelength');
    // The opening is keyed without note markers, so a renumbered marker still matches.
    expect(SourceWitness::opening('but by the capacity.<sup>[1]</sup>'))->toBe(SourceWitness::opening('but by the capacity.<sup>402</sup>'));
    expect(array_keys($out['bare_sups']))->toBe([SourceWitness::supKey('accounts of profit.', '29')]);
});

it('speaks only for a born-digital source — never for a PDF, even one with a saved landing page', function () {
    $book = 'unit_source_witness_' . bin2hex(random_bytes(4));
    $dir = resource_path("markdown/{$book}");
    try {
        expect(SourceWitness::for($book))->toBeNull();

        File::ensureDirectoryExists("{$dir}/epub_original/OEBPS");
        File::put("{$dir}/epub_original/OEBPS/p001.xhtml", '<html><body><p>A paragraph of the source itself.</p></body></html>');
        expect(SourceWitness::for($book)['blocks'])->toHaveKey('aparagraphofthesourceitself');

        File::deleteDirectory("{$dir}/epub_original");
        File::put("{$dir}/fetched_page.html", '<p>A paragraph of the landing page.</p>');
        expect(SourceWitness::for($book)['blocks'])->toHaveKey('aparagraphofthelandingpage');
        File::put("{$dir}/original.pdf", '%PDF');
        expect(SourceWitness::for($book))->toBeNull();
    } finally {
        File::deleteDirectory($dir);
    }
});
