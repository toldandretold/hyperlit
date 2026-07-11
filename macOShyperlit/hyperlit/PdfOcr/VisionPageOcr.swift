//
//  VisionPageOcr.swift
//  hyperlit
//
//  Scanned-page fallback: render the page to a bitmap and run Apple Vision's
//  text recognizer, then convert the observations into the same TextLine model
//  the text-layer path produces so MarkdownComposer and the band heuristics are
//  shared. Vision gives line-level boxes only — the font-size proxy is the box
//  height, and there is no superscript signal, so footnote markers surface as
//  bare numbers (the pipeline's sequentially-validated resurrection recovers
//  those). Scanned pages never emit image entries (the whole page IS an image).
//

import Foundation
import PDFKit
import Vision

nonisolated enum VisionPageOcr {

    static let renderDPI: CGFloat = 300
    static let maxRenderPixels: CGFloat = 4000

    /// OCR one page. Runs synchronously (call off the main actor, inside the
    /// engine's per-page autoreleasepool).
    static func analyze(page: PDFPage, index: Int) throws -> AnalyzedPage {
        let bounds = page.bounds(for: .mediaBox)
        guard let image = render(page: page, bounds: bounds) else {
            return AnalyzedPage(index: index, lines: [], pageBounds: bounds, usedVision: true)
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])

        var lines: [TextLine] = []
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            // Confidence floor: chart graphics and photo noise come back as
            // low-confidence garbage (sometimes hallucinated in another
            // script entirely) — drop it rather than pass it off as prose.
            guard candidate.confidence >= 0.3 else { continue }
            // Chart legend squares / decorative glyphs come back as literal
            // '#' — at line start that would read as a markdown heading, so
            // strip it (real prose never begins with '#').
            let text = candidate.string.replacingOccurrences(
                of: #"^#+\s*"#, with: "", options: .regularExpression
            )
            guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }

            // Normalized box (origin bottom-left) → page space.
            let box = observation.boundingBox
            let rect = CGRect(
                x: bounds.minX + box.minX * bounds.width,
                y: bounds.minY + box.minY * bounds.height,
                width: box.width * bounds.width,
                height: box.height * bounds.height
            )
            // Cap-height is roughly 70% of the observation box; that proxy keeps
            // heading detection (size ratio vs body) meaningful on scans.
            let fontProxy = rect.height * 0.7
            let run = TextRun(text: text, fontSize: fontProxy, isBold: false, rect: rect)
            lines.append(TextLine(runs: [run], rect: rect))
        }

        lines.sort { $0.rect.midY > $1.rect.midY }
        return AnalyzedPage(index: index, lines: lines, pageBounds: bounds, usedVision: true)
    }

    /// A scanned FIGURE/TABLE page (chart, diagram, data table): text dominated
    /// by short numeric fragments — axis ticks, data cells, year labels. Its
    /// recognized "text" is not prose, so the engine ships the page render as
    /// an image (plus any caption lines) instead of fake paragraphs.
    static func looksLikeFigurePage(_ page: AnalyzedPage) -> Bool {
        guard page.usedVision, !page.lines.isEmpty else { return false }
        let texts = page.lines.map { $0.text.trimmingCharacters(in: .whitespaces) }
        let totalChars = texts.reduce(0) { $0 + $1.count }
        let numericish = texts.filter(isNumericFragment).count
        // Sparse page, half numeric — or any density at two-thirds numeric.
        if totalChars < 400, numericish * 2 >= texts.count { return true }
        return texts.count >= 20 && numericish * 3 >= texts.count * 2
    }

    /// The caption-ish lines of a figure page (e.g. "Chart 4. Bolivia: Average
    /// Grant Element of New Commitments, 1975-95") — kept as text above the
    /// page image so the figure stays searchable.
    static func figureCaption(_ page: AnalyzedPage) -> String {
        page.lines
            .map { $0.text.trimmingCharacters(in: .whitespaces) }
            .filter { line in
                guard !isNumericFragment(line), line.count > 15 else { return false }
                // Caption-worthy = actual words, not OCR noise ("183: 2051…"):
                // at least two runs of 3+ letters.
                let regex = try? NSRegularExpression(pattern: "[A-Za-z]{3,}")
                let words = regex?.numberOfMatches(in: line, range: NSRange(line.startIndex..., in: line)) ?? 0
                return words >= 2
            }
            .prefix(4)
            .joined(separator: "\n\n")
    }

    private static func isNumericFragment(_ text: String) -> Bool {
        text.range(of: #"^[\d\s.,%()\-–—/]+$"#, options: .regularExpression) != nil || text.count <= 3
    }

    /// Render the page at ~300dpi (longest side capped) on a white background.
    static func render(page: PDFPage, bounds: CGRect) -> CGImage? {
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        var scale = renderDPI / 72.0
        let longest = max(bounds.width, bounds.height) * scale
        if longest > maxRenderPixels { scale *= maxRenderPixels / longest }

        let width = Int((bounds.width * scale).rounded())
        let height = Int((bounds.height * scale).rounded())
        guard width > 0, height > 0,
              let ctx = CGContext(
                data: nil, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return nil }

        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        ctx.scaleBy(x: scale, y: scale)
        // No origin translate: PDFPage.draw(with:to:) maps the display box's
        // origin to the context origin itself — translating again double-shifts
        // pages whose mediaBox origin is nonzero (left/top edge cut off).
        page.draw(with: .mediaBox, to: ctx)
        return ctx.makeImage()
    }
}
