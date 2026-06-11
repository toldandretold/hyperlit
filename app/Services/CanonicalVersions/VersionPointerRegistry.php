<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;

/**
 * THE single source of truth for which version authorities exist and their
 * precedence order. Everything that ranks versions — the best-version endpoint,
 * the citation-search SQL, future report provenance — must derive its order
 * from here (directly or via BestVersionService), never hard-code it.
 *
 * Adding a new authority = add a resolver class + insert it in RESOLVERS at
 * its precedence position. Nothing else should need to change.
 */
final class VersionPointerRegistry
{
    /**
     * Resolver classes in PRECEDENCE order (highest authority first).
     * Order rationale: identity-verified humans (author, then publisher)
     * outrank community consensus, which outranks the untampered-but-unreviewed
     * machine version.
     *
     * @var list<class-string<VersionPointerResolver>>
     */
    public const RESOLVERS = [
        AuthorVersionResolver::class,
        PublisherVersionResolver::class,
        CommonsVersionResolver::class,
        AutoVersionResolver::class,
    ];

    /** @return list<VersionPointerResolver> instantiated, in precedence order */
    public static function resolvers(): array
    {
        return array_map(fn (string $class) => new $class(), self::RESOLVERS);
    }

    /** @return list<string> pointer columns in precedence order */
    public static function precedenceColumns(): array
    {
        return array_map(
            fn (VersionPointerResolver $r) => $r->pointerColumn(),
            self::resolvers(),
        );
    }

    /**
     * Run every resolver against a canonical, assigning any pointer that is
     * currently unset and has an eligible version. Returns only the pointers
     * that hold a value after the sweep: ['auto_version_book' => 'book_…'].
     *
     * This is the one entry point automated flows should use (the
     * auto-versions command today; the citation pipeline's post-OCR hook in
     * Phase 2), so a canonical is always evaluated by ALL authorities.
     */
    public static function syncAll(CanonicalSource $canonical, bool $force = false): array
    {
        $assigned = [];
        foreach (self::resolvers() as $resolver) {
            $book = $resolver->assign($canonical, $force);
            if ($book !== null) {
                $assigned[$resolver->pointerColumn()] = $book;
            }
        }

        return $assigned;
    }
}
