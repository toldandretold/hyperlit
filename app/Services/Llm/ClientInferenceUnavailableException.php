<?php

namespace App\Services\Llm;

use RuntimeException;

/**
 * Thrown by ClientTicketTransport when a parked inference ticket expires or the
 * wait times out — i.e. the client (native app) never came back to execute it.
 *
 * Long-running jobs (the citation pipeline) catch this to PAUSE rather than fail:
 * the client can reconnect later and the existing resume path replays completed
 * tickets instantly via the dedupe key.
 */
class ClientInferenceUnavailableException extends RuntimeException
{
}
