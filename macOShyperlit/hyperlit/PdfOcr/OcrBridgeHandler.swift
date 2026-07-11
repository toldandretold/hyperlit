//
//  OcrBridgeHandler.swift
//  hyperlit
//
//  Session manager behind the ocr.* bridge methods. The 4MB bridge-envelope cap
//  means the PDF arrives (ocr.begin/ocr.chunk) and the result JSON leaves
//  (ocr.result) in base64 chunks; between the two, ocr.run executes PdfOcrEngine
//  on a detached task, pushing ocr_progress events and one ocr_complete event.
//
//  Chunk sizing: kChunkBytes is the RAW byte slice per chunk — 2MB raw → ~2.7MB
//  base64, safely under the 4MB envelope cap in both directions.
//
//  Temp PDFs live in Application Support/ocr/ inside the sandbox container
//  (no extra entitlements); sessions are deleted on end/cancel/error and any
//  session older than 30 minutes is garbage-collected.
//

import Foundation
import os

struct OcrBridgeError: Error {
    let code: String
    let message: String
}

let kOcrChunkBytes = 2 * 1024 * 1024

final class OcrBridgeHandler {

    /// Cross-thread cancel flag: flipped on the main actor, read by the engine
    /// on its detached task.
    private final class CancelFlag {
        private let lock = OSAllocatedUnfairLock(initialState: false)
        var isCancelled: Bool { lock.withLock { $0 } }
        func cancel() { lock.withLock { $0 = true } }
    }

    private final class Session {
        let id: String
        let fileURL: URL
        let bytesTotal: Int
        var receivedBytes = 0
        var nextChunkSeq = 0
        var handle: FileHandle?
        var running = false
        var resultChunks: [String] = []
        let cancelFlag = CancelFlag()
        let createdAt = Date()

        init(id: String, fileURL: URL, bytesTotal: Int) {
            self.id = id
            self.fileURL = fileURL
            self.bytesTotal = bytesTotal
        }
    }

    private var sessions: [String: Session] = [:]

    /// Set by Bridge: pushes an event envelope (no id) to the web layer.
    var emitEvent: (_ event: String, _ data: [String: Any]) -> Void = { _, _ in }

    /// Set by Bridge: the user's active BYO OCR provider (e.g. Mistral OCR)
    /// with its Keychain key, or nil to use the on-device engine. Resolved per
    /// run so Settings changes apply immediately. The key stays native-side.
    var byoOcrProvider: () -> (baseUrl: String, model: String, apiKey: String)? = { nil }

