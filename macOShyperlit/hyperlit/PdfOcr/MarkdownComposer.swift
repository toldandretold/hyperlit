//
//  MarkdownComposer.swift
//  hyperlit
//
//  Turns one analyzed page (band-stripped TextLines) into the page markdown the
//  Hyperlit pipeline expects. The pipeline is deliberately forgiving — it
//  resurrects footnote markers from bare numbers and line-start "N. text"
//  definitions with sequential validation — so the rules here only emit the
//  explicit [^N] form on HIGH-confidence superscripts (a wrong [^N] can flip the
//  pipeline's footnote-layout classification; a missed one degrades gracefully).
//
//  Heuristics (all thresholds relative to DocumentStats):
//    headings   — standalone short line, size ratio ≥1.7 → #, ≥1.4 → ##, ≥1.15 → ###
//    superscript— 1-3 digit run, ≤0.8× neighbour size, baseline raised ≥0.25× height
//    footnotes  — trailing block of ≤0.85× body-size lines led by a number
//    paragraphs — midY gap ≤1.45× modal joins; >1.6× or a first-line indent breaks
//    columns    — 2-column split when ≥70% of body lines form two narrow x-clusters
//

import Foundation
import CoreGraphics

nonisolated enum MarkdownComposer {

    struct PageResult {
        var markdown: String
        var warnings: [String]
    }

    static func compose(page: AnalyzedPage, stats: DocumentStats) -> PageResult {
        var warnings: [String] = []
        guard !page.lines.isEmpty else { return PageResult(markdown: "", warnings: warnings) }

        // 1. Split off the page-bottom footnote block before column analysis —
        //    notes are full-width even on two-column pages.
        let (bodyLines, footnoteLines) = splitFootnoteBlock(page.lines, stats: stats)

        // 2. Column handling: when the page is two-column overall, full-width
        //    (spanning) lines emit in place and each run of narrow lines gets
        //    its own left-then-right ordering; single-column pages stay in
        //    plain top-to-bottom order.
        let groups = orderedGroups(bodyLines, warnings: &warnings, pageIndex: page.index)

        // 3. Compose each group's paragraphs/headings in reading order.
        var blocks: [String] = []
        for group in groups {
            blocks.append(contentsOf: composeBlocks(group, stats: stats, usedVision: page.usedVision))
        }
        blocks = mergeWrappedHeadings(blocks)

        // TOC guard: a page bristling with headings is a contents/index page,
        // not eight chapters — demote them all back to plain text.
        let headingCount = blocks.filter { headingLevel($0) != nil }.count
        if headingCount > 8 {
            blocks = blocks.map { block in
                guard let level = headingLevel(block) else { return block }
                return String(block.dropFirst(level + 1))
            }
        }

        // 4. Footnote definitions at the end of the page (line-start [^N]: form
        //    when the numbers ascend plausibly, else N. text — pipeline handles both).
        if !footnoteLines.isEmpty {
            blocks.append(contentsOf: composeFootnoteDefs(footnoteLines, stats: stats))
        }

        return PageResult(markdown: blocks.joined(separator: "\n\n"), warnings: warnings)
    }

    // ── Line text with superscript markers ────────────────────────────────────

    /// Render a line's runs to text, converting high-confidence superscript
    /// digit runs to [^N]. A digit run counts as a superscript marker when it is
    /// clearly smaller than its left neighbour AND its box sits raised off the
    /// neighbour's baseline. Mid-confidence cases emit the bare digits — the
    /// pipeline's sequentially-validated resurrection picks those up.
    static func lineText(_ line: TextLine) -> String {
        var out = ""
        for (i, run) in line.runs.enumerated() {
            // Runs come from the page's attributedString, which embeds hard
            // line/paragraph breaks — inside ONE visual line they are noise.
            let runText = run.text
                .replacingOccurrences(of: "\n", with: " ")
                .replacingOccurrences(of: "\r", with: " ")
            let trimmed = runText.trimmingCharacters(in: .whitespaces)
            // Only a superscript FOLLOWING text is a footnote ref — a raised
            // digit leading a line is an affiliation/definition marker, and
            // emitting [^N] there would fake a footnote definition downstream.
            let neighbour = i > 0 ? line.runs[i - 1] : nil
            // Trailing boundary: after the marker the line must end or continue
            // with whitespace/punctuation — a letter right after (H2O) means a
            // subscript/inline fragment, not a footnote ref.
            let followingChar = i + 1 < line.runs.count
                ? line.runs[i + 1].text.replacingOccurrences(of: "\n", with: " ").first
                : nil
            let trailingBoundary = followingChar == nil
                || followingChar!.isWhitespace
                || ".,;:!?)\u{201D}\u{2019}".contains(followingChar!)
            if let n = neighbour, !out.trimmingCharacters(in: .whitespaces).isEmpty, trailingBoundary,
               isSuperscriptDigits(trimmed, run: run, neighbour: n) {
                // No space before a marker: "word.[^3]" not "word. [^3]".
                while out.hasSuffix(" ") { out.removeLast() }
                out += "[^\(trimmed)]"
            } else {
                out += runText
            }
        }
        out = out.replacingOccurrences(of: "\u{00AD}", with: "-")  // soft hyphen → real
        // Collapse doubled spaces left by break-stripping.
        while out.contains("  ") { out = out.replacingOccurrences(of: "  ", with: " ") }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isSuperscriptDigits(_ text: String, run: TextRun, neighbour: TextRun) -> Bool {
        guard text.count >= 1, text.count <= 3, text.allSatisfy(\.isNumber),
              let value = Int(text), value >= 1, value <= 500 else { return false }
        guard neighbour.fontSize > 0, run.fontSize > 0 else { return false }
        let sizeRatio = run.fontSize / neighbour.fontSize
        guard sizeRatio <= 0.8 else { return false }
        // Raised baseline: the digit box's bottom sits above the neighbour's
        // bottom by a meaningful fraction of the neighbour's height.
        let raised = run.rect.minY - neighbour.rect.minY
        if raised >= neighbour.rect.height * 0.25 { return true }
        // PDFSelection often reports LINE-height boxes for sub-ranges, erasing
        // the baseline signal. Fall back to context: a very small digit run
        // pressed directly against the end of a word/punctuation ("…ible.11 ")
        // is a marker; a same-line subscript (H2O) has a letter right after it
        // and fails the trailing-boundary test applied by the caller.
        guard sizeRatio <= 0.72 else { return false }
        let before = neighbour.text.replacingOccurrences(of: "\n", with: "").last
        guard let b = before, b.isLetter || ".,;:!?\")\u{201D}\u{2019}".contains(b) else { return false }
        return true
    }

    // ── Headings ──────────────────────────────────────────────────────────────

    private static func headingPrefix(_ line: TextLine, stats: DocumentStats, gapAbove: CGFloat?, usedVision: Bool) -> String? {
        let text = line.text.trimmingCharacters(in: .whitespaces)
        guard text.count < 120, !text.isEmpty else { return nil }
        guard !text.hasSuffix(".") || text.hasSuffix("..."), !text.hasSuffix(","), !text.hasSuffix(";") else { return nil }
        // A heading must SAY something: at least one word of 3+ letters. This
        // kills page numbers ("- 2 -"), folio decorations, and stray markers.
        guard text.range(of: #"[A-Za-z]{3,}"#, options: .regularExpression) != nil else { return nil }
        // Dot leaders = a table-of-contents entry, never a heading.
        guard text.range(of: #"\.{3,}|(?:\. ){3,}"#, options: .regularExpression) == nil else { return nil }
        // Standalone: clear space above (or top of page).
        let isolated = gapAbove == nil || gapAbove! > stats.modalLineSpacing * 1.3
        guard isolated else { return nil }

        let startsLower = text.first.map { $0.isLowercase } ?? false
        let ratio = line.fontSize / stats.bodyFontSize

        if usedVision {
            // Vision's font size is a box-height PROXY with ±20% noise, so the
            // low tiers misfire on ordinary prose lines. Demand more: bigger
            // ratios, shorter text, and no lowercase-start wrapped fragments.
            guard !startsLower, text.count < 70 else { return nil }
            if ratio >= 1.8 { return "# " }
            if ratio >= 1.45 { return "## " }
            return nil
        }

        if ratio >= 1.7 { return "# " }
        if ratio >= 1.4 { return "## " }
        // The touchy tiers additionally reject lowercase starts (wrapped
        // sentence fragments) — real text-layer titles keep their case.
        if startsLower { return nil }
        if ratio >= 1.15 { return "### " }
        if line.isBold, ratio >= 0.95, text.count < 80 { return "### " }
        return nil
    }

    // ── Paragraph assembly ────────────────────────────────────────────────────

    /// Compose one column's lines into heading/paragraph blocks.
    private static func composeBlocks(_ lines: [TextLine], stats: DocumentStats, usedVision: Bool) -> [String] {
        guard !lines.isEmpty else { return [] }
        let columnMinX = lines.map(\.rect.minX).min() ?? 0

        var blocks: [String] = []
        var paragraph = ""

        func flush() {
            let p = paragraph.trimmingCharacters(in: .whitespaces)
            if !p.isEmpty { blocks.append(p) }
            paragraph = ""
        }

        for (i, line) in lines.enumerated() {
            let gapAbove: CGFloat? = i > 0 ? (lines[i - 1].rect.midY - line.rect.midY) : nil

            if let prefix = headingPrefix(line, stats: stats, gapAbove: gapAbove, usedVision: usedVision) {
                // A heading only counts when it does NOT continue a paragraph —
                // a bold lead-in mid-paragraph must stay inline.
                if paragraph.isEmpty || (gapAbove ?? 0) > stats.modalLineSpacing * 1.3 {
                    flush()
                    blocks.append(prefix + lineText(line))
                    continue
                }
            }

            let text = lineText(line)
            if paragraph.isEmpty {
                paragraph = text
                continue
            }

            let bigGap = (gapAbove ?? 0) > stats.modalLineSpacing * 1.6
            let indented = line.rect.minX > columnMinX + line.fontSize * 0.8
            let startsParagraph = bigGap || indented

            if startsParagraph {
                flush()
                paragraph = text
            } else if paragraph.hasSuffix("-"), let first = text.first, first.isLowercase {
                // In-page hyphenation: "accumu-" + "lation" → "accumulation".
                paragraph.removeLast()
                paragraph += text
            } else {
                paragraph += " " + text
            }
        }
        flush()
        return blocks
    }

    // ── Footnote block ────────────────────────────────────────────────────────

    /// Peel the page-bottom footnote block off the body: a maximal trailing run
    /// of clearly-smaller-than-body lines that starts (somewhere) with a
    /// number-led line. Returns (body, footnoteBlock).
    private static func splitFootnoteBlock(_ lines: [TextLine], stats: DocumentStats) -> ([TextLine], [TextLine]) {
        let small = { (l: TextLine) in l.fontSize > 0 && l.fontSize <= stats.bodyFontSize * 0.85 }

        var idx = lines.count
        while idx > 0, small(lines[idx - 1]) { idx -= 1 }
        guard idx < lines.count else { return (lines, []) }

        let block = Array(lines[idx...])
        // The block must be led (at its top) by a footnote-def-looking line:
        // "N. text", "N text", or a symbol marker. Otherwise it's a caption /
        // small-print block — keep it in the body.
        let firstText = block[0].text.trimmingCharacters(in: .whitespaces)
        let defLike = firstText.range(of: #"^\d{1,3}[.\s]\s*\S"#, options: .regularExpression) != nil
            || firstText.range(of: #"^[\*\u{2020}\u{2021}]\s*\S"#, options: .regularExpression) != nil
        guard defLike else { return (lines, []) }

        return (Array(lines[..<idx]), block)
    }

    /// Emit footnote definitions. When the block's leading numbers form a
    /// plausible ascending run, emit the explicit `[^N]: text` form; otherwise
    /// keep line-start `N. text` and let the pipeline decide.
    private static func composeFootnoteDefs(_ lines: [TextLine], stats: DocumentStats) -> [String] {
        // Group continuation lines under their leading-number line.
        var defs: [(number: Int?, text: String)] = []
        for line in lines {
            let text = lineText(line)
            if let match = text.range(of: #"^\d{1,3}(?=[.\s])"#, options: .regularExpression),
               let num = Int(text[match]) {
                var rest = String(text[match.upperBound...])
                if rest.hasPrefix(".") { rest.removeFirst() }
                defs.append((num, rest.trimmingCharacters(in: .whitespaces)))
            } else if text.first == "*" || text.first == "\u{2020}" || text.first == "\u{2021}" {
                defs.append((nil, text))
            } else if !defs.isEmpty {
                // Continuation of the previous definition (wrapped line).
                var last = defs.removeLast()
                if last.text.hasSuffix("-"), let first = text.first, first.isLowercase {
                    last.text.removeLast()
                    last.text += text
                } else {
                    last.text += " " + text
                }
                defs.append(last)
            } else {
                defs.append((nil, text))
            }
        }

        let numbers = defs.compactMap(\.number)
        let ascending = numbers.count >= 1 && zip(numbers, numbers.dropFirst()).allSatisfy { $0 < $1 }

        return defs.map { def in
            if let n = def.number, ascending {
                return "[^\(n)]: \(def.text)"
            }
            if let n = def.number {
                return "\(n). \(def.text)"
            }
            return def.text
        }
    }

    // ── Column detection ──────────────────────────────────────────────────────

    /// Reading-order groups for the page. Single-column pages (the common book
    /// case) come back as one top-to-bottom group. When the two-column test
    /// passes, the page is segmented vertically: full-width (spanning) lines —
    /// titles, author blocks — emit IN PLACE, and each contiguous run of narrow
    /// lines is ordered left column then right column.
    private static func orderedGroups(_ lines: [TextLine], warnings: inout [String], pageIndex: Int) -> [[TextLine]] {
        guard lines.count >= 8 else { return [lines] }

        let minX = lines.map(\.rect.minX).min() ?? 0
        let maxX = lines.map(\.rect.maxX).max() ?? 0
        let textWidth = maxX - minX
        guard textWidth > 0 else { return [lines] }

        // Column material must be narrow AND sit on one side of the page
        // midline — a centered standalone line (footer URL, centered heading)
        // straddles the gutter and would poison the cluster-disjointness test,
        // so it emits in place like a spanning line instead.
        let centerX = minX + textWidth / 2
        let isNarrow = { (l: TextLine) in
            l.rect.width <= textWidth * 0.6 && !(l.rect.minX < centerX && l.rect.maxX > centerX)
        }
        let narrow = lines.filter(isNarrow)

        // Whole-page gate: two-column only when most lines are narrow AND they
        // form two horizontally-disjoint clusters each under 55% of the width.
        guard narrow.count >= lines.count * 7 / 10, isTwoColumn(narrow, textWidth: textWidth, minX: minX) else {
            if narrow.count >= lines.count * 7 / 10 {
                warnings.append("page \(pageIndex + 1): ambiguous column layout, used top-to-bottom order")
            }
            return [lines]
        }

        // Segment: spanning lines flush the current narrow run and stand alone.
        var groups: [[TextLine]] = []
        var segment: [TextLine] = []
        func flushSegment() {
            guard !segment.isEmpty else { return }
            groups.append(contentsOf: orderSegment(segment, textWidth: textWidth, minX: minX))
            segment = []
        }
        for line in lines {
            if isNarrow(line) {
                segment.append(line)
            } else {
                flushSegment()
                groups.append([line])
            }
        }
        flushSegment()
        return groups
    }

    /// Order one narrow segment: left column top-to-bottom, then right. A
    /// segment too small to judge (or not cleanly two-cluster) stays in place.
    private static func orderSegment(_ segment: [TextLine], textWidth: CGFloat, minX: CGFloat) -> [[TextLine]] {
        guard segment.count >= 4, isTwoColumn(segment, textWidth: textWidth, minX: minX) else { return [segment] }
        let midX = minX + textWidth / 2
        let left = segment.filter { $0.rect.midX < midX }
        let right = segment.filter { $0.rect.midX >= midX }
        return [left, right].filter { !$0.isEmpty }
    }

    /// Two horizontally-disjoint clusters, each under 55% of the text width.
    private static func isTwoColumn(_ lines: [TextLine], textWidth: CGFloat, minX: CGFloat) -> Bool {
        let midX = minX + textWidth / 2
        let left = lines.filter { $0.rect.midX < midX }
        let right = lines.filter { $0.rect.midX >= midX }
        guard left.count >= 2, right.count >= 2 else { return false }

        let leftMaxX = left.map(\.rect.maxX).max() ?? 0
        let rightMinX = right.map(\.rect.minX).min() ?? 0
        guard leftMaxX <= rightMinX + 2 else { return false }
        let leftWidth = leftMaxX - (left.map(\.rect.minX).min() ?? 0)
        let rightWidth = (right.map(\.rect.maxX).max() ?? 0) - rightMinX
        return leftWidth < textWidth * 0.55 && rightWidth < textWidth * 0.55
    }

    /// A wrapped title arrives as consecutive same-level headings whose second
    /// part starts lowercase ("## Effect of … on reading ability" + "## and
    /// auditory-verbal memory") — join those; leave genuine sibling headings.
    private static func mergeWrappedHeadings(_ blocks: [String]) -> [String] {
        var out: [String] = []
        for block in blocks {
            if let last = out.last,
               let level = headingLevel(last), headingLevel(block) == level {
                let continuation = block.drop(while: { $0 == "#" || $0 == " " })
                if let first = continuation.first, first.isLowercase {
                    out[out.count - 1] = last + " " + continuation
                    continue
                }
            }
            out.append(block)
        }
        return out
    }

    private static func headingLevel(_ block: String) -> Int? {
        let hashes = block.prefix(while: { $0 == "#" }).count
        guard hashes > 0, block.dropFirst(hashes).first == " ", !block.contains("\n") else { return nil }
        return hashes
    }
}
