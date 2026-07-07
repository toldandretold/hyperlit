<?php

namespace App\Services\Llm;

/**
 * A pluggable destination for LLM calls made through LlmService. When one is set
 * (LlmService::setTransport), the service parks the request instead of calling
 * the shared provider — used for "bring your own key" inference, where the
 * client executes the prompt with the user's own key.
 *
 * Implementations receive the already-assembled OpenAI-style chat body
 * (model, temperature, max_tokens, messages, reasoning_effort?).
 */
interface InferenceTransport
{
    /**
     * Execute one chat request. Returns the completion content string, or null
     * on a normal failure (matching LlmService::chat's null contract).
     *
     * @param array<string,mixed> $body
     */
    public function execute(array $body, int $timeout): ?string;

    /**
     * Execute a batch, preserving the input keys. Implementations should create
     * all work items up front (so the client can run them concurrently) before
     * waiting on any.
     *
     * @param array<int|string,array<string,mixed>> $bodies
     * @return array<int|string,?string>
     */
    public function executeBatch(array $bodies, int $timeout): array;
}
