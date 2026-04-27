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

    <p style="color:#888; margin-top:20px; font-size:11px;">
        Attached: ocr_response.json, debug_converted.html, references.json (if available)
    </p>
</body>
</html>
