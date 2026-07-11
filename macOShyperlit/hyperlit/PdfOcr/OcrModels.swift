//
//  OcrModels.swift
//  hyperlit
//
//  Output contract of the on-device PDF OCR: a JSON byte-compatible with the
//  Mistral OCR response the Hyperlit conversion pipeline replays from
//  (ocr_response.json — see the web repo's tests/conversion/fixtures/pdf/*/
//  synthetic/ocr_response.json for the reference shape). Only pages[].{index,
//  markdown, images, header} have downstream consumers; the rest is carried for
//  shape fidelity. usage_info is provenance for debugging (downstream ignores it).
//

import Foundation
import CoreGraphics

nonisolated struct OcrImage: Codable {
    let id: String            // literal filename downstream writes into media/ — hyphens only, must carry an extension
    let image_base64: String
}

nonisolated struct OcrDimensions: Codable {
    let dpi: Int
    let height: Int
    let width: Int
}

nonisolated struct OcrPage: Codable {
    let index: Int
    let markdown: String
    let images: [OcrImage]
    let dimensions: OcrDimensions
    let tables: [String]
    let hyperlinks: [String]
    let header: String
    let footer: String
}

nonisolated struct OcrUsageInfo: Codable {
    let pages_processed: Int
    let text_layer_pages: Int
    let vision_pages: Int
    let engine_version: String
    let warnings: [String]
}

nonisolated struct OcrResponse: Codable {
    let pages: [OcrPage]
    let model: String
    let usage_info: OcrUsageInfo
    let document_annotation: String?

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        // Deterministic output (test goldens diff cleanly); no pretty-print — the
        // pipeline treats this as a cache blob, and compactness matters at 100s of pages.
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

let kOcrModelName = "hyperlit-native-ocr"
let kOcrEngineVersion = "1.1.0"

// ── Internal geometry model shared by the text-layer and Vision paths ────────
//
// All rects are in PDF page space: origin bottom-left, y grows upward.

nonisolated struct TextRun {
    let text: String
    let fontSize: CGFloat
    let isBold: Bool
    let rect: CGRect
}

nonisolated struct TextLine {
    var runs: [TextRun]
    var rect: CGRect

    var text: String { runs.map(\.text).joined() }

    /// Character-weighted dominant font size of the line.
    var fontSize: CGFloat {
        var weights: [CGFloat: Int] = [:]
        for run in runs {
            weights[run.fontSize, default: 0] += run.text.count
        }
        return weights.max(by: { $0.value < $1.value })?.key ?? 0
    }

    var isBold: Bool {
        let boldChars = runs.filter(\.isBold).reduce(0) { $0 + $1.text.count }
        let total = runs.reduce(0) { $0 + $1.text.count }
        return total > 0 && boldChars * 2 > total
    }
}

nonisolated struct AnalyzedPage {
    let index: Int
    var lines: [TextLine]
    let pageBounds: CGRect
    let usedVision: Bool
    /// Populated by DocumentStats: band lines promoted to the header/footer fields.
    var headerText: String = ""
    var footerText: String = ""
}

nonisolated enum OcrProgressStage: String {
    case text
    case vision
    case images
    case compose
    case mistral   // BYO-key remote OCR in flight (keepalive pulses, no page counts)
    case vlm       // vision-language-model transcription (real per-page counts)
}

nonisolated struct OcrProgress {
    let page: Int        // 1-based, for display
    let totalPages: Int
    let stage: OcrProgressStage
}
