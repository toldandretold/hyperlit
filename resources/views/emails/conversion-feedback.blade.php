<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Conversion Feedback</title>
</head>
<body style="margin:0; padding:20px; background:#221F20; color:#ddd; font-family:monospace; font-size:13px;">
    <h2 style="color:{{ ($rating ?? 'good') === 'bad' ? '#ef4444' : '#22c55e' }};">
        Conversion {{ ($rating ?? 'good') === 'bad' ? 'Issue Report' : 'Looks Good' }}
    </h2>

    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Book ID</td><td>{{ $bookId ?? 'unknown' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Rating</td>
            <td style="color:{{ ($rating ?? 'good') === 'bad' ? '#ef4444' : '#22c55e' }}; font-weight:bold;">
                {{ strtoupper($rating ?? 'unknown') }}
            </td>
        </tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">User</td><td>{{ $userName ?? 'anonymous' }} ({{ $userId ?? 'n/a' }})</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">User Agent</td><td style="word-break:break-all;">{{ $userAgent ?? '' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Timestamp</td><td>{{ $timestamp ?? '' }}</td></tr>
    </table>

    @if(!empty($comment))
    <h3 style="color:#22c55e;">User comment</h3>
    <div style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; white-space:pre-wrap; word-break:break-word;">{{ $comment }}</div>
    @endif

    @if(!empty($conversionStats))
    <h3 style="color:#4EACAE;">Conversion Stats</h3>
    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">References Found</td>
            <td>{{ $conversionStats['references_found'] ?? 0 }}</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Citations</td>
            <td>{{ $conversionStats['citations_linked'] ?? 0 }} / {{ $conversionStats['citations_total'] ?? 0 }} linked</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Footnotes Matched</td>
            <td>{{ $conversionStats['footnotes_matched'] ?? 0 }}</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Footnote Strategy</td>
            <td>{{ $conversionStats['footnote_strategy'] ?? 'unknown' }}</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Citation Style</td>
            <td>{{ $conversionStats['citation_style'] ?? 'unknown' }}</td>
        </tr>
    </table>
    @endif

    @if(!empty($footnoteAudit))
    <h3 style="color:#38bdf8;">Footnote Audit</h3>
    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Total Refs</td>
            <td>{{ $footnoteAudit['total_refs'] ?? 0 }}</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Total Defs</td>
            <td>{{ $footnoteAudit['total_defs'] ?? 0 }}</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Gaps</td>
            <td style="color:{{ count($footnoteAudit['gaps'] ?? []) > 0 ? '#ef4444' : '#22c55e' }};">
                {{ count($footnoteAudit['gaps'] ?? []) }}
            </td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Unmatched Refs</td>
            <td style="color:{{ count($footnoteAudit['unmatched_refs'] ?? []) > 0 ? '#ef4444' : '#22c55e' }};">
                {{ count($footnoteAudit['unmatched_refs'] ?? []) }}
            </td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Unmatched Defs</td>
            <td style="color:{{ count($footnoteAudit['unmatched_defs'] ?? []) > 0 ? '#ef4444' : '#22c55e' }};">
                {{ count($footnoteAudit['unmatched_defs'] ?? []) }}
            </td>
        </tr>
    </table>
    @endif

    @if(!empty($recentLogs))
    <h3 style="color:#60a5fa;">Recent console logs ({{ count($recentLogs) }})</h3>
    <div style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; overflow-x:auto;">
    @foreach($recentLogs as $log)
    <div style="margin-bottom:2px; color:{{ ($log['level'] ?? '') === 'error' ? '#ef4444' : (($log['level'] ?? '') === 'warn' ? '#f59e0b' : '#9ca3af') }};">
        [{{ date('H:i:s', (int)(($log['ts'] ?? 0) / 1000)) }}] {{ $log['msg'] ?? '' }}
    </div>
    @endforeach
    </div>
    @endif

    @if(!empty($laravelLogs))
    <h3 style="color:#38bdf8;">Laravel log (grep {{ $bookId ?? '' }})</h3>
    <div style="padding:12px; background:#1a1a1a; border-radius:6px; margin-bottom:20px; overflow-x:auto;">
    @foreach($laravelLogs as $line)
    <div style="margin-bottom:2px; color:#9ca3af; white-space:pre-wrap; word-break:break-word;">{{ $line }}</div>
    @endforeach
    </div>
    @endif

    <p style="color:#888; margin-top:20px; font-size:11px;">
        Attached: ocr_response.json, debug_converted.html, references.json, conversion_stats.json (if available)
    </p>
</body>
</html>
