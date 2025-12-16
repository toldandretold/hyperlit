<?php

namespace App\Http\Requests;

use App\Rules\BookId;
use App\Rules\SafeString;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Http\Exceptions\HttpResponseException;

class HyperciteRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Authorization handled by middleware and controller
        return true;
    }

    public function rules(): array
    {
        return [
            'data' => ['required', 'array'],
            'data.book' => ['required', new BookId()],
            'data.hyperciteId' => ['required', 'string', 'max:100'],
            'data.hypercitedText' => ['required', 'string', new SafeString(50000)],
            'data.citedIN' => ['sometimes', 'nullable', new BookId()],
            'data.timestamp' => ['sometimes', 'integer', 'min:0'],
            'data.startLine' => ['sometimes', 'integer', 'min:0'],
            'data.node_id' => ['sometimes', 'nullable', 'string', 'max:100'],
        ];
    }

    public function getBookId(): string
    {
        return $this->validated()['data']['book'];
    }

    public function getHyperciteData(): array
    {
        return $this->validated()['data'];
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