    private var ocrDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("ocr", isDirectory: true)
    }

    // ── ocr.begin ─────────────────────────────────────────────────────────────

    func begin(payload: [String: Any]) throws -> [String: Any] {
        collectGarbage()

        guard let bytesTotal = payload["bytesTotal"] as? Int, bytesTotal > 0,
              bytesTotal <= 250 * 1024 * 1024 else {
            throw OcrBridgeError(code: "internal", message: "bytesTotal missing or out of range")
        }

        let id = "ocr_" + UUID().uuidString.lowercased()
        let dir = ocrDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fileURL = dir.appendingPathComponent("\(id).pdf")
        guard FileManager.default.createFile(atPath: fileURL.path, contents: nil) else {
            throw OcrBridgeError(code: "internal", message: "could not create temp file")
        }

        let session = Session(id: id, fileURL: fileURL, bytesTotal: bytesTotal)
        session.handle = try? FileHandle(forWritingTo: fileURL)
        guard session.handle != nil else {
            try? FileManager.default.removeItem(at: fileURL)
            throw OcrBridgeError(code: "internal", message: "could not open temp file")
        }
        sessions[id] = session

        return ["sessionId": id, "chunkSize": kOcrChunkBytes]
    }

    // ── ocr.chunk ─────────────────────────────────────────────────────────────

    func chunk(payload: [String: Any]) throws -> [String: Any] {
        let session = try session(from: payload)
        guard !session.running else {
            throw OcrBridgeError(code: "internal", message: "session already running")
        }
        guard let seq = payload["seq"] as? Int, seq == session.nextChunkSeq else {
            throw OcrBridgeError(code: "internal", message: "chunk out of order")
        }
        guard let b64 = payload["dataBase64"] as? String,
              let data = Data(base64Encoded: b64), !data.isEmpty else {
            throw OcrBridgeError(code: "internal", message: "dataBase64 missing or invalid")
        }
        guard session.receivedBytes + data.count <= session.bytesTotal else {
            throw OcrBridgeError(code: "internal", message: "more bytes than declared")
        }

        session.handle?.write(data)
        session.receivedBytes += data.count
        session.nextChunkSeq += 1
        return ["receivedBytes": session.receivedBytes]
    }

    // ── ocr.run ───────────────────────────────────────────────────────────────

    func run(payload: [String: Any]) throws -> [String: Any] {
        let session = try session(from: payload)
        guard !session.running else {
            throw OcrBridgeError(code: "internal", message: "session already running")
        }
        guard session.receivedBytes == session.bytesTotal else {
            throw OcrBridgeError(code: "internal", message: "incomplete upload (\(session.receivedBytes)/\(session.bytesTotal) bytes)")
        }
        try? session.handle?.close()
        session.handle = nil
        session.running = true

        let sessionId = session.id
        let fileURL = session.fileURL
        let fileName = (payload["name"] as? String) ?? "document.pdf"
        let cancelFlag = session.cancelFlag
        let byo = byoOcrProvider()

        Task.detached(priority: .userInitiated) { [weak self] in
            // Throttle progress pushes: one evaluateJavaScript per ~250ms is
            // plenty for a progress bar; per-page on a 600-page book is not.
            let throttle = OSAllocatedUnfairLock(initialState: Date.distantPast)

            do {
                let (json, source) = try await Self.produceOcrJson(
                    fileURL: fileURL,
                    fileName: fileName,
                    byo: byo,
                    cancelFlag: cancelFlag
                ) { progress in
                    let now = Date()
                    let due = throttle.withLock { last -> Bool in
                        let isLast = progress.totalPages > 0 && progress.page == progress.totalPages
                        guard isLast || now.timeIntervalSince(last) >= 0.25 else { return false }
                        last = now
                        return true
                    }
                    guard due else { return }
                    Task { @MainActor [weak self] in
                        self?.emitEvent("ocr_progress", [
                            "sessionId": sessionId,
                            "page": progress.page,
                            "totalPages": progress.totalPages,
                            "stage": progress.stage.rawValue,
                        ])
                    }
                }

                let chunks = stride(from: 0, to: json.count, by: kOcrChunkBytes).map {
                    json.subdata(in: $0..<min($0 + kOcrChunkBytes, json.count)).base64EncodedString()
                }
                let pageCount = (try? JSONSerialization.jsonObject(with: json) as? [String: Any])
                    .flatMap { ($0["pages"] as? [Any])?.count } ?? 0

                await MainActor.run { [weak self] in
                    guard let self, let live = self.sessions[sessionId] else { return }
                    live.resultChunks = chunks
                    live.running = false
                    self.emitEvent("ocr_complete", [
                        "sessionId": sessionId,
                        "ok": true,
                        "pages": pageCount,
                        "resultBytes": json.count,
                        "chunkCount": chunks.count,
                        "source": source,   // "native" | "mistral" — upload provenance
                    ])
                }
            } catch {
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.destroySession(sessionId)
                    self.emitEvent("ocr_complete", [
                        "sessionId": sessionId,
                        "ok": false,
                        "error": error.localizedDescription,
                    ])
                }
            }
        }

        return ["accepted": true]
    }

    /// Produce the OCR JSON: the user's BYO provider (Mistral) when one is
    /// active, otherwise the on-device engine. A PDF over Mistral's 50MB cap
    /// falls back to on-device rather than failing. Returns the JSON plus its
    /// source ("mistral" | "native") for upload provenance.
    private nonisolated static func produceOcrJson(
        fileURL: URL,
        fileName: String,
        byo: (baseUrl: String, model: String, apiKey: String)?,
        cancelFlag: CancelFlag,
        progress: @escaping (OcrProgress) -> Void
    ) async throws -> (Data, String) {
        if let byo {
            // Keepalive pulse while the remote call runs (can take minutes on a
            // big book) so the web side's stall watchdog doesn't fire.
            let keepalive = Task {
                while !Task.isCancelled {
                    progress(OcrProgress(page: 0, totalPages: 0, stage: .mistral))
                    try await Task.sleep(nanoseconds: 20_000_000_000)
                }
            }
            defer { keepalive.cancel() }
            do {
                let json = try await MistralOcrClient.run(
                    fileURL: fileURL, fileName: fileName,
                    apiKey: byo.apiKey, baseUrl: byo.baseUrl, model: byo.model
                )
                return (json, "mistral")
            } catch MistralOcrError.tooLarge {
                // fall through to on-device below
            }
        }
        var engine = PdfOcrEngine()
        engine.isCancelled = { cancelFlag.isCancelled }
        return (try engine.run(url: fileURL, progress: progress), "native")
    }

    // ── ocr.result ────────────────────────────────────────────────────────────

    func result(payload: [String: Any]) throws -> [String: Any] {
        let session = try session(from: payload)
        guard !session.resultChunks.isEmpty else {
            throw OcrBridgeError(code: "internal", message: "no result available")
        }
        guard let seq = payload["seq"] as? Int, seq >= 0, seq < session.resultChunks.count else {
            throw OcrBridgeError(code: "internal", message: "result seq out of range")
        }
        return [
            "dataBase64": session.resultChunks[seq],
            "last": seq == session.resultChunks.count - 1,
        ]
    }

    // ── ocr.end / ocr.cancel ──────────────────────────────────────────────────

    func end(payload: [String: Any]) throws -> [String: Any] {
        if let id = payload["sessionId"] as? String {
            sessions[id]?.cancelFlag.cancel()
            destroySession(id)
        }
        return ["ok": true]
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private func session(from payload: [String: Any]) throws -> Session {
        guard let id = payload["sessionId"] as? String, let session = sessions[id] else {
            throw OcrBridgeError(code: "internal", message: "session_not_found")
        }
        return session
    }

    private func destroySession(_ id: String) {
        guard let session = sessions.removeValue(forKey: id) else { return }
        try? session.handle?.close()
        try? FileManager.default.removeItem(at: session.fileURL)
    }

    private func collectGarbage() {
        let cutoff = Date().addingTimeInterval(-30 * 60)
        for (id, session) in sessions where session.createdAt < cutoff {
            session.cancelFlag.cancel()
            destroySession(id)
        }
    }
}
