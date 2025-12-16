<?php

namespace App\Http\Requests;

use App\Rules\BookId;
use App\Rules\SafeString;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Http\Exceptions\HttpResponseException;

class HyperlightRequest extends FormRequest
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
            'data.hyperlight_id' => ['required', 'string', 'max:100'],
            'data.node_id' => ['required', 'string', 'max:100'],
            'data.highlightedText' => ['required', 'string', new SafeString(50000)],
            'data.timestamp' => ['sometimes', 'integer', 'min:0'],
            'data.startLine' => ['sometimes', 'integer', 'min:0'],
            'data.note' => ['sometimes', 'nullable', 'string', new SafeString(10000)],
            'data.colour' => ['sometimes', 'nullable', 'string', 'max:50'],
        ];
    }

    public function getBookId(): string
    {
        return $this->validated()['data']['book'];
    }

    public function getHyperlightData(): array
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
