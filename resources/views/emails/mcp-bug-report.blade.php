<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>MCP Bug Report</title>
</head>
<body style="margin:0; padding:20px; background:#221F20; color:#ddd; font-family:monospace; font-size:13px;">
    <h2 style="color:#ef4444;">MCP bug report (agent-filed)</h2>

    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr><td style="padding:4px 12px 4px 0; color:#888;">User</td><td>{{ $report['user_name'] ?? 'unknown' }} (id {{ $report['user_id'] ?? '?' }})</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Token</td><td>{{ $report['token_name'] ?? 'session' }} — abilities: {{ implode(', ', $report['token_abilities'] ?? []) }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Severity</td><td>{{ $report['severity'] ?? 'unspecified' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Tool</td><td>{{ $report['tool_name'] ?? 'unspecified' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Book</td><td>{{ $report['book'] ?? 'none' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Filed at</td><td>{{ $report['filed_at'] ?? '' }}</td></tr>
    </table>

    <h3 style="color:#f59e0b;">Summary</h3>
    <pre style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; overflow-x:auto; white-space:pre-wrap; word-break:break-word;">{{ $report['summary'] ?? '' }}</pre>

    <h3 style="color:#a78bfa;">Detail</h3>
    <pre style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; overflow-x:auto; white-space:pre-wrap; word-break:break-word;">{{ $report['detail'] ?? '' }}</pre>

    <p style="color:#888;">Filed by an AI agent via the report_bug MCP tool — the token carries the 'report' consent ability. Full payload attached as JSON; also logged (grep "MCP bug report" in laravel.log).</p>
</body>
</html>
