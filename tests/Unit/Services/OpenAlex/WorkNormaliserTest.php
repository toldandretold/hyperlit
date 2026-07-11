<?php

/**
 * Characterization tests for OpenAlexService's normalization layer
 * (normaliseWork / reconstructAbstract / generateBibtex), written BEFORE
 * the facade modularization so the extracted WorkNormaliser module can be
 * verified as pure code motion. Must pass identically before and after.
 */

use App\Services\OpenAlexService;
use Tests\TestCase;

uses(TestCase::class);

$svc = fn () => app(OpenAlexService::class);

function rawOpenAlexWork(array $overrides = []): array
{
    return array_replace_recursive([
        'id' => 'https://openalex.org/W2126853606',
        'title' => 'A Brief History of Neoliberalism',
        'type' => 'book',
        'language' => 'en',
        'publication_year' => 2005,
        'cited_by_count' => 12345,
        'doi' => 'https://doi.org/10.1093/oso/9780199283262.001.0001',
        'authorships' => [
            [
                'author' => [
                    'id' => 'https://openalex.org/A5017898742',
                    'display_name' => 'David Harvey',
                    'orcid' => 'https://orcid.org/0000-0001-2345-6789',
                ],
                'author_position' => 'first',
                'is_corresponding' => true,
            ],
        ],
        'primary_location' => [
            'pdf_url' => null,
            'license' => 'cc-by',
            'source' => [
                'display_name' => 'Oxford University Press eBooks',
                'host_organization_name' => 'Oxford University Press',
            ],
        ],
        'best_oa_location' => [
            'pdf_url' => 'https://example.org/harvey2005.pdf',
        ],
        'open_access' => [
            'is_oa' => true,
            'oa_status' => 'bronze',
            'oa_url' => 'https://example.org/harvey2005',
        ],
        'biblio' => [
            'volume' => '1',
            'issue' => '2',
            'first_page' => '10',
            'last_page' => '20',
        ],
        'abstract_inverted_index' => [
            'Neoliberalism' => [0],
            'is' => [1],
            'everywhere' => [2],
        ],
    ], $overrides);
}

// -------------------------------------------------------------- normaliseWork

test('normaliseWork produces the shared citation shape from a raw work', function () use ($svc) {
    $n = $svc()->normaliseWork(rawOpenAlexWork());

    expect($n['openalex_id'])->toBe('W2126853606');
    expect($n['title'])->toBe('A Brief History of Neoliberalism');
    expect($n['author'])->toBe('David Harvey');
    expect($n['doi'])->toBe('10.1093/oso/9780199283262.001.0001'); // https prefix stripped
    expect($n['year'])->toBe(2005);
    expect($n['journal'])->toBe('Oxford University Press eBooks');
    expect($n['publisher'])->toBe('Oxford University Press');
    expect($n['is_oa'])->toBeTrue();
    expect($n['oa_status'])->toBe('bronze');
    expect($n['oa_url'])->toBe('https://example.org/harvey2005');
    expect($n['pdf_url'])->toBe('https://example.org/harvey2005.pdf'); // best_oa fallback
    expect($n['work_license'])->toBe('cc-by');
    expect($n['pages'])->toBe('10–20'); // en dash join
    expect($n['source'])->toBe('openalex');
    expect($n['book'])->toBeNull();
    expect($n['has_nodes'])->toBeFalse();
    expect($n['abstract'])->toBe('Neoliberalism is everywhere');
});

test('normaliseWork keeps only the first three authors joined by semicolons', function () use ($svc) {
    $work = rawOpenAlexWork();
    $work['authorships'] = array_map(fn ($name) => [
        'author' => ['id' => null, 'display_name' => $name, 'orcid' => null],
        'author_position' => 'middle',
        'is_corresponding' => false,
    ], ['One Author', 'Two Author', 'Three Author', 'Four Author']);

    $n = $svc()->normaliseWork($work);
    expect($n['author'])->toBe('One Author; Two Author; Three Author');
    // but structured authorships keep everyone
    expect($n['authorships'])->toHaveCount(4);
});

test('normaliseWork strips the ORCID url prefix in structured authorships', function () use ($svc) {
    $n = $svc()->normaliseWork(rawOpenAlexWork());
    expect($n['authorships'][0]['orcid'])->toBe('0000-0001-2345-6789');
    expect($n['authorships'][0]['openalex_author_id'])->toBe('A5017898742');
    expect($n['authorships'][0]['is_corresponding'])->toBeTrue();
});

test('normaliseWork nulls out invalid or non-http urls', function () use ($svc) {
    $work = rawOpenAlexWork([
        'open_access' => ['oa_url' => 'ftp://bad.example.org/x'],
        'best_oa_location' => ['pdf_url' => 'not a url'],
    ]);
    $n = $svc()->normaliseWork($work);
    expect($n['oa_url'])->toBeNull();
    expect($n['pdf_url'])->toBeNull();
});

test('normaliseWork tolerates a minimal work object', function () use ($svc) {
    $n = $svc()->normaliseWork(['id' => 'https://openalex.org/W1']);
    expect($n['openalex_id'])->toBe('W1');
    expect($n['title'])->toBeNull();
    expect($n['author'])->toBeNull();
    expect($n['pages'])->toBeNull();
    expect($n['abstract'])->toBeNull();
});

// -------------------------------------------------------- reconstructAbstract

test('reconstructAbstract rebuilds word order from the inverted index', function () {
    $abstract = OpenAlexService::reconstructAbstract([
        'world' => [1],
        'hello' => [0],
        'again' => [2, 4],
        'and' => [3],
    ]);
    expect($abstract)->toBe('hello world again and again');
});

test('reconstructAbstract returns null for empty input', function () {
    expect(OpenAlexService::reconstructAbstract(null))->toBeNull();
    expect(OpenAlexService::reconstructAbstract([]))->toBeNull();
});

// -------------------------------------------------------------- generateBibtex

test('generateBibtex maps types and formats authors as Last, First', function () use ($svc) {
    $bibtex = $svc()->generateBibtex(rawOpenAlexWork());

    expect($bibtex)->toStartWith('@book{W2126853606,');
    expect($bibtex)->toContain('author = {Harvey, David}');
    expect($bibtex)->toContain('title = {A Brief History of Neoliberalism}');
    expect($bibtex)->toContain('year = {2005}');
    expect($bibtex)->toContain('doi = {10.1093/oso/9780199283262.001.0001}');
    expect($bibtex)->toContain('pages = {10--20}');
});

test('generateBibtex uses @article for journal-article and booktitle for inproceedings', function () use ($svc) {
    $article = $svc()->generateBibtex(rawOpenAlexWork(['type' => 'journal-article']));
    expect($article)->toStartWith('@article{');
    expect($article)->toContain('journal = {Oxford University Press eBooks}');

    $proceedings = $svc()->generateBibtex(rawOpenAlexWork(['type' => 'conference']));
    expect($proceedings)->toStartWith('@inproceedings{');
    expect($proceedings)->toContain('booktitle = {Oxford University Press eBooks}');
});

test('generateBibtex escapes braces in field values', function () use ($svc) {
    $bibtex = $svc()->generateBibtex(rawOpenAlexWork(['title' => 'Braces {and} more']));
    expect($bibtex)->toContain('title = {Braces \\{and\\} more}');
});
