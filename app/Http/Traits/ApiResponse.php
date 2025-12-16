<?php

namespace App\Http\Traits;

use Illuminate\Http\JsonResponse;

/**
 * Standardized API response methods for controllers.
 * Provides consistent JSON structure across all API endpoints.
 */
trait ApiResponse
{
    /**
     * Return a success response.
     */
    protected function success(mixed $data = null, string $message = 'Success', int $status = 200): JsonResponse
    {
        return response()->json([
            'success' => true,
            'message' => $message,
            'data' => $data,
        ], $status);
    }

    /**
     * Return a created response (201).
     */
    protected function created(mixed $data = null, string $message = 'Created successfully'): JsonResponse
    {
        return $this->success($data, $message, 201);
    }

    /**
     * Return an error response.
     */
    protected function error(string $message, int $status = 400, array $errors = []): JsonResponse
    {
        $response = [
            'success' => false,
            'message' => $message,
        ];

        if (!empty($errors)) {
            $response['errors'] = $errors;
        }

        return response()->json($response, $status);
    }

    /**
     * Return an unauthorized response (401).
     */
    protected function unauthorized(string $message = 'Unauthenticated'): JsonResponse
    {
        return $this->error($message, 401);
    }

    /**
     * Return a forbidden response (403).
     */
    protected function forbidden(string $message = 'Access denied'): JsonResponse
    {
        return $this->error($message, 403);
    }

    /**
     * Return a not found response (404).
     */
    protected function notFound(string $message = 'Resource not found'): JsonResponse
    {
        return $this->error($message, 404);
    }

    /**
     * Return a validation error response (422).
     */
    protected function validationError(array $errors, string $message = 'Validation failed'): JsonResponse
    {
        return $this->error($message, 422, $errors);
    }

    /**
     * Return a server error response (500).
     */
    protected function serverError(string $message = 'An unexpected error occurred'): JsonResponse
    {
        return $this->error($message, 500);
    }
}
