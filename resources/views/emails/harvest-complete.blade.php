<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Harvest Complete</title>
</head>
<body style="margin: 0; padding: 0; background-color: #221F20; font-family: Inter, Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #221F20;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="max-width: 500px; width: 100%; background-color: #2A2A2A; border-radius: 12px;">
                    <!-- Heading -->
                    <tr>
                        <td style="padding: 40px 40px 16px;">
                            <h1 style="margin: 0; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 24px; font-weight: 600; color: #EF8D34;">
                                Source Harvest Complete
                            </h1>
                        </td>
                    </tr>

                    <!-- Body text -->
                    <tr>
                        <td style="padding: 0 40px 28px; color: #CBCCCC; font-size: 15px; line-height: 1.6;">
                            The knowledge network of <strong style="color: #ffffff;">{{ $title }}</strong> has been harvested: the open-access works it cites are now in the library as verified source texts, linked from its citations.
                        </td>
                    </tr>

                    @php
                        $imported = ($counts['assigned'] ?? 0) + ($counts['assigned_existing'] ?? 0);
                        $failed = ($counts['fetch_failed'] ?? 0) + ($counts['ocr_failed'] ?? 0);
                    @endphp
                    <tr>
                        <td style="padding: 0 40px 28px; color: #888888; font-size: 13px; line-height: 1.6;">
                            {{ $imported }} source{{ $imported === 1 ? '' : 's' }} imported<br>
                            @if($failed > 0)
                                {{ $failed }} could not be fetched or converted<br>
                            @endif
                            @if(($counts['capped'] ?? 0) > 0)
                                {{ $counts['capped'] }} over this run's limit — run the harvest again to continue
                            @endif
                        </td>
                    </tr>

                    <!-- Buttons -->
                    <tr>
                        <td align="center" style="padding: 0 40px 12px;">
                            <table role="presentation" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="border-radius: 8px; background-color: #4EACAE;">
                                        <a href="{{ $bookUrl }}" target="_blank" style="display: inline-block; padding: 14px 36px; font-family: Inter, Arial, Helvetica, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">
                                            Open Book
                                        </a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    @if($shelfUrl)
                    <tr>
                        <td align="center" style="padding: 0 40px 28px;">
                            <a href="{{ $shelfUrl }}" target="_blank" style="font-family: Inter, Arial, Helvetica, sans-serif; font-size: 14px; color: #4EACAE; text-decoration: underline;">
                                View all the harvested sources on your shelf
                            </a>
                        </td>
                    </tr>
                    @else
                    <tr><td style="padding: 0 0 28px;"></td></tr>
                    @endif

                    <!-- Footer note -->
                    <tr>
                        <td style="padding: 0 40px 40px; color: #888888; font-size: 13px; line-height: 1.5; text-align: center;">
                            You received this email because you asked to be notified when your source harvest on Hyperlit finished.
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
