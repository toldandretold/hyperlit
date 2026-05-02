<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Import Complete</title>
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
                                Import Complete
                            </h1>
                        </td>
                    </tr>

                    <!-- Body text -->
                    <tr>
                        <td style="padding: 0 40px 28px; color: #CBCCCC; font-size: 15px; line-height: 1.6;">
                            Your document <strong style="color: #ffffff;">{{ $title }}</strong> has been imported and is ready to read.
                        </td>
                    </tr>

                    @if($conversionStats)
                    <tr>
                        <td style="padding: 0 40px 28px; color: #888888; font-size: 13px; line-height: 1.6;">
                            @if(isset($conversionStats['references_found']) && $conversionStats['references_found'] > 0)
                                {{ $conversionStats['references_found'] }} references found<br>
                            @endif
                            @if(isset($conversionStats['footnotes_matched']) && $conversionStats['footnotes_matched'] > 0)
                                {{ $conversionStats['footnotes_matched'] }} footnotes matched<br>
                            @endif
                            @if(isset($conversionStats['citations_linked']) && $conversionStats['citations_linked'] > 0)
                                {{ $conversionStats['citations_linked'] }} citations linked
                            @endif
                        </td>
                    </tr>
                    @endif

                    <!-- Button -->
                    <tr>
                        <td align="center" style="padding: 0 40px 28px;">
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

                    <!-- Footer note -->
                    <tr>
                        <td style="padding: 0 40px 40px; color: #888888; font-size: 13px; line-height: 1.5; text-align: center;">
                            You received this email because you imported a document on Hyperlit.
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
