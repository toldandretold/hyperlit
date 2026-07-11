#!/bin/bash
#
# Build hyperlit-ocr, the command-line front end for the on-device PDF OCR
# engine (the same PdfOcr/ sources the macOS app embeds — no Xcode target
# needed, plain swiftc). Output: macOShyperlit/bin/hyperlit-ocr.
#
# The Mac-hosted Laravel backend points NATIVE_OCR_BINARY at the built binary
# (see config/services.php `native_ocr`) to convert PDFs without Mistral.
#
# Requires full Xcode (PDFKit/Vision need the macOS SDK, not just the CLT):
#   ./build-cli.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# Prefer Xcode's toolchain when xcode-select still points at the CLT.
if ! xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1 && [ -d /Applications/Xcode.app ]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

mkdir -p bin
swiftc -O \
    -swift-version 5 \
    -o bin/hyperlit-ocr \
    cli/main.swift \
    hyperlit/PdfOcr/OcrModels.swift \
    hyperlit/PdfOcr/PageAnalyzer.swift \
    hyperlit/PdfOcr/DocumentStats.swift \
    hyperlit/PdfOcr/MarkdownComposer.swift \
    hyperlit/PdfOcr/VisionPageOcr.swift \
    hyperlit/PdfOcr/ImageExtractor.swift \
    hyperlit/PdfOcr/PdfOcrEngine.swift \
    hyperlit/PdfOcr/VlmOcrClient.swift

echo "built: $(pwd)/bin/hyperlit-ocr"
