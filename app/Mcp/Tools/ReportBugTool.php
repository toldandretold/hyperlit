<?php

namespace App\Mcp\Tools;

use App\Mail\McpBugReportMail;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\RateLimiter;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * Agent-filed bug report to the Hyperlit maintainer — the feedback channel
 * for when an MCP tool ITSELF malfunctions. Consent-gated: the token must
 * carry the 'report' ability (a checkbox at token creation), and without it
 * the tool is not even registered (shouldRegister), so an unconsented agent
 * never sees it. Identity is server-stamped; the report path follows the
 * IntegrityReportController invariant — a bug report must never itself 500,
 * so the mail is best-effort and failure still returns success (the log
 * line is the durable record either way).
 */
class ReportBugTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::REPORT;

    protected string $name = 'report_bug';

    protected string $description = 'File a bug report with the Hyperlit maintainer when a '
        .'Hyperlit MCP tool itself malfunctions — a crash, a wrong or garbled result, or a '
        .'nonsensical refusal. NOT for complaints about book content or other users\' writing, '
        .'and not for missing abilities (that\'s a token setting — see get_connected). Tell '
        .'the user before filing. The report carries their username and token name.';

    /** Reports allowed per user per hour — an agent loop must not spam the maintainer. */
    private const MAX_PER_HOUR = 5;

    // Visibility: the 'report' consent ability gates registration via the
    // HyperlitTool base shouldRegister — no override needed since the base
    // generalized to ability-sized listings.

    public function schema(JsonSchema $schema): array
    {
        return [
            'summary' => $schema->string()
                ->description('One-line summary of what went wrong (≤200 chars).')
                ->required(),
            'detail' => $schema->string()
                ->description('What you called, with what arguments, what you expected, and what actually happened (≤5000 chars).')
                ->required(),
            'tool_name' => $schema->string()
                ->description('The MCP tool that malfunctioned, if one did.'),
            'book' => $schema->string()
                ->description('Book id or slug involved, if any.'),
            'severity' => $schema->string()
                ->enum(['low', 'medium', 'high'])
                ->description('How badly it blocked the task.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $user = $this->user($request);

        $key = 'mcp-report-bug|'.$user->id;
        if (RateLimiter::tooManyAttempts($key, self::MAX_PER_HOUR)) {
            $minutes = (int) ceil(RateLimiter::availableIn($key) / 60);

            return Response::error(
                'Report limit reached ('.self::MAX_PER_HOUR.' per hour). '
                ."Try again in ~{$minutes} min, or batch what you found into one report then."
            );
        }
        RateLimiter::hit($key, 3600);

        $token = $user->currentAccessToken();

        // Book resolution is best-effort context, never a reason to refuse
        // the report — the whole point may be that resolution is broken.
        $book = trim((string) $request->get('book', ''));
        if ($book !== '') {
            try {
                $book = \App\Helpers\BookSlugHelper::resolve($book) ?: $book;
            } catch (\Throwable) {
                // keep the raw value the agent gave us
            }
        }

        $report = [
            // Server-stamped identity — never trusted from the agent.
            'user_id' => $user->id,
            'user_name' => $user->name,
            'token_name' => $token instanceof PersonalAccessToken ? $token->name : null,
            'token_abilities' => $token instanceof PersonalAccessToken ? ($token->abilities ?: []) : ['session'],
            'filed_at' => now()->toIso8601String(),
            // Agent-supplied content.
            'summary' => mb_substr(trim((string) $request->get('summary', '')), 0, 200),
            'detail' => mb_substr(trim((string) $request->get('detail', '')), 0, 5000),
            'tool_name' => trim((string) $request->get('tool_name', '')) ?: null,
            'book' => $book ?: null,
            'severity' => in_array($request->get('severity'), ['low', 'medium', 'high'], true)
                ? $request->get('severity') : null,
        ];

        if ($report['summary'] === '' || $report['detail'] === '') {
            return Response::error('A report needs both a summary and a detail.');
        }

        Log::warning('MCP bug report', $report);

        try {
            Mail::send(new McpBugReportMail($report));
        } catch (\Throwable $e) {
            Log::error('MCP bug report mail failed', ['error' => $e->getMessage()]);
        }

        return Response::text(
            'Report filed — the maintainer has been notified. Thank you. '
            .'Tell the user what you reported.'
        );
    }
}
