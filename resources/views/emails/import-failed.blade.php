<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Import Failed</title>
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
                                Import Failed
                            </h1>
                        </td>
                    </tr>

                    <!-- Body text -->
                    <tr>
                        <td style="padding: 0 40px 20px; color: #CBCCCC; font-size: 15px; line-height: 1.6;">
                            Your document <strong style="color: #ffffff;">{{ $title }}</strong> could not be imported.
                        </td>
                    </tr>

                    <!-- Error details -->
                    <tr>
                        <td style="padding: 0 40px 28px;">
                            <div style="background-color: #3A2A2A; border-radius: 8px; padding: 16px; color: #CC8888; font-size: 13px; line-height: 1.5; word-break: break-word;">
                                {{ Str::limit($errorMessage, 300) }}
                            </div>
                        </td>
                    </tr>

                    <!-- Suggestion -->
                    <tr>
                        <td style="padding: 0 40px 40px; color: #888888; font-size: 13px; line-height: 1.5;">
                            You can try importing the document again. If the problem persists, the document format may need adjustment.
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
