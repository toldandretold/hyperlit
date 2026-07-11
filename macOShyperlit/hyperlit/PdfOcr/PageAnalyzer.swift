//
//  PageAnalyzer.swift
//  hyperlit
//
//  Text-layer extraction for one PDF page: PDFKit's attributedString gives font
//  runs (size + boldness), PDFSelection gives their page-space geometry. The
//  output is a list of TextLine (runs grouped by visual line, top-to-bottom),
//  which MarkdownComposer turns into markdown. Pages whose text layer is absent
//  or garbage (scans, mojibake fonts) are flagged for the Vision fallback.
//

import Foundation
import PDFKit

nonisolated enum PageAnalyzer {

    // ── Text-layer quality gate ───────────────────────────────────────────────

    /// True when the page's embedded text layer is unusable and Vision OCR
    /// should run instead: (near-)empty, mostly unprintable, or mojibake-heavy
    /// (fonts with no ToUnicode CMap decode to U+FFFD / private-use codepoints).
    ///
    /// Also catches the PARTIAL-mojibake page: previously-OCR'd scans where one
    /// font (typically italic) has broken glyph mapping, so a mostly-clean page
    /// contains fragments like "world ~ r d e r . ~" or "consumeri~m.~~" — the
    /// unmapped glyphs surface as '~' and letters come through singly spaced.
    /// A high printable ratio can't see that, so it gets its own signals; a
    /// false positive just re-OCRs a good page (slower, still correct), while a
    /// false negative ships garbage prose, so the thresholds lean sensitive.
    static func needsVision(_ page: PDFPage) -> Bool {
        // A physical scan (full-page image) always gets Vision: its text layer,
        // if any, is a previous OCR pass of unknown quality.
        if ImageExtractor.hasFullPageImage(page) { return true }

        let text = page.string ?? ""
        if text.count < 50 { return true }

        // Tildes touching letters are never prose; standalone tildes and
        // spaced-single-letter runs each need corroboration.
        let adjacentTildes = matchCount(#"[A-Za-z]~|~[A-Za-z]"#, in: text)
        let tildes = text.filter { $0 == "~" }.count
        let spacedLetterRuns = matchCount(#"(?: [a-z]){3,} "#, in: text)
        if adjacentTildes * 2 + tildes + spacedLetterRuns * 2 >= 3 { return true }

        var good = 0, bad = 0, total = 0
        for scalar in text.unicodeScalars {
            total += 1
            switch scalar.value {
            case 0x20...0x7E, 0x09, 0x0A, 0x0D,          // ASCII printable + whitespace
                 0xA0...0x52F,                            // Latin supplements, Greek, Cyrillic
                 0x2000...0x206F,                         // general punctuation
                 0x2070...0x218F,                         // super/subscripts, letterlike, number forms
                 0x2200...0x22FF,                         // math operators
                 0x3000...0x9FFF:                         // CJK
                good += 1
            case 0xFFFD, 0xE000...0xF8FF:                 // replacement char, private use area
                bad += 1
            default:
                break
            }
        }
        if total == 0 { return true }
        if Double(good) / Double(total) < 0.75 { return true }
        if Double(bad) / Double(total) > 0.05 { return true }
        return false
    }

    private static func matchCount(_ pattern: String, in text: String) -> Int {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return 0 }
        return regex.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
    }

    // ── Run + line extraction ─────────────────────────────────────────────────

    /// Extract the page's text as visual lines of font runs. Returns lines
    /// sorted top-to-bottom (descending page-space y), runs left-to-right.
    static func analyze(page: PDFPage, index: Int) -> AnalyzedPage {
        let bounds = page.bounds(for: .mediaBox)
        guard let attr = page.attributedString, attr.length > 0,
              let fullSelection = page.selection(for: NSRange(location: 0, length: attr.length)) else {
            return AnalyzedPage(index: index, lines: [], pageBounds: bounds, usedVision: false)
        }

        // Font runs over the whole page string: (range, size, bold).
        var fontRuns: [(range: NSRange, size: CGFloat, bold: Bool)] = []
        attr.enumerateAttribute(.font, in: NSRange(location: 0, length: attr.length)) { value, range, _ in
            let font = value as? NSFont
            let size = font?.pointSize ?? 0
            let bold = font.map { f in
                f.fontDescriptor.symbolicTraits.contains(.bold)
                    || f.fontName.range(of: "bold|semibold|black|heavy", options: [.regularExpression, .caseInsensitive]) != nil
            } ?? false
            fontRuns.append((range, size, bold))
        }

        let pageText = attr.string as NSString
        var lines: [TextLine] = []

        // selectionsByLine() splits into visual lines; intersect each line's
        // range with the font runs to get per-line, per-font sub-runs, and use a
        // per-sub-run selection for glyph-accurate geometry (the superscript
        // baseline signal needs the run's own rect, not the whole line's).
        for lineSelection in fullSelection.selectionsByLine() {
            let lineRect = lineSelection.bounds(for: page)
            guard lineRect.height > 0.1, lineRect.width > 0.1 else { continue }

            var lineRanges: [NSRange] = []
            for i in 0..<lineSelection.numberOfTextRanges(on: page) {
                lineRanges.append(lineSelection.range(at: i, on: page))
            }

            var runs: [TextRun] = []
            for lineRange in lineRanges where lineRange.length > 0 {
                for fontRun in fontRuns {
                    let inter = NSIntersectionRange(lineRange, fontRun.range)
                    guard inter.length > 0 else { continue }
                    let text = pageText.substring(with: inter)
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text == " " else { continue }
                    let rect = page.selection(for: inter)?.bounds(for: page) ?? lineRect
                    runs.append(TextRun(text: text, fontSize: fontRun.size, isBold: fontRun.bold, rect: rect))
                }
            }
            guard !runs.isEmpty else { continue }
            runs.sort { $0.rect.minX < $1.rect.minX }

            let union = runs.dropFirst().reduce(runs[0].rect) { $0.union($1.rect) }
            let text = runs.map(\.text).joined().trimmingCharacters(in: .newlines)
            guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            lines.append(TextLine(runs: runs, rect: union))
        }

        lines.sort { $0.rect.midY > $1.rect.midY }
        lines = mergeOverlappingLines(lines)
        return AnalyzedPage(index: index, lines: lines, pageBounds: bounds, usedVision: false)
    }

    /// selectionsByLine() gives superscripts (raised baseline) their own "line"
    /// even though they sit on the same visual line as their word — merge any
    /// consecutive lines that overlap vertically (≥ half the smaller height)
    /// AND are horizontally adjacent, so markers stay attached to their text.
    /// The horizontal-gap requirement keeps side-by-side COLUMN lines (which
    /// also overlap vertically, across a wide gutter) separate.
    private static func mergeOverlappingLines(_ lines: [TextLine]) -> [TextLine] {
        var merged: [TextLine] = []
        for line in lines {
            if var last = merged.last {
                let overlap = min(last.rect.maxY, line.rect.maxY) - max(last.rect.minY, line.rect.minY)
                let smaller = min(last.rect.height, line.rect.height)
                let hGap = max(last.rect.minX, line.rect.minX) - min(last.rect.maxX, line.rect.maxX)
                let maxAdjacency = max(last.rect.height, line.rect.height) * 1.5
                if smaller > 0, overlap >= smaller * 0.5, hGap <= maxAdjacency {
                    last.runs.append(contentsOf: line.runs)
                    last.runs.sort { $0.rect.minX < $1.rect.minX }
                    last.rect = last.rect.union(line.rect)
                    merged[merged.count - 1] = last
                    continue
                }
            }
            merged.append(line)
        }
        return merged
    }
}
