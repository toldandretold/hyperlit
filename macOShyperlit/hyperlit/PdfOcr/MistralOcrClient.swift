//
//  MistralOcrClient.swift
//  hyperlit
//
//  BYO-key Mistral OCR: when the user activates a Mistral OCR provider in
//  Settings (key in Keychain), ocr.run calls Mistral's API from native instead
//  of the on-device engine — highest quality, paid by the user directly, and
//  the key never crosses into JS. The response IS the target ocr_response.json
//  schema, so it uploads through the same seam as the native engine's output.
//
//  Delivery mirrors app/Python/ingestion/pdf/ocrFetch.py: PDFs ≤ 8MB go inline
//  as a base64 data-URL (dodges the upload→signed-URL eventual-consistency
//  404); larger files upload then fetch a signed URL (with 404 retry). Files
//  over 50MB (Mistral's hard cap) are rejected — the caller falls back to the
//  on-device engine rather than splitting.
//

import Foundation

nonisolated enum MistralOcrError: LocalizedError {
    case tooLarge
    case http(Int, String)
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .tooLarge:
            return "PDF exceeds Mistral's 50MB limit — converted on-device instead."
        case .http(let code, let body):
            return "Mistral OCR HTTP \(code): \(String(body.prefix(300)))"
        case .badResponse(let why):
            return "Mistral OCR returned an unusable response: \(why)"
        }
    }
}

nonisolated enum MistralOcrClient {

    static let inlineMaxBytes = 8 * 1024 * 1024
    static let hardMaxBytes = 50 * 1024 * 1024

    /// OCR a PDF via Mistral with the user's key. Returns the raw response
    /// JSON (already Mistral-shaped). `model`/`baseUrl` come from the provider
    /// profile ("mistral-ocr-latest" / "https://api.mistral.ai").
    static func run(fileURL: URL, fileName: String, apiKey: String, baseUrl: String, model: String) async throws -> Data {
        let pdfData = try Data(contentsOf: fileURL)
        guard pdfData.count <= hardMaxBytes else { throw MistralOcrError.tooLarge }

        let documentUrl: String
        if pdfData.count <= inlineMaxBytes {
            documentUrl = "data:application/pdf;base64," + pdfData.base64EncodedString()
        } else {
            let fileId = try await upload(pdfData, fileName: fileName, apiKey: apiKey, baseUrl: baseUrl)
            documentUrl = try await signedUrl(fileId: fileId, apiKey: apiKey, baseUrl: baseUrl)
        }

        var request = URLRequest(url: URL(string: baseUrl + "/v1/ocr")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 600
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": model.isEmpty ? "mistral-ocr-latest" : model,
            "document": ["type": "document_url", "document_url": documentUrl],
            "include_image_base64": true,
            "extract_header": true,
            "extract_footer": true,
        ] as [String: Any])

        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw MistralOcrError.http(code, String(data: data, encoding: .utf8) ?? "")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pages = json["pages"] as? [Any], !pages.isEmpty else {
            throw MistralOcrError.badResponse("no pages")
        }
        return data
    }

    // ── Upload + signed URL (files > 8MB) ─────────────────────────────────────

    private static func upload(_ pdfData: Data, fileName: String, apiKey: String, baseUrl: String) async throws -> String {
        let boundary = "hyperlit-" + UUID().uuidString
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        field("purpose", "ocr")
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\nContent-Type: application/pdf\r\n\r\n".data(using: .utf8)!)
        body.append(pdfData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var request = URLRequest(url: URL(string: baseUrl + "/v1/files")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 300
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = json["id"] as? String else {
            throw MistralOcrError.http(code, String(data: data, encoding: .utf8) ?? "")
        }
        return id
    }

    /// files.upload returns before the file is consistently queryable — an
    /// immediate signed-URL fetch can 404. Retry with backoff (~15s total),
    /// exactly like ocrFetch.py's _get_signed_url_with_retry.
    private static func signedUrl(fileId: String, apiKey: String, baseUrl: String) async throws -> String {
        var lastError: Error = MistralOcrError.badResponse("signed URL unavailable")
        for attempt in 0..<6 {
            var request = URLRequest(url: URL(string: baseUrl + "/v1/files/\(fileId)/url?expiry=1")!)
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(code),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let url = json["url"] as? String {
                    return url
                }
                guard code == 404 else {
                    throw MistralOcrError.http(code, String(data: data, encoding: .utf8) ?? "")
                }
                lastError = MistralOcrError.http(404, "file not yet queryable")
            } catch {
                lastError = error
            }
            if attempt < 5 {
                try await Task.sleep(nanoseconds: UInt64(0.5 * pow(2, Double(attempt)) * 1_000_000_000))
            }
        }
        throw lastError
    }
}
