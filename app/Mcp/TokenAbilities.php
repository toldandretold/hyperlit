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
 * - write:    create/edit nodes in books the user owns, and complete two-way
 *             hypercites into them. Deliberately separate from annotate so an
 *             annotation token can never rewrite book content. Edits ride the
 *             standard node write path, so nodes_history versions every change
 *             (the restore story that gated this ability).
 * - spend:    anything that can charge the user's credits (PDF OCR import
 *             confirm; later TTS/translation). Deliberately separate so a
 *             read/annotate token can never trigger a charge.
 * - report:   CONSENT for the agent to file a bug report with the Hyperlit
 *             maintainer when an MCP tool malfunctions (report_bug). Reports
 *             carry the username and token name, so this is a consent gate
 *             (checkbox at token creation, default on), not a capability —
 *             the tool is hidden from tokens without it.
 */
class TokenAbilities
{
    public const READ = 'read';

    public const ANNOTATE = 'annotate';

    public const IMPORT = 'import';

    public const WRITE = 'write';

    public const SPEND = 'spend';

    public const REPORT = 'report';

    /** @return list<string> */
    public static function all(): array
    {
        return [self::READ, self::ANNOTATE, self::IMPORT, self::WRITE, self::SPEND, self::REPORT];
    }
}
