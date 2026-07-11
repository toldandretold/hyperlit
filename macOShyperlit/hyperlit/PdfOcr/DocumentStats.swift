//
//  DocumentStats.swift
//  hyperlit
//
//  Cross-page pass over the analyzed pages: establishes the document's body
//  font size and modal line spacing (the composer's thresholds are relative to
//  these), and detects running headers/footers — top/bottom-band lines whose
//  normalized text repeats across pages, plus bare page numbers. Matched band
//  lines are moved into page.headerText / page.footerText (the JSON's header/
//  footer fields, which the pipeline uses for section + "Notes"-page detection)
//  and removed from the body so they never pollute the markdown.
//

import Foundation
import CoreGraphics

nonisolated struct DocumentStats {
    let bodyFontSize: CGFloat
    let modalLineSpacing: CGFloat

    // ── Body font + spacing ───────────────────────────────────────────────────

    static func compute(pages: [AnalyzedPage]) -> DocumentStats {
        // Character-weighted median font size across every line of every page.
        // The body face dominates any book by volume, so the median is robust
        // against headings, notes, and captions.
        var sizeWeights: [CGFloat: Int] = [:]
        for page in pages {
            for line in page.lines {
                let size = (line.fontSize * 2).rounded() / 2   // 0.5pt buckets
                sizeWeights[size, default: 0] += line.text.count
            }
        }
        let totalChars = sizeWeights.values.reduce(0, +)
        var bodySize: CGFloat = 12
        var acc = 0
        for (size, weight) in sizeWeights.sorted(by: { $0.key < $1.key }) {
            acc += weight
            if acc * 2 >= totalChars { bodySize = size; break }
        }

        // Modal spacing between consecutive lines, measured as the midY delta
        // (steadier across mixed ascender/descender heights than edge gaps),
        // in 0.5pt buckets. Deltas under half the body size are NOT line
        // advances — they're fragments of one visual line (Vision often splits
        // a line into several observations at near-identical midY) and would
        // otherwise win the mode and wreck every paragraph-gap threshold.
        var gapWeights: [CGFloat: Int] = [:]
        for page in pages {
            for (prev, next) in zip(page.lines, page.lines.dropFirst()) {
                let delta = ((prev.rect.midY - next.rect.midY) * 2).rounded() / 2
                guard delta > bodySize * 0.5, delta < bodySize * 3 else { continue }
                gapWeights[delta, default: 0] += 1
            }
        }
        var modal = gapWeights.max(by: { $0.value < $1.value })?.key ?? bodySize * 1.2
        // A plausible line pitch is 1-3× the body size — clamp against residue.
        modal = min(max(modal, bodySize), bodySize * 3)

        return DocumentStats(bodyFontSize: max(bodySize, 1), modalLineSpacing: max(modal, 1))
    }

    // ── Running header / footer detection ─────────────────────────────────────

    /// Move repeated top/bottom-band lines (and bare page numbers) out of the
    /// body and into headerText/footerText. Mutates the pages in place.
    ///
    /// Candidates are the top/bottom one or two lines of each page within a
    /// generous positional band (books put running headers well below the paper
    /// edge — 85-90% of page height is common). Repetition across pages is the
    /// primary signal, so a chapter-opener heading in the same position — which
    /// appears once — always stays in the body.
    static func stripRunningBands(pages: inout [AnalyzedPage]) {
        guard pages.count >= 3 else {
            // Too few pages for repetition evidence; only strip bare page numbers.
            for i in pages.indices { extractBands(&pages[i], repeated: []) }
            return
        }

        // Collect normalized forms of band-candidate lines across pages.
        var counts: [String: Int] = [:]
        for page in pages {
            var seenOnPage = Set<String>()
            for (line, _) in bandCandidates(page) {
                let norm = normalize(line.text)
                guard !norm.isEmpty, !seenOnPage.contains(norm) else { continue }
                seenOnPage.insert(norm)
                counts[norm, default: 0] += 1
            }
        }
        // Digit-bearing forms ("14• Title", "Chapter 3 17") are folio+title
        // running headers — those repeat only within one chapter, so they get a
        // low absolute threshold. Digit-free forms (book title alone) need the
        // 30%-of-pages bar, since a repeated body phrase can't reach that.
        let pageShare = max(3, Int((Double(pages.count) * 0.3).rounded()))
        let repeated = Set(counts.filter { form, count in
            count >= (form.contains("#") ? 3 : pageShare)
        }.keys)

        for i in pages.indices { extractBands(&pages[i], repeated: repeated) }
    }

    private enum Band { case header, footer }

    /// The band-candidate lines of a page: the top two lines when they sit in
    /// the top 18% of the page, and the bottom two in the bottom 12%. `lines`
    /// is already sorted top-to-bottom.
    private static func bandCandidates(_ page: AnalyzedPage) -> [(TextLine, Band)] {
        let h = page.pageBounds.height
        guard h > 0, !page.lines.isEmpty else { return [] }
        let top = page.pageBounds.minY + h * 0.82
        let bottom = page.pageBounds.minY + h * 0.12

        var out: [(TextLine, Band)] = []
        for line in page.lines.prefix(2) where line.rect.maxY >= top {
            out.append((line, .header))
        }
        for line in page.lines.suffix(2) where line.rect.minY <= bottom {
            out.append((line, .footer))
        }
        return out
    }

    /// Digit RUNS → one '#', whitespace collapsed, lowercased — so "22• Title",
    /// "106• Title" and "Chapter 3   17" / "Chapter 3 18" all normalize to the
    /// same form across pages regardless of digit count.
    private static func normalize(_ text: String) -> String {
        var out = ""
        var lastWasSpace = false
        var lastWasDigit = false
        for ch in text.lowercased() {
            if ch.isNumber {
                if !lastWasDigit { out.append("#") }
                lastWasDigit = true
                lastWasSpace = false
            } else if ch.isWhitespace {
                if !lastWasSpace { out.append(" ") }
                lastWasSpace = true
                lastWasDigit = false
            } else {
                out.append(ch)
                lastWasSpace = false
                lastWasDigit = false
            }
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    /// A line that is just a page number: arabic or roman numerals, with or
    /// without folio decoration ("- 2 -", "= 3 -", "[ 17 ]", "— iv —" — the
    /// "=" variant is a common OCR misread of a decorated dash).
    private static func isBarePageNumber(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespaces)
        let deco = #"[\s\-–—=_.\[\]()]*"#
        if t.range(of: "^\(deco)\\d{1,4}\(deco)$", options: .regularExpression) != nil { return true }
        if t.range(of: "^\(deco)[ivxlcdm]{1,8}\(deco)$", options: [.regularExpression, .caseInsensitive]) != nil,
           t.count <= 12 { return true }
        return false
    }

    private static func extractBands(_ page: inout AnalyzedPage, repeated: Set<String>) {
        var headerParts: [String] = []
        var footerParts: [String] = []
        var stripped = Set<Int>()

        for (line, band) in bandCandidates(page) {
            let isRunning = repeated.contains(normalize(line.text)) || isBarePageNumber(line.text)
            guard isRunning else { continue }   // chapter openers etc. stay in the body
            guard let idx = page.lines.firstIndex(where: { $0.rect == line.rect && $0.text == line.text }),
                  !stripped.contains(idx) else { continue }
            stripped.insert(idx)
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            switch band {
            case .header: headerParts.append(text)
            case .footer: footerParts.append(text)
            }
        }

        page.lines = page.lines.enumerated().filter { !stripped.contains($0.offset) }.map(\.element)
        page.headerText = headerParts.joined(separator: "\n")
        page.footerText = footerParts.joined(separator: "\n")
    }
}
