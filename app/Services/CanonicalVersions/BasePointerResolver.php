<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;

abstract class BasePointerResolver implements VersionPointerResolver
{
    public function awaiting(): ?string
    {
        return null;
    }

    final public function assign(CanonicalSource $canonical, bool $force = false): ?string
    {
        $column = $this->pointerColumn();

        if (!$force && !empty($canonical->{$column})) {
            return $canonical->{$column};
        }

        $book = $this->resolve($canonical);

        if ($book === null || $book === $canonical->{$column}) {
            return $book;
        }

        $canonical->{$column} = $book;
        $canonical->save();

        return $book;
    }
}
