<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Paste Conversion Glitch</title>
</head>
<body style="margin:0; padding:20px; background:#221F20; color:#ddd; font-family:monospace; font-size:13px;">
    <h2 style="color:#EF8D34;">Paste Conversion Glitch</h2>

    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Book ID</td><td>{{ $bookId }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">User</td><td>{{ $userName ?? 'anonymous' }} ({{ $userId ?? 'n/a' }})</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">URL</td><td style="word-break:break-all;">{{ $url ?? '' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">User Agent</td><td style="word-break:break-all;">{{ $userAgent ?? '' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Timestamp</td><td>{{ $timestamp ?? '' }}</td></tr>
    </table>

    @if(!empty($conversionSummary))
    <h3 style="color:#4EACAE;">Conversion Summary</h3>
    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Format Type</td>
            <td>{{ $conversionSummary['formatType'] ?? 'unknown' }}</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Source</td>
            <td>
                @if(!empty($conversionSummary['wasMarkdown']))
                    Markdown
                @elseif(!empty($conversionSummary['wasHtml']))
                    HTML
                @else
                    Plain text
                @endif
            </td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Footnotes</td>
            <td>{{ $conversionSummary['footnoteCount'] ?? 0 }}</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">References</td>
            <td>{{ $conversionSummary['referenceCount'] ?? 0 }}</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Nodes Pasted</td>
            <td>{{ $conversionSummary['nodeCount'] ?? '?' }}</td>
        </tr>
    </table>
    @endif

    @if(!empty($pastedContent) || !empty($pasteLogs))
    <h3 style="color:#a78bfa;">Attachments</h3>
    <ul style="margin:0 0 20px 0; padding-left:20px; color:#ccc;">
        @if(!empty($pastedContent))
        <li>pasted-content.md — raw clipboard content ({{ number_format(strlen($pastedContent)) }} bytes)</li>
        @endif
        @if(!empty($pasteLogs))
        <li>paste-logs.txt — {{ count($pasteLogs) }} log lines captured during paste</li>
        @endif
    </ul>
    @endif

    @if(!empty($recentLogs))
    <h3 style="color:#60a5fa;">Recent Console Logs ({{ count($recentLogs) }})</h3>
    <div style="padding:12px; background:#1a1a1a; border-radius:6px; overflow-x:auto;">
    @foreach($recentLogs as $log)
    <div style="margin-bottom:2px; color:{{ ($log['level'] ?? '') === 'error' ? '#ef4444' : (($log['level'] ?? '') === 'warn' ? '#f59e0b' : '#9ca3af') }};">
        [{{ date('H:i:s', (int)(($log['ts'] ?? 0) / 1000)) }}] {{ $log['msg'] ?? '' }}
    </div>
    @endforeach
    </div>
    @endif
</body>
</html>
