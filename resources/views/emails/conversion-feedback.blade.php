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

    @if(!empty($assessment))
    @php
        // A fork is "flagged" when the pipeline was unsure (low confidence) or fell through
        // to a default/unknown branch — the most likely place this conversion went wrong.
        $flagged = collect($assessment)->filter(function ($r) {
            $conf = $r['confidence'] ?? null;
            return ($conf !== null && $conf < 0.5)
                || stripos($r['margin'] ?? '', 'FALL-THROUGH') !== false;
        });
    @endphp
    <h3 style="color:#38bdf8;">Decision trace (assessment.json)</h3>
    <p style="color:#888; margin:0 0 8px;">What the pipeline decided at each fork — the path taken, the roads not taken, and how sure it was. The starting point for diagnosing/fixing this conversion (full structured trace attached).</p>

    @if($flagged->isNotEmpty())
    <div style="padding:10px 12px; background:#3a1d1d; border-left:3px solid #ef4444; border-radius:4px; margin-bottom:14px;">
        <strong style="color:#fca5a5;">⚠️ {{ $flagged->count() }} fork(s) flagged for review</strong>
        <div style="color:#fca5a5; font-size:12px; margin-top:4px;">low confidence or a fall-through/default branch — most likely where this conversion went wrong:</div>
        <ul style="margin:6px 0 0; padding-left:18px; color:#fca5a5; font-size:12px;">
        @foreach($flagged as $r)
            <li><span style="color:#f87171;">{{ $r['module'] ?? '' }}</span> — {{ $r['decision'] ?? '' }} <span style="color:#888;">(conf {{ $r['confidence'] ?? 'n/a' }})</span></li>
        @endforeach
        </ul>
    </div>
    @endif

    @foreach($assessment as $rec)
    @php
        $conf = $rec['confidence'] ?? null;
        $badge = $conf === null ? '#555' : ($conf >= 0.8 ? '#22c55e' : ($conf >= 0.5 ? '#f59e0b' : '#ef4444'));
        $margin = $rec['margin'] ?? '';
        $isFall = stripos($margin, 'FALL-THROUGH') !== false;
    @endphp
    <div style="padding:10px 12px; background:#1a1a1a; border-radius:6px; margin-bottom:10px; border-left:3px solid {{ $badge }};">
        <div style="margin-bottom:4px;">
            <span style="color:#60a5fa; font-weight:bold;">{{ $rec['module'] ?? '' }}</span>
            @if($conf !== null)<span style="color:{{ $badge }}; font-size:11px; margin-left:6px;">&#9679; confidence {{ $conf }}</span>@endif
        </div>
        <div style="color:#eee; margin-bottom:4px;">{{ $rec['decision'] ?? '' }}</div>
        @if($margin)
        <div style="color:{{ $isFall ? '#fca5a5' : '#fbbf24' }}; font-size:12px; margin-bottom:4px;">&#8618; {{ $margin }}</div>
        @endif
        @if(!empty($rec['rationale']))
        <div style="color:#aaa; font-size:12px; margin-bottom:4px;">{{ $rec['rationale'] }}</div>
        @endif
        @if(!empty($rec['considered']))
        <div style="color:#888; font-size:11px; margin:4px 0 2px;">Roads not taken:</div>
        <ul style="margin:0 0 4px; padding-left:16px; color:#9ca3af; font-size:11px;">
            @foreach($rec['considered'] as $alt)
            <li><span style="color:#cbd5e1;">{{ $alt['option'] ?? '' }}</span> — {{ $alt['rejected_because'] ?? '' }}@if(!empty($alt['would_need']))<span style="color:#71717a;"> &middot; would need: {{ $alt['would_need'] }}</span>@endif</li>
            @endforeach
        </ul>
        @endif
        <div style="color:#666; font-family:monospace; font-size:10px;">{{ $rec['code_ref'] ?? '' }}</div>
    </div>
    @endforeach
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
