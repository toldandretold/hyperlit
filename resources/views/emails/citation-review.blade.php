<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Citation Review Complete</title>
</head>
<body style="margin: 0; padding: 0; background-color: #221F20; font-family: Inter, Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #221F20;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="max-width: 500px; width: 100%; background-color: #2A2A2A; border-radius: 12px;">
                    <!-- Logo + Heading -->
                    <tr>
                        <td style="padding: 40px 40px 16px;">
                            <table role="presentation" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="vertical-align: middle; padding-right: 14px;">
                                        <img src="{{ $logoUrl }}" alt="Hyperlit" width="40" height="40" style="display: block; width: 40px; height: 40px;">
                                    </td>
                                    <td style="vertical-align: middle;">
                                        <h1 style="margin: 0; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 24px; font-weight: 400; color: #CBCCCC;">
                                            AI Citation Review Complete
                                        </h1>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Book title -->
                    <tr>
                        <td style="padding: 0 40px 24px; color: #CBCCCC; font-size: 16px; font-weight: 600; line-height: 1.4;">
                            {{ $bookTitle }}
                        </td>
                    </tr>

                    <!-- Summary stats -->
                    <tr>
                        <td style="padding: 0 40px 24px; color: #888888; font-size: 14px; line-height: 1.5;">
                            {{ $citationCount }} citation occurrences across {{ $sourcesTotal }} unique sources
                        </td>
                    </tr>

                    <!-- Verdict distribution heading -->
                    <tr>
                        <td style="padding: 0 40px 12px; color: #CBCCCC; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                            Verdict Distribution
                        </td>
                    </tr>

                    <!-- Verdict bar chart -->
                    @php
                        $verdicts = [
                            ['label' => 'Confirmed',  'count' => $confirmed,  'color' => '#27ae60'],
                            ['label' => 'Likely',     'count' => $likely,     'color' => '#a3d977'],
                            ['label' => 'Plausible',  'count' => $plausible,  'color' => '#f1c40f'],
                            ['label' => 'Unlikely',   'count' => $unlikely,   'color' => '#e67e22'],
                            ['label' => 'Rejected',   'count' => $rejected,   'color' => '#e74c3c'],
                            ['label' => 'Unverified', 'count' => $unverified, 'color' => '#9b59b6'],
                        ];
                        $maxCount = max(1, ...array_column($verdicts, 'count'));
                    @endphp

                    @foreach ($verdicts as $verdict)
                        <tr>
                            <td style="padding: 0 40px 8px;">
                                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                    <tr>
                                        <td width="80" style="color: #CBCCCC; font-size: 12px; line-height: 1; vertical-align: middle; padding-right: 8px;">
                                            {{ $verdict['label'] }}
                                        </td>
                                        <td style="vertical-align: middle;">
                                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #1a1a1a; border-radius: 4px;">
                                                <tr>
                                                    @if ($verdict['count'] > 0)
                                                    <td style="width: {{ round(($verdict['count'] / $maxCount) * 100) }}%; background-color: {{ $verdict['color'] }}; border-radius: 4px; height: 20px; font-size: 11px; color: #ffffff; padding: 0 6px; text-align: right; line-height: 20px;">
                                                        {{ $verdict['count'] }}
                                                    </td>
                                                    @endif
                                                    <td style="height: 20px; font-size: 11px; color: #555555; padding: 0 6px; line-height: 20px;">
                                                        @if ($verdict['count'] === 0) 0 @else &nbsp; @endif
                                                    </td>
                                                </tr>
                                            </table>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                    @endforeach

                    <!-- Spacer -->
                    <tr><td style="padding: 8px 0;"></td></tr>

                    <!-- CTA links -->
                    <tr>
                        <td style="padding: 0 40px 12px; color: #CBCCCC; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                            View
                        </td>
                    </tr>

                    <tr>
                        <td align="center" style="padding: 0 40px 12px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td align="center" style="border-radius: 8px; background-color: #4EACAE;">
                                        <a href="{{ $reviewUrl }}" target="_blank" style="display: inline-block; padding: 14px 36px; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; width: 100%; box-sizing: border-box; text-align: center;">
                                            Full Report
                                        </a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td align="center" style="padding: 0 40px 40px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td align="center" style="border-radius: 8px; background-color: #D94F7A;">
                                        <a href="{{ $bookUrl }}" target="_blank" style="display: inline-block; padding: 14px 36px; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; width: 100%; box-sizing: border-box; text-align: center;">
                                            Highlights in Original
                                        </a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>

                <!-- Footer -->
                <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="max-width: 500px; width: 100%;">
                    <tr>
                        <td align="center" style="padding: 24px 40px 0; color: #555555; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 12px;">
                            Hyperlit
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
