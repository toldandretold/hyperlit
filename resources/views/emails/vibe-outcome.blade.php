<!DOCTYPE html>
<html>
<body style="margin:0; padding:20px; background:#221F20; color:#ddd; font-family:monospace; font-size:13px;">
    @php
        $outcome = $report['outcome'] ?? 'unknown';
        $colour = $outcome === 'clean' ? '#22c55e' : ($outcome === 'improved' ? '#f59e0b' : '#ef4444');
        $label = $outcome === 'clean' ? 'FIXED cleanly'
               : ($outcome === 'improved' ? 'IMPROVED (with caveat)' : "COULDN'T FIX");
    @endphp
    <h2 style="color:{{ $colour }}; margin:0 0 4px;">Vibe conversion — {{ $label }}</h2>
    <p style="color:#888; margin:0 0 16px;">Book <code>{{ $report['book'] ?? '?' }}</code></p>

    <table style="border-collapse:collapse; margin-bottom:16px;">
        <tr><td style="padding:2px 12px 2px 0; color:#888;">Baseline</td><td>{{ $report['baseline'] ?? '' }}</td></tr>
        @if(!empty($report['best']))
        <tr><td style="padding:2px 12px 2px 0; color:#888;">Best result</td><td>{{ $report['best'] }}</td></tr>
        @endif
        <tr><td style="padding:2px 12px 2px 0; color:#888;">Uncertain</td><td>{{ implode(', ', $report['flagged'] ?? []) ?: 'n/a' }}</td></tr>
        @if(!empty($report['issue_url']))
        <tr><td style="padding:2px 12px 2px 0; color:#888;">GitHub issue</td><td><a href="{{ $report['issue_url'] }}" style="color:#38bdf8;">{{ $report['issue_url'] }}</a></td></tr>
        @endif
    </table>

    <h3 style="color:#38bdf8;">What DeepSeek tried</h3>
    <table style="border-collapse:collapse; width:100%; font-size:12px;">
        <tr style="color:#888; text-align:left;">
            <th style="padding:4px 10px 4px 0;">#</th>
            <th style="padding:4px 10px 4px 0;">touched</th>
            <th style="padding:4px 10px 4px 0;">result</th>
            <th style="padding:4px 10px 4px 0;">why</th>
        </tr>
        @foreach($report['attempts'] ?? [] as $a)
        <tr style="border-top:1px solid #2a2a2a; vertical-align:top;">
            <td style="padding:6px 10px 6px 0;">{{ $a['attempt'] ?? '' }}</td>
            <td style="padding:6px 10px 6px 0; color:#cbd5e1;">{{ implode(', ', $a['touches'] ?? []) ?: '—' }}</td>
            <td style="padding:6px 10px 6px 0;">{{ $a['tier'] ?? '' }} <span style="color:#888;">({{ $a['stats'] ?? 'n/a' }})</span></td>
            <td style="padding:6px 10px 6px 0; color:#aaa;">{{ $a['why'] ?? '' }}</td>
        </tr>
        @if(!empty($a['diagnosis']))
        <tr><td></td><td colspan="3" style="padding:0 0 6px; color:#9ca3af; font-size:11px;">↪ {{ $a['diagnosis'] }}</td></tr>
        @endif
        @endforeach
    </table>

    <p style="color:#666; margin-top:20px; font-size:11px;">Full trace + patch attached (vibe_report.json / vibe_patch.json / assessment.json).</p>
</body>
</html>
