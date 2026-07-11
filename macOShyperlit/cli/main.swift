//
//  main.swift
//  hyperlit-ocr
//
//  Command-line front end for the on-device PDF OCR engine (PdfOcr/ — the same
//  sources the macOS app embeds). Produces the Mistral-shaped ocr_response.json
//  the Hyperlit conversion pipeline replays from, so a Mac-hosted backend can
//  convert PDFs with no Mistral API call:
//
//    hyperlit-ocr <pdf_path> <output_json_path> [--progress] [--no-images]
//                 [--vlm <base_url>] [--vlm-model <model>] [--vlm-key <key>]
//
//  --progress prints PROGRESS:{"percent":..,"stage":"native_ocr","detail":".."}
//  lines on stdout — the same format the Python pipeline's emit_progress uses,
//  so PdfProcessor.php's StreamsProgress relays them to the import UI as-is.
//
//  --vlm routes OCR through an OpenAI-compatible vision model instead of the
//  geometric engine (e.g. --vlm http://localhost:11434/v1 --vlm-model qwen2.5vl
//  for Ollama) — slow but far better on scanned books.
//
//  Build: ./build-cli.sh (swiftc over cli/main.swift + hyperlit/PdfOcr/*.swift).
//

import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("hyperlit-ocr: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

var arguments = Array(CommandLine.arguments.dropFirst())
let showProgress = arguments.contains("--progress")
let noImages = arguments.contains("--no-images")

func flagValue(_ name: String) -> String? {
    guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
    let value = arguments[i + 1]
    arguments.removeSubrange(i...(i + 1))
    return value
}
let vlmBaseUrl = flagValue("--vlm")
let vlmModel = flagValue("--vlm-model") ?? "qwen2.5vl"
let vlmKey = flagValue("--vlm-key")
arguments.removeAll { $0.hasPrefix("--") }

guard arguments.count == 2 else {
    fail("usage: hyperlit-ocr <pdf_path> <output_json_path> [--progress] [--no-images] [--vlm <base_url>] [--vlm-model <model>] [--vlm-key <key>]")
}

let pdfURL = URL(fileURLWithPath: arguments[0])
let outputURL = URL(fileURLWithPath: arguments[1])

guard FileManager.default.fileExists(atPath: pdfURL.path) else {
    fail("PDF not found: \(pdfURL.path)")
}

func emitProgress(page: Int, totalPages: Int, stage: String) {
    guard showProgress, totalPages > 0 else { return }
    // Analysis (text/vision) is roughly the first two thirds of the work,
    // compose/images the rest; map both onto 5–90%.
    let phaseBase = (stage == "compose" || stage == "images") ? 60.0 : 5.0
    let phaseSpan = (stage == "compose" || stage == "images") ? 30.0 : 55.0
    let percent = Int(phaseBase + phaseSpan * Double(page) / Double(totalPages))
    let detail = "OCR (on-device): page \(page) of \(totalPages)"
    let event: [String: Any] = ["percent": percent, "stage": "native_ocr", "detail": detail]
    if let data = try? JSONSerialization.data(withJSONObject: event),
       let json = String(data: data, encoding: .utf8) {
        print("PROGRESS:" + json)
        FileHandle.standardOutput.synchronizeFile()
    }
}

// Progress lines are throttled to one per ~2% so a 600-page book doesn't spam
// the PHP relay; stage transitions always emit.
var lastPercentKey = -1
func relayProgress(_ progress: OcrProgress) {
    let key = progress.page * 50 / max(progress.totalPages, 1)
    if key != lastPercentKey || progress.page == progress.totalPages {
        lastPercentKey = key
        emitProgress(page: progress.page, totalPages: progress.totalPages, stage: progress.stage.rawValue)
    }
}

do {
    let json: Data
    if let vlmBaseUrl {
        // Async VLM path bridged to the CLI's synchronous world.
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<Data, Error> = .failure(VlmOcrError.badResponse("did not run"))
        Task {
            do {
                result = .success(try await VlmOcrClient.run(
                    fileURL: pdfURL, baseUrl: vlmBaseUrl, model: vlmModel, apiKey: vlmKey,
                    progress: relayProgress
                ))
            } catch {
                result = .failure(error)
            }
            semaphore.signal()
        }
        semaphore.wait()
        json = try result.get()
    } else {
        var engine = PdfOcrEngine()
        engine.extractImages = !noImages
        json = try engine.run(url: pdfURL, progress: relayProgress)
    }
    try json.write(to: outputURL)
    if showProgress {
        print("PROGRESS:" + #"{"percent": 92, "stage": "native_ocr", "detail": "On-device OCR complete. Assembling document..."}"#)
    }
    FileHandle.standardError.write("hyperlit-ocr: wrote \(json.count) bytes to \(outputURL.path)\n".data(using: .utf8)!)
} catch {
    fail(error.localizedDescription)
}
