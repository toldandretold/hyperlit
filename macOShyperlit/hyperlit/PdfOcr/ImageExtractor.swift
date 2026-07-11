//
//  ImageExtractor.swift
//  hyperlit
//
//  Embedded-figure extraction for text-layer pages. A minimal CGPDF content-
//  stream scan (q/Q/cm/Do with a CTM stack) finds where image XObjects are
//  PLACED on the page — the current transform maps the unit square to the
//  placement rect. We then render the page once and crop each rect to JPEG,
//  which sidesteps decoding arbitrary raw image colorspaces/filters.
//
//  Ids are literal downstream filenames (media/<id>) — hyphens only, extension
//  required: img-p{page}-{k}.jpeg. Markdown references them as ![id](id).
//

import Foundation
import PDFKit
import ImageIO
import UniformTypeIdentifiers

nonisolated enum ImageExtractor {

    static let cropDPI: CGFloat = 200
    /// Placement filters: skip specks (< 2% page area or < 24pt a side) and
    /// full-page backgrounds (≥ 90% of the page).
    static let minAreaFraction: CGFloat = 0.02
    static let minSidePoints: CGFloat = 24
    static let maxAreaFraction: CGFloat = 0.9

    struct PlacedImage {
        let id: String
        let base64: String
        let rect: CGRect   // page space
    }

    /// True when the page is physically a scan: an image XObject placement
    /// covers (nearly) the whole page. Such pages get Vision OCR regardless of
    /// text-layer quality — any text layer on a scan is a previous OCR pass of
    /// unknown quality, and re-reading the pixels is strictly more trustworthy.
    static func hasFullPageImage(_ page: PDFPage) -> Bool {
        guard let cgPage = page.pageRef else { return false }
        let bounds = page.bounds(for: .mediaBox)
        let pageArea = bounds.width * bounds.height
        guard pageArea > 0 else { return false }
        return scanPlacements(cgPage).contains { rect in
            let r = rect.standardized.intersection(bounds)
            return (r.width * r.height) / pageArea >= 0.85
        }
    }

    /// Find and crop the images placed on a page. `pageIndex` is 0-based.
    static func extract(page: PDFPage, pageIndex: Int) -> [PlacedImage] {
        guard let cgPage = page.pageRef else { return [] }
        let bounds = page.bounds(for: .mediaBox)
        let pageArea = bounds.width * bounds.height
        guard pageArea > 0 else { return [] }

        var rects: [CGRect] = []
        for raw in scanPlacements(cgPage) {
            let rect = raw.standardized.intersection(bounds)
            guard rect.width >= minSidePoints, rect.height >= minSidePoints else { continue }
            let frac = (rect.width * rect.height) / pageArea
            guard frac >= minAreaFraction, frac < maxAreaFraction else { continue }
            // Dedupe identical placements (same XObject drawn twice, tiling).
            if rects.contains(where: { $0.insetBy(dx: -2, dy: -2).contains(rect) && rect.insetBy(dx: -2, dy: -2).contains($0) }) {
                continue
            }
            rects.append(rect)
        }
        guard !rects.isEmpty else { return [] }

        // One render, N crops.
        guard let rendered = renderForCrop(page: page, bounds: bounds) else { return [] }
        let scale = CGFloat(rendered.width) / bounds.width

        var out: [PlacedImage] = []
        for (k, rect) in rects.enumerated() {
            // Page space (origin bottom-left) → raster space (origin top-left).
            let crop = CGRect(
                x: (rect.minX - bounds.minX) * scale,
                y: (bounds.maxY - rect.maxY) * scale,
                width: rect.width * scale,
                height: rect.height * scale
            ).integral
            guard let cgCrop = rendered.cropping(to: crop),
                  let jpeg = encodeJPEG(cgCrop) else { continue }
            let id = "img-p\(pageIndex)-\(k).jpeg"
            out.append(PlacedImage(id: id, base64: jpeg.base64EncodedString(), rect: rect))
        }
        return out
    }

    // ── Content-stream scan ───────────────────────────────────────────────────

    /// Tracks the graphics state the scanner callbacks need: the CTM stack and
    /// the found image placement rects.
    private final class ScanState {
        var ctm = CGAffineTransform.identity
        var stack: [CGAffineTransform] = []
        var placements: [CGRect] = []
        var contentStream: CGPDFContentStreamRef?
    }

    private static func scanPlacements(_ cgPage: CGPDFPage) -> [CGRect] {
        let state = ScanState()
        let contentStream = CGPDFContentStreamCreateWithPage(cgPage)
        state.contentStream = contentStream

        let table = CGPDFOperatorTableCreate()!

        CGPDFOperatorTableSetCallback(table, "q") { scanner, info in
            let state = Unmanaged<ScanState>.fromOpaque(info!).takeUnretainedValue()
            state.stack.append(state.ctm)
        }
        CGPDFOperatorTableSetCallback(table, "Q") { scanner, info in
            let state = Unmanaged<ScanState>.fromOpaque(info!).takeUnretainedValue()
            if let restored = state.stack.popLast() { state.ctm = restored }
        }
        CGPDFOperatorTableSetCallback(table, "cm") { scanner, info in
            let state = Unmanaged<ScanState>.fromOpaque(info!).takeUnretainedValue()
            // Operands are pushed a b c d e f — pop in reverse.
            var v = [CGPDFReal](repeating: 0, count: 6)
            for i in stride(from: 5, through: 0, by: -1) {
                var value: CGPDFReal = 0
                guard CGPDFScannerPopNumber(scanner, &value) else { return }
                v[i] = value
            }
            let m = CGAffineTransform(a: v[0], b: v[1], c: v[2], d: v[3], tx: v[4], ty: v[5])
            state.ctm = m.concatenating(state.ctm)
        }
        CGPDFOperatorTableSetCallback(table, "Do") { scanner, info in
            let state = Unmanaged<ScanState>.fromOpaque(info!).takeUnretainedValue()
            var namePtr: UnsafePointer<CChar>? = nil
            guard CGPDFScannerPopName(scanner, &namePtr), let name = namePtr,
                  let cs = state.contentStream,
                  let object = CGPDFContentStreamGetResource(cs, "XObject", name) else { return }
            var stream: CGPDFStreamRef? = nil
            guard CGPDFObjectGetValue(object, .stream, &stream), let s = stream,
                  let dict = CGPDFStreamGetDictionary(s) else { return }
            var subtypePtr: UnsafePointer<CChar>? = nil
            guard CGPDFDictionaryGetName(dict, "Subtype", &subtypePtr), let subtype = subtypePtr,
                  String(cString: subtype) == "Image" else { return }
            // The image operator paints the unit square through the CTM.
            let rect = CGRect(x: 0, y: 0, width: 1, height: 1).applying(state.ctm)
            state.placements.append(rect)
        }

        let info = Unmanaged.passUnretained(state).toOpaque()
        let scanner = CGPDFScannerCreate(contentStream, table, info)
        CGPDFScannerScan(scanner)

        CGPDFScannerRelease(scanner)
        CGPDFOperatorTableRelease(table)
        CGPDFContentStreamRelease(contentStream)
        return state.placements
    }

    // ── Render + encode ───────────────────────────────────────────────────────

    private static func renderForCrop(page: PDFPage, bounds: CGRect) -> CGImage? {
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        var scale = cropDPI / 72.0
        let longest = max(bounds.width, bounds.height) * scale
        if longest > 4000 { scale *= 4000 / longest }
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
        // No origin translate — see VisionPageOcr.render.
        page.draw(with: .mediaBox, to: ctx)
        return ctx.makeImage()
    }

    static func encodeJPEG(_ image: CGImage, quality: CGFloat = 0.8) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }
}
