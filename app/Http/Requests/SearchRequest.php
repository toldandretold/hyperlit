<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Http\Exceptions\HttpResponseException;

class SearchRequest extends FormRequest
{
    private const MAX_RESULTS = 50;

    public function authorize(): bool
    {
        return true; // Public endpoint
    }

    public function rules(): array
    {
        return [
            'q' => ['sometimes', 'string', 'max:500'],
            'limit' => ['sometimes', 'integer', 'min:1', 'max:' . self::MAX_RESULTS],
        ];
    }

    /**
     * Get the validated query string, defaulting to empty string.
     */
    public function getQuery(): string
    {
        return $this->validated()['q'] ?? '';
    }

    /**
     * Get the validated limit, defaulting to 20.
     */
    public function getLimit(): int
    {
        $limit = $this->validated()['limit'] ?? 20;
        return min($limit, self::MAX_RESULTS);
    }

    protected function failedValidation(Validator $validator): void
    {
        throw new HttpResponseException(response()->json([
            'success' => false,
            'message' => 'Validation failed',
            'errors' => $validator->errors()
        ], 422));
    }
}
