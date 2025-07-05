<?php

namespace App\Logging;

use Illuminate\Log\Logger;

class CustomizeFormatter
{
    public function __invoke(Logger $logger): void
    {
        foreach ($logger->getHandlers() as $handler) {
            $handler->setFormatter(new CustomLineFormatter());
        }
    }
}