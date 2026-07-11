//
//  VlmOcrClient.swift
//  hyperlit
//
//  OCR via a vision-language model — the "what Mistral does, locally" path.
//  Each page is rendered to an image and sent to an OpenAI-compatible
//  chat-completions endpoint (Ollama, LM Studio, or any hosted service) with a
//  transcription prompt; the model decides what is a heading, what is a
//  footnote, and what is a page number — the judgments geometric heuristics
//  fundamentally can't make on messy scans (Vision misreads superscript
//  markers as ®/'; a VLM reads them as digits).
//
//  Trade-off: a local 7B-class VLM takes seconds per page and needs ~8GB+ of
//  RAM, vs milliseconds per page for the geometric engine. Quality on scanned
//  academic material is far higher.
//

import Foundation
import PDFKit

nonisolated enum VlmOcrError: LocalizedError {
    case cannotOpen
    case http(Int, String)
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .cannotOpen: return "The file could not be opened as a PDF."
        case .http(let code, let body): return "VLM endpoint HTTP \(code): \(String(body.prefix(300)))"
        case .badResponse(let why): return "VLM endpoint returned an unusable response: \(why)"
        }
    }
}

nonisolated enum VlmOcrClient {

    static let pagePrompt = """
    Transcribe this scanned page to Markdown. Rules:
    - Output ONLY the page's content as Markdown. No commentary, no code fences.
    - Use #/##/### only for real section or chapter headings. Page numbers, \
    running headers/footers, and table-of-contents lines are NEVER headings — \
    omit running headers, footers, and bare page numbers entirely.
    - Footnote references in the text: write them as [^N] immediately after the \
    word they follow. Footnote definitions (usually smaller print at the bottom \
    of the page): write each on its own line as [^N]: followed by its text.
    - Join words hyphenated across line breaks. Write each paragraph as one \
    block; separate paragraphs with a blank line.
    - Transcribe tables as Markdown tables.
    - For charts, figures, or photos, write one short italic line describing \
    the figure instead of transcribing its axis labels.
    - If the page is blank, output nothing.
    """

    /// OCR a whole PDF through a vision model. Returns Mistral-shaped JSON
    /// bytes (same contract as PdfOcrEngine). Pages are processed sequentially
    /// — local VLM servers serialize requests anyway.
    static func run(
        fileURL: URL,
        baseUrl: String,
        model: String,
        apiKey: String?,
        isCancelled: () -> Bool = { false },
        progress: (OcrProgress) -> Void
    ) async throws -> Data {
        guard let document = PDFDocument(url: fileURL) else { throw VlmOcrError.cannotOpen }
        let pageCount = document.pageCount
        guard pageCount > 0 else { throw VlmOcrError.badResponse("empty PDF") }

        var pages: [OcrPage] = []
        for i in 0..<pageCount {
            if isCancelled() { throw PdfOcrError.cancelled }
            progress(OcrProgress(page: i + 1, totalPages: pageCount, stage: .vlm))

            var markdown = ""
            var dims = OcrDimensions(dpi: 72, height: 0, width: 0)
            if let page = document.page(at: i) {
                let bounds = page.bounds(for: .mediaBox)
                dims = OcrDimensions(dpi: 72, height: Int(bounds.height), width: Int(bounds.width))
                let jpeg: Data? = autoreleasepool {
                    VisionPageOcr.render(page: page, bounds: bounds)
                        .flatMap { ImageExtractor.encodeJPEG($0, quality: 0.8) }
                }
                if let jpeg {
                    markdown = try await transcribe(jpeg: jpeg, baseUrl: baseUrl, model: model, apiKey: apiKey)
                }
            }

            pages.append(OcrPage(
                index: i,
                markdown: markdown,
                images: [],
                dimensions: dims,
                tables: [],
                hyperlinks: [],
                header: "",
                footer: ""
            ))
        }

        let response = OcrResponse(
            pages: pages,
            model: kOcrModelName,
            usage_info: OcrUsageInfo(
                pages_processed: pageCount,
                text_layer_pages: 0,
                vision_pages: pageCount,
                engine_version: kOcrEngineVersion + "+vlm(\(model))",
                warnings: []
            ),
            document_annotation: nil
        )
        return try response.encoded()
    }

    /// One page → markdown via an OpenAI-compatible /chat/completions call.
    static func transcribe(jpeg: Data, baseUrl: String, model: String, apiKey: String?) async throws -> String {
        let base = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
        guard let url = URL(string: base + "/chat/completions") else {
            throw VlmOcrError.badResponse("invalid base URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 600   // local models can be slow per page
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let apiKey, !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": model,
            "temperature": 0,
            "messages": [[
                "role": "user",
                "content": [
                    ["type": "text", "text": pagePrompt],
                    ["type": "image_url", "image_url": [
                        "url": "data:image/jpeg;base64," + jpeg.base64EncodedString(),
                    ]],
                ],
            ]],
        ] as [String: Any])

        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw VlmOcrError.http(code, String(data: data, encoding: .utf8) ?? "")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let content = message["content"] as? String else {
            throw VlmOcrError.badResponse("no choices[0].message.content")
        }
        return cleaned(content)
    }

    /// Models love wrapping output in ```markdown fences despite instructions.
    private static func cleaned(_ content: String) -> String {
        var text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("```") {
            if let firstNewline = text.firstIndex(of: "\n") {
                text = String(text[text.index(after: firstNewline)...])
            }
            if text.hasSuffix("```") {
                text = String(text.dropLast(3))
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
