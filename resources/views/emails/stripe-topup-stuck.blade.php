<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Stuck Stripe top-ups</title>
</head>
<body style="margin:0; padding:20px; background:#221F20; color:#ddd; font-family:monospace; font-size:13px;">
    <h2 style="color:#ef8d34;">{{ count($problems) }} Stripe top-up(s) need attention</h2>

    <p style="margin:0 0 16px; color:#bbb;">
        These sessions are PAID on Stripe (or Stripe was unreachable) but could not be credited by the
        reconciliation sweep — a paying user may be left short. Check Stripe's dashboard for each session.
        @if($recoveredCount > 0)
            <br><span style="color:#7bbf7b;">({{ $recoveredCount }} other stuck session(s) were auto-credited this run — no action needed.)</span>
        @endif
    </p>

    <table style="border-collapse:collapse; width:100%;">
        <tr>
            <th style="text-align:left; padding:6px 12px 6px 0; color:#888; border-bottom:1px solid #444;">Session</th>
            <th style="text-align:left; padding:6px 12px 6px 0; color:#888; border-bottom:1px solid #444;">User</th>
            <th style="text-align:left; padding:6px 12px 6px 0; color:#888; border-bottom:1px solid #444;">Amount</th>
            <th style="text-align:left; padding:6px 12px 6px 0; color:#888; border-bottom:1px solid #444;">Created</th>
            <th style="text-align:left; padding:6px 12px 6px 0; color:#888; border-bottom:1px solid #444;">Reason</th>
        </tr>
        @foreach($problems as $p)
        <tr>
            <td style="padding:6px 12px 6px 0; border-bottom:1px solid #333;">{{ $p['session_id'] }}</td>
            <td style="padding:6px 12px 6px 0; border-bottom:1px solid #333;">{{ $p['user_id'] }}</td>
            <td style="padding:6px 12px 6px 0; border-bottom:1px solid #333;">${{ number_format($p['amount'], 2) }}</td>
            <td style="padding:6px 12px 6px 0; border-bottom:1px solid #333;">{{ $p['created_at'] }}</td>
            <td style="padding:6px 12px 6px 0; border-bottom:1px solid #333; color:#e08">{{ $p['reason'] }}</td>
        </tr>
        @endforeach
    </table>
</body>
</html>
