<?php

namespace App\Exceptions;

/**
 * An import failure that CANNOT succeed on a retry.
 *
 * ProcessDocumentImportJob retries three times because the failures worth retrying are
 * transient (the Mistral eventual-consistency 404 that self-heals on a fresh attempt).
 * Some failures are deterministic — a document the OCR engine's parser refuses will be
 * refused identically every time — and retrying one only spends two more uploads and a
 * minute of the user's life to arrive at the same place, having buried the real reason
 * under an "Import hit a snag — retrying automatically..." that was never true.
 *
 * The job checks for this type and fails immediately, surfacing `getMessage()` to the
 * user, so the message must be written FOR the user: what happened, and what they can do.
 */
class PermanentImportException extends \RuntimeException
{
}
