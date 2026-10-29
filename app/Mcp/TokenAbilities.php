<?php

namespace App\Mcp;

/**
 * The ability vocabulary for personal access tokens (and, in Phase 2, OAuth
 * scopes — the names are chosen to survive that mapping unchanged).
 *
 * - read:     library listing, search, book content, TOC, annotations,
 *             shelf listing, exports, import progress.
 * - annotate: create/update/delete hyperlights and hypercites, shelf writes.
 * - import:   file and URL document imports (free formats).
 * - spend:    anything that can charge the user's credits (PDF OCR import
 *             confirm; later TTS/translation). Deliberately separate so a
 *             read/annotate token can never trigger a charge.
 */
class TokenAbilities
{
    public const READ = 'read';

    public const ANNOTATE = 'annotate';

    public const IMPORT = 'import';

    public const SPEND = 'spend';

    /** @return list<string> */
    public static function all(): array
    {
        return [self::READ, self::ANNOTATE, self::IMPORT, self::SPEND];
    }
}
