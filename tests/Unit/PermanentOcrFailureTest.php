<?php

/**
 * Guardrail: an OCR failure that can never succeed on a retry is classified as permanent.
 *
 * Book a22004 spent three job attempts and three 16MB uploads on the same deterministic
 * Mistral 400 (`document_parser_invalid_file`), showing the user "Import hit a snag —
 * retrying automatically..." twice before failing with a raw Python traceback. Retrying a
 * parser verdict is pointless: the same bytes get the same answer every time.
 *
 * Matching is on the error `type` rather than its prose ("Document is not a valid PDF."),
 * which is not even true for the case we diagnosed — that PDF parsed perfectly on our side.
 */

use App\Exceptions\PermanentImportException;
use App\Services\DocumentImport\Processors\PdfProcessor;

function invokeClassifier(string $stderr): ?string
{
    $processor = (new ReflectionClass(PdfProcessor::class))->newInstanceWithoutConstructor();
    $method = new ReflectionMethod(PdfProcessor::class, 'permanentOcrFailureMessage');
    $method->setAccessible(true);

    return $method->invoke($processor, $stderr);
}

it('classifies an unparseable-document 400 as permanent', function () {
    $stderr = <<<'ERR'
    Traceback (most recent call last):
      File "/var/www/hyperlit/app/Python/ingestion/pdf/ocrFetch.py", line 138, in fetch_ocr
    mistralai.client.errors.sdkerror.SDKError: API error occurred: Status 400. Body:
    {"object":"error","message":"Document is not a valid PDF.","type":"document_parser_invalid_file","param":null,"code":"3740","raw_status_code":400}
    ERR;

    $message = invokeClassifier($stderr);

    expect($message)->not->toBeNull()
        ->and($message)->toContain('could not read this PDF')
        // The message is shown to the user verbatim, so it has to say what to DO.
        ->and($message)->toContain('Re-saving');
});

it('leaves a transient failure to the retry budget', function () {
    // The eventual-consistency 404 is exactly the failure $tries = 3 exists for.
    $stderr = 'SDKError: API error occurred: Status 404. Body: {"message":"No file matches the given query."}';

    expect(invokeClassifier($stderr))->toBeNull();
});

it('does not classify an unrelated crash as permanent', function () {
    expect(invokeClassifier("MemoryError\nKilled"))->toBeNull();
});

it('marks the permanent exception as a runtime exception the job can catch', function () {
    $e = new PermanentImportException('nope');

    expect($e)->toBeInstanceOf(\RuntimeException::class)
        ->and($e->getMessage())->toBe('nope');
});
