//
//  PdfOcrEngine.swift
//  hyperlit
//
//  Orchestrates the on-device PDF OCR: per page, extract the text layer
//  (PageAnalyzer) or fall back to Vision for scans, then a cross-page stats
//  pass (body font, spacing, running headers/footers), then compose each
//  page's markdown and extract embedded figures. Output is the Mistral-shaped
//  JSON the Hyperlit conversion pipeline replays from (see OcrModels.swift).
//
//  Run off the main actor — a big book renders hundreds of bitmaps.
//

import Foundation
import PDFKit

nonisolated enum PdfOcrError: LocalizedError {
    case cannotOpen
    case emptyDocument
    case cancelled

    var errorDescription: String? {
        switch self {
        case .cannotOpen: return "The file could not be opened as a PDF."
        case .emptyDocument: return "The PDF contains no pages."
        case .cancelled: return "OCR was cancelled."
        }
    }
}

nonisolated struct PdfOcrEngine {
    var extractImages = true
    var isCancelled: () -> Bool = { false }

    func run(url: URL, progress: @escaping (OcrProgress) -> Void) throws -> Data {
        guard let document = PDFDocument(url: url) else { throw PdfOcrError.cannotOpen }
        let pageCount = document.pageCount
        guard pageCount > 0 else { throw PdfOcrError.emptyDocument }

        var warnings: [String] = []
        var visionPages = 0

        // Pass 1: per-page analysis (text layer, Vision for scans).
        var analyzed: [AnalyzedPage] = []
        analyzed.reserveCapacity(pageCount)
        for i in 0..<pageCount {
            if isCancelled() { throw PdfOcrError.cancelled }
            guard let page = document.page(at: i) else {
                analyzed.append(AnalyzedPage(index: i, lines: [], pageBounds: .zero, usedVision: false))
                continue
            }
            try autoreleasepool {
                if PageAnalyzer.needsVision(page) {
                    progress(OcrProgress(page: i + 1, totalPages: pageCount, stage: .vision))
                    visionPages += 1
                    analyzed.append(try VisionPageOcr.analyze(page: page, index: i))
                } else {
                    progress(OcrProgress(page: i + 1, totalPages: pageCount, stage: .text))
                    analyzed.append(PageAnalyzer.analyze(page: page, index: i))
                }
            }
        }

        // Pass 2: document stats + running header/footer stripping.
        let stats = DocumentStats.compute(pages: analyzed)
        DocumentStats.stripRunningBands(pages: &analyzed)

        // Pass 3: compose markdown + extract figures.
        var ocrPages: [OcrPage] = []
        ocrPages.reserveCapacity(pageCount)
        for page in analyzed {
            if isCancelled() { throw PdfOcrError.cancelled }
            autoreleasepool {
                progress(OcrProgress(page: page.index + 1, totalPages: pageCount, stage: .compose))
                var result = MarkdownComposer.compose(page: page, stats: stats)
                warnings.append(contentsOf: result.warnings)

                var images: [OcrImage] = []

                // A scanned FIGURE page (chart/diagram): the recognized text is
                // axis ticks and data labels, not prose. Ship the page render
                // as the figure and drop the label noise from the markdown.
                if extractImages, VisionPageOcr.looksLikeFigurePage(page),
                   let pdfPage = document.page(at: page.index),
                   let render = VisionPageOcr.render(page: pdfPage, bounds: page.pageBounds),
                   let jpeg = ImageExtractor.encodeJPEG(render, quality: 0.7) {
                    let id = "img-p\(page.index)-scan.jpeg"
                    images.append(OcrImage(id: id, image_base64: jpeg.base64EncodedString()))
                    let caption = VisionPageOcr.figureCaption(page)
                    result.markdown = caption.isEmpty
                        ? "![\(id)](\(id))"
                        : caption + "\n\n![\(id)](\(id))"
                }

                if extractImages, images.isEmpty, !page.usedVision, let pdfPage = document.page(at: page.index) {
                    progress(OcrProgress(page: page.index + 1, totalPages: pageCount, stage: .images))
                    let placed = ImageExtractor.extract(page: pdfPage, pageIndex: page.index)
                    for img in placed {
                        images.append(OcrImage(id: img.id, image_base64: img.base64))
                    }
                    // Reference each figure in reading order: append after the
                    // markdown (rect-ordered) — a standalone paragraph per image,
                    // matching the ![id](id) form save_images/updateMarkdownImagePaths expect.
                    if !placed.isEmpty {
                        let refs = placed
                            .sorted { $0.rect.midY > $1.rect.midY }
                            .map { "![\($0.id)](\($0.id))" }
                            .joined(separator: "\n\n")
                        result.markdown = result.markdown.isEmpty ? refs : result.markdown + "\n\n" + refs
                    }
                }

                let bounds = page.pageBounds
                ocrPages.append(OcrPage(
                    index: page.index,
                    markdown: result.markdown,
                    images: images,
                    dimensions: OcrDimensions(dpi: 72, height: Int(bounds.height), width: Int(bounds.width)),
                    tables: [],
                    hyperlinks: [],
                    header: page.headerText,
                    footer: page.footerText
                ))
            }
        }

        let response = OcrResponse(
            pages: ocrPages,
            model: kOcrModelName,
            usage_info: OcrUsageInfo(
                pages_processed: pageCount,
                text_layer_pages: pageCount - visionPages,
                vision_pages: visionPages,
                engine_version: kOcrEngineVersion,
                warnings: warnings
            ),
            document_annotation: nil
        )
        return try response.encoded()
    }
}
