<?php

namespace App\Services\Translation;

/**
 * The requested target language cannot be served. Distinct from
 * TranslationProviderException (a transport/model failure) because this is a
 * 422 the caller can act on, not a 5xx.
 *
 * `reason` separates the two cases, which need different messages:
 *   'unknown'     — no such language in the registry; the caller's mistake.
 *   'unsupported' — a real language the CURRENT model enumerates as absent
 *                   (Hy-MT2 has no Punjabi). Another provider may well do it.
 */
class UnsupportedLanguageException extends \InvalidArgumentException
{
    public const REASON_UNKNOWN = 'unknown';

    public const REASON_UNSUPPORTED = 'unsupported';

    public function __construct(
        string $message,
        public readonly string $reason,
        public readonly ?string $requestedCode = null,
    ) {
        parent::__construct($message);
    }
}
