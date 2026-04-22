<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Integrity Mismatch Report</title>
</head>
<body style="margin:0; padding:20px; background:#221F20; color:#ddd; font-family:monospace; font-size:13px;">
    <h2 style="color:#EF8D34;">Integrity Mismatch Report</h2>

    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Book ID</td><td>{{ $bookId }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Trigger</td><td>{{ $trigger ?? 'unknown' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">User</td><td>{{ $userName ?? 'anonymous' }} ({{ $userId ?? 'n/a' }})</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">URL</td><td>{{ $url ?? '' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">User Agent</td><td style="word-break:break-all;">{{ $userAgent ?? '' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Timestamp</td><td>{{ $timestamp ?? '' }}</td></tr>
        <tr><td style="padding:4px 12px 4px 0; color:#888;">Self-Healed</td><td>{{ !empty($selfHealed) ? 'Yes' : 'No' }}</td></tr>
    </table>

    @if(!empty($comment))
    <h3 style="color:#4EACAE;">User Comment</h3>
    <div style="padding:12px; background:#2A2A2A; border-radius:6px; margin-bottom:20px; white-space:pre-wrap;">{{ $comment }}</div>
    @endif

    @if(!empty($context))
    <h3 style="color:#38bdf8;">Session Context</h3>
    <table style="border-collapse:collapse; width:100%; margin-bottom:20px;">
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">DOM Nodes</td>
            <td>{{ $context['totalDomNodes'] ?? '?' }}</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">IDB Nodes</td>
            <td>{{ $context['totalIdbNodes'] ?? '?' }}</td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">Session Age</td>
            <td>
                @php
                    $sec = $context['sessionAgeSec'] ?? 0;
                    $h = intdiv($sec, 3600);
                    $m = intdiv($sec % 3600, 60);
                    $s = $sec % 60;
                @endphp
                {{ $h > 0 ? $h.'h ' : '' }}{{ $m }}m {{ $s }}s
            </td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">IDB Health</td>
            <td style="color:{{ !empty($context['idbBroken']) ? '#ef4444' : '#22c55e' }};">
                {{ !empty($context['idbBroken']) ? 'BROKEN' : 'OK' }}
            </td>
        </tr>
        <tr>
            <td style="padding:4px 12px 4px 0; color:#888;">PostgreSQL Nodes</td>
            <td>{{ $pgNodeCount ?? '?' }}</td>
        </tr>
    </table>
    @endif

    @if(!empty($selfHealed) && !empty($selfHealedNodeIds))
    <h3 style="color:#22c55e;">Self-Healing Summary</h3>
    <div style="padding:12px; background:#0f291a; border:1px solid #166534; border-radius:6px; margin-bottom:20px;">
        <p style="margin:0 0 8px; color:#4ade80;">Self-healing <strong>succeeded</strong> — {{ count($selfHealedNodeIds) }} node(s) re-queued and re-saved:</p>
        <p style="margin:0; color:#86efac; font-family:monospace;">{{ implode(', ', $selfHealedNodeIds) }}</p>
        <p style="margin:8px 0 0; color:#888; font-size:12px;">The mismatches/missing nodes below show what was wrong <em>before</em> self-healing fixed them.</p>
    </div>
    @endif

    @if(!empty($mismatches))
    <h3 style="color:#ef4444;">Mismatches ({{ count($mismatches) }})</h3>
    @foreach($mismatches as $m)
    <div style="margin-bottom:16px; padding:12px; background:#2A2A2A; border-radius:6px;">
        <strong>Node {{ $m['nodeId'] ?? '?' }}</strong><br>
        <span style="color:#888;">DOM:</span> {{ $m['domText'] ?? '' }}<br>
        <span style="color:#888;">IDB:</span> {{ $m['idbText'] ?? '' }}
    </div>
    @endforeach
    @endif

    @if(!empty($missingFromIDB))
    <h3 style="color:#f59e0b;">Missing from IDB ({{ count($missingFromIDB) }})</h3>
    @foreach($missingFromIDB as $m)
    <div style="margin-bottom:8px; padding:8px 12px; background:#2A2A2A; border-radius:6px;">
        <strong>&lt;{{ $m['tag'] ?? '?' }}&gt; #{{ $m['nodeId'] ?? '?' }}</strong>
        @if(!empty($m['domText']))
        <br><span style="color:#888;">Content:</span> {{ $m['domText'] }}
        @endif
    </div>
    @endforeach
    @endif

    @if(!empty($duplicateIds))
    <h3 style="color:#a78bfa;">Duplicate IDs ({{ count($duplicateIds) }})</h3>
    <p>@foreach($duplicateIds as $d){{ $d['id'] }} (x{{ $d['count'] }}){{ !$loop->last ? ', ' : '' }}@endforeach</p>
    @endif

    @if(!empty($recentLogs))
    <h3 style="color:#60a5fa;">Recent Console Logs ({{ count($recentLogs) }})</h3>
    <div style="padding:12px; background:#1a1a1a; border-radius:6px; overflow-x:auto;">
    @foreach($recentLogs as $log)
    <div style="margin-bottom:2px; color:{{ $log['level'] === 'error' ? '#ef4444' : ($log['level'] === 'warn' ? '#f59e0b' : '#9ca3af') }};">
        [{{ date('H:i:s', (int)($log['ts'] / 1000)) }}] {{ $log['msg'] }}
    </div>
    @endforeach
    </div>
    @endif

    @if(!empty($laravelLogs))
    <h3 style="color:#fb923c;">Server Logs ({{ count($laravelLogs) }})</h3>
    <div style="padding:12px; background:#1a1a1a; border-radius:6px; overflow-x:auto;">
    @foreach($laravelLogs as $line)
    <div style="margin-bottom:2px; color:#9ca3af; word-break:break-all;">{{ $line }}</div>
    @endforeach
    </div>
    @endif
</body>
</html>
