<?php

namespace App\Logging;

use Monolog\Formatter\LineFormatter;
use Monolog\LogRecord;
use Illuminate\Log\Logger;

class CustomLineFormatter extends LineFormatter
{
    public function format(LogRecord $record): string
    {
        $output = parent::format($record);
        
        // Add blank line before timestamp patterns
        $output = preg_replace('/^(\[[\d\-T:\.+]+\])/', "\n$1", $output);
        
        // Add blank line before [stacktrace] if it exists
        $output = preg_replace('/^(\[stacktrace\])/', "\n$1", $output);
        
        return $output;
    }
}

class CustomizeFormatter
{
    public function __invoke(Logger $logger): void
    {
        foreach ($logger->getHandlers() as $handler) {
            $handler->setFormatter(new CustomLineFormatter());
        }
    }
}