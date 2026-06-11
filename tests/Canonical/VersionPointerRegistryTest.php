<?php

/**
 * Pins the authority registry: which resolvers exist, their precedence order,
 * their declared statuses, and the SQL expression consumers derive from it.
 * If a test here fails because you reordered or added an authority, that must
 * be a deliberate decision — every ranking consumer follows this order.
 */

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\AuthorVersionResolver;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\BestVersionService;
use App\Services\CanonicalVersions\CommonsVersionResolver;
use App\Services\CanonicalVersions\PublisherVersionResolver;
use App\Services\CanonicalVersions\VersionPointerRegistry;
use App\Services\CanonicalVersions\VersionPointerResolver;

test('precedence order is author > publisher > commons > auto', function () {
    expect(VersionPointerRegistry::precedenceColumns())->toBe([
        'author_version_book',
        'publisher_version_book',
        'commons_version_book',
        'auto_version_book',
    ]);

    expect(VersionPointerRegistry::RESOLVERS)->toBe([
        AuthorVersionResolver::class,
        PublisherVersionResolver::class,
        CommonsVersionResolver::class,
        AutoVersionResolver::class,
    ]);
});

test('sql coalesce expression follows registry order', function () {
    expect(BestVersionService::sqlCoalesceExpression('c'))->toBe(
        'COALESCE(c.author_version_book, c.publisher_version_book, c.commons_version_book, c.auto_version_book)'
    );
});

test('SearchService derives version precedence from the registry (anti-drift)', function () {
    $source = file_get_contents(app_path('Services/SearchService.php'));

    // No pointer column may be hard-coded in the search SQL — the COALESCE
    // must come from BestVersionService::sqlCoalesceExpression.
    foreach (VersionPointerRegistry::precedenceColumns() as $column) {
        expect($source)->not->toContain($column);
    }
    expect($source)->toContain('sqlCoalesceExpression');
});

test('only the auto authority is active; dormant resolvers declare what they await', function () {
    $statuses = [];
    foreach (VersionPointerRegistry::resolvers() as $resolver) {
        $statuses[$resolver->pointerColumn()] = $resolver->status();

        if ($resolver->status() === VersionPointerResolver::STATUS_AWAITING_DEPENDENCY) {
            expect($resolver->awaiting())->toBeString()->not->toBeEmpty();
            // Dormant authorities must never resolve a version.
            expect($resolver->resolve(new CanonicalSource()))->toBeNull();
        }
    }

    expect($statuses)->toBe([
        'author_version_book'    => VersionPointerResolver::STATUS_AWAITING_DEPENDENCY,
        'publisher_version_book' => VersionPointerResolver::STATUS_AWAITING_DEPENDENCY,
        'commons_version_book'   => VersionPointerResolver::STATUS_AWAITING_DEPENDENCY,
        'auto_version_book'      => VersionPointerResolver::STATUS_ACTIVE,
    ]);
});

test('every canonical_source pointer column has exactly one resolver', function () {
    $columns = VersionPointerRegistry::precedenceColumns();
    expect($columns)->toBe(array_values(array_unique($columns)));
    expect(count(VersionPointerRegistry::RESOLVERS))->toBe(count($columns));
});
