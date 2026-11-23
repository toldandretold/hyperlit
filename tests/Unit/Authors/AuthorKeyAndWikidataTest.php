<?php

/**
 * The two pure pieces of author identity (docs/authors.md): the name key every
 * spelling comparison goes through, and the Wikidata entity parser.
 */

use App\Services\Authors\AuthorKey;
use App\Services\Authors\AuthorRegistry;
use App\Services\Authors\WikidataAuthorSource;

test('surname-first, punctuation, case and diacritics do not make a different person', function () {
    expect(AuthorKey::for('Marx, Karl'))->toBe(AuthorKey::for('Karl Marx'))
        ->and(AuthorKey::for('V.I. Lenin'))->toBe(AuthorKey::for('V. I. Lenin'))
        ->and(AuthorKey::for('Lenin, V. I.'))->toBe('v i lenin')
        ->and(AuthorKey::for('  ROSA   Luxemburg '))->toBe('rosa luxemburg')
        ->and(AuthorKey::for('Lénine, Vladimir'))->toBe('vladimir lenine');
});

test('other scripts are kept, not transliterated, and nothing looser than exact is merged', function () {
    expect(AuthorKey::for('Ленин'))->toBe('ленин')
        ->and(AuthorKey::for('Vladimir Lenin'))->not->toBe(AuthorKey::for('V. I. Lenin'))
        ->and(AuthorKey::for('J. Smith'))->not->toBe(AuthorKey::for('John Smith'));
});

test('a bare surname is not a matchable identity', function () {
    expect(AuthorKey::isMatchable(AuthorKey::for('Marx')))->toBeFalse()
        ->and(AuthorKey::isMatchable(AuthorKey::for('Karl Marx')))->toBeTrue()
        ->and(AuthorKey::isMatchable(''))->toBeFalse();
});

test('a multi-comma name is left alone rather than guessed at', function () {
    expect(AuthorKey::for('King, Martin Luther, Jr.'))->toBe('king martin luther jr');
});

test('the sort name is surname-first', function () {
    expect(AuthorRegistry::sortNameFor('Rosa Luxemburg'))->toBe('Luxemburg, Rosa')
        ->and(AuthorRegistry::sortNameFor('Plato'))->toBe('Plato');
});

test('a Wikidata entity yields the name, spellings in every script, dates and the linked ids', function () {
    $claim = fn (mixed $value, string $rank = 'normal') => ['rank' => $rank, 'mainsnak' => ['datavalue' => ['value' => $value]]];

    $parsed = WikidataAuthorSource::parse('Q1394', [
        'labels' => ['en' => ['value' => 'Vladimir Lenin'], 'ru' => ['value' => 'Владимир Ленин'], 'fr' => ['value' => 'Vladimir Lenin']],
        'aliases' => ['en' => [['value' => 'V. I. Lenin'], ['value' => 'Lenin']], 'ru' => [['value' => 'Ленин']]],
        'descriptions' => ['en' => ['value' => 'Russian revolutionary (1870–1924)']],
        'claims' => [
            'P31' => [$claim(['id' => 'Q5'])],
            'P569' => [$claim(['time' => '+1870-04-22T00:00:00Z'])],
            'P570' => [$claim(['time' => '+1924-01-21T00:00:00Z'])],
            'P648' => [$claim('OL1104A'), $claim('OL999A', 'deprecated')],
            'P10283' => [$claim('A5000000001')],
            'P214' => [$claim('7391706')],
        ],
    ]);

    expect($parsed['label'])->toBe('Vladimir Lenin')
        ->and($parsed['is_human'])->toBeTrue()
        ->and($parsed['born'])->toBe(1870)
        ->and($parsed['died'])->toBe(1924)
        ->and($parsed['open_library_ids'])->toBe(['OL1104A'])
        ->and($parsed['openalex_ids'])->toBe(['A5000000001'])
        ->and($parsed['viaf'])->toBe('7391706')
        ->and($parsed['orcid'])->toBeNull()
        ->and($parsed['description'])->toContain('Russian revolutionary')
        // English first, each spelling once, other scripts kept.
        ->and(array_slice($parsed['aliases'], 0, 3))->toBe(['Vladimir Lenin', 'V. I. Lenin', 'Lenin'])
        ->and($parsed['aliases'])->toContain('Владимир Ленин', 'Ленин')
        ->and(count($parsed['aliases']))->toBe(5);
});

test('an entity that is not a person says so, and BCE years stay negative', function () {
    $claim = fn (mixed $value) => ['mainsnak' => ['datavalue' => ['value' => $value]]];

    $org = WikidataAuthorSource::parse('Q1', ['labels' => ['en' => ['value' => 'Progress Publishers']], 'claims' => ['P31' => [$claim(['id' => 'Q2085381'])]]]);
    expect($org['is_human'])->toBeFalse()->and($org['born'])->toBeNull();

    $plato = WikidataAuthorSource::parse('Q859', ['labels' => ['en' => ['value' => 'Plato']], 'claims' => ['P569' => [$claim(['time' => '-0427-00-00T00:00:00Z'])]]]);
    expect($plato['born'])->toBe(-427);
});

test('only a well-formed QID is one', function () {
    expect(WikidataAuthorSource::isQid('Q1394'))->toBeTrue()
        ->and(WikidataAuthorSource::isQid('q1394'))->toBeFalse()
        ->and(WikidataAuthorSource::isQid('Q0'))->toBeFalse()
        ->and(WikidataAuthorSource::isQid('Q12; DROP'))->toBeFalse()
        ->and(WikidataAuthorSource::isQid(null))->toBeFalse();
});
