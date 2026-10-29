<?php

namespace App\Services\Annotations;

class AnchorAmbiguousException extends \RuntimeException
{
    /**
     * @param  array<int, string>  $contexts  one ±40-char context snippet per match, 1-indexed order
     */
    public function __construct(public readonly array $contexts)
    {
        parent::__construct('The quote appears '.count($contexts).' times in the book.');
    }
}
