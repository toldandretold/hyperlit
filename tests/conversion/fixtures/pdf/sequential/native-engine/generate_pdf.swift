// Draws the deterministic synthetic PDF for the native-engine conversion
// fixture: running headers, a title, body text with raised superscript
// footnote markers, page-bottom footnote blocks, and a two-page spread.
import Foundation
import CoreGraphics
import CoreText
import AppKit

let outPath = CommandLine.arguments[1]
let pageRect = CGRect(x: 0, y: 0, width: 595, height: 842)
var mediaBox = pageRect
let ctx = CGContext(URL(fileURLWithPath: outPath) as CFURL, mediaBox: &mediaBox, nil)!

func draw(_ text: String, x: CGFloat, y: CGFloat, size: CGFloat, bold: Bool = false) {
    let font = NSFont(name: bold ? "Helvetica-Bold" : "Helvetica", size: size)!
    let attr = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor.black])
    let line = CTLineCreateWithAttributedString(attr)
    ctx.textPosition = CGPoint(x: x, y: y)
    CTLineDraw(line, ctx)
}

/// Body text ending with a raised superscript marker.
func drawWithSuper(_ text: String, marker: String, x: CGFloat, y: CGFloat, size: CGFloat) {
    draw(text, x: x, y: y, size: size)
    let font = NSFont(name: "Helvetica", size: size)!
    let width = NSAttributedString(string: text, attributes: [.font: font]).size().width
    draw(marker, x: x + width + 1, y: y + size * 0.4, size: size * 0.6)
}

func header(_ pageNo: Int) {
    draw("Native Test Book", x: 72, y: 800, size: 9)
    draw("\(pageNo)", x: 500, y: 800, size: 9)
}

// ── Page 1 ────────────────────────────────────────────────────────────────
ctx.beginPDFPage(nil)
header(1)
draw("The Synthetic Treatise", x: 72, y: 720, size: 24, bold: true)
drawWithSuper("First point is contested.", marker: "1", x: 72, y: 660, size: 12)
draw("The argument continues on this line and then wraps down", x: 72, y: 644, size: 12)
draw("to a further line to exercise paragraph joining.", x: 72, y: 628, size: 12)
drawWithSuper("Second point follows directly after it.", marker: "2", x: 72, y: 596, size: 12)
draw("1. A note concerning cathedrals and central planning.", x: 72, y: 120, size: 9)
draw("2. A note concerning bazaars and emergent order.", x: 72, y: 104, size: 9)
ctx.endPDFPage()

// ── Page 2 ────────────────────────────────────────────────────────────────
ctx.beginPDFPage(nil)
header(2)
draw("Chapter Two", x: 72, y: 740, size: 18, bold: true)
drawWithSuper("Third point stands on its own here.", marker: "3", x: 72, y: 700, size: 12)
draw("A closing paragraph without any markers, whose only job is", x: 72, y: 668, size: 12)
draw("to give the composer ordinary prose to assemble.", x: 72, y: 652, size: 12)
draw("3. A note concerning the commons and shared governance.", x: 72, y: 120, size: 9)
ctx.endPDFPage()

// ── Page 3 (needed so the 3-page running-header threshold can fire) ───────
ctx.beginPDFPage(nil)
header(3)
draw("An epilogue page with plain text and no notes at all, so the", x: 72, y: 720, size: 12)
draw("running header repetition test has a third data point.", x: 72, y: 704, size: 12)
ctx.endPDFPage()

ctx.closePDF()
print("wrote \(outPath)")
