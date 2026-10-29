<?php

/*
 * Polyfill for Illuminate\Contracts\JsonSchema\JsonSchema on Laravel 11.
 *
 * laravel/mcp 0.4.x (the last line that supports Laravel 11) depends on
 * illuminate/json-schema v12, whose JsonSchemaTypeFactory implements this
 * contract — but the interface was only backported to illuminate/contracts
 * 11.47+, and this project is pinned below that by its composer
 * security-advisory policy (every published 11.x release is flagged, so the
 * framework cannot be bumped without relaxing the policy).
 *
 * This file is a verbatim copy of the real 11.x interface
 * (https://github.com/illuminate/contracts/blob/11.x/JsonSchema/JsonSchema.php)
 * loaded via composer autoload "files", guarded so the real one wins the
 * moment the framework ships it — DELETE this file (and its composer.json
 * autoload entry) when the app moves to Laravel 12.
 */

namespace Illuminate\Contracts\JsonSchema;

use Closure;

if (! interface_exists(JsonSchema::class)) {
    interface JsonSchema
    {
        /**
         * Create a new object schema instance.
         *
         * @param  (Closure(JsonSchema): array<string, \Illuminate\JsonSchema\Types\Type>)|array<string, \Illuminate\JsonSchema\Types\Type>  $properties
         * @return \Illuminate\JsonSchema\Types\ObjectType
         */
        public function object(Closure|array $properties = []);

        /**
         * Create a new array property instance.
         *
         * @return \Illuminate\JsonSchema\Types\ArrayType
         */
        public function array();

        /**
         * Create a new string property instance.
         *
         * @return \Illuminate\JsonSchema\Types\StringType
         */
        public function string();

        /**
         * Create a new integer property instance.
         *
         * @return \Illuminate\JsonSchema\Types\IntegerType
         */
        public function integer();

        /**
         * Create a new number property instance.
         *
         * @return \Illuminate\JsonSchema\Types\NumberType
         */
        public function number();

        /**
         * Create a new boolean property instance.
         *
         * @return \Illuminate\JsonSchema\Types\BooleanType
         */
        public function boolean();
    }
}
