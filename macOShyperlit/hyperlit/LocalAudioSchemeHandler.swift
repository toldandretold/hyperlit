//
//  LocalAudioSchemeHandler.swift
//  hyperlit
//
//  Serves hyperlit-local://audio/<book>/<filename> to the WKWebView from the
//  AudioStore, WITH HTTP Range support — <audio> seeking issues Range requests
//  and refuses to scrub without 206 responses.
//
//  Registered on the WKWebViewConfiguration in ContentView (must happen before
//  the web view is created).
//

import WebKit

final class LocalAudioSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "hyperlit-local"

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url,
              url.host == "audio" else {
            fail(task, code: 400); return
        }
        // Path: /<book>/<filename>
        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count == 2 else { fail(task, code: 400); return }

        do {
            let fileURL = try AudioStore.audioFile(parts[0], parts[1])
            guard let data = try? Data(contentsOf: fileURL) else {
                fail(task, code: 404); return
            }
            respond(task, url: url, data: data, range: task.request.value(forHTTPHeaderField: "Range"))
        } catch {
            fail(task, code: 403)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // Data is served synchronously in start; nothing to cancel.
    }

    /// Full 200 or partial 206 depending on a Range: bytes=a-b header.
    private func respond(_ task: WKURLSchemeTask, url: URL, data: Data, range: String?) {
        let total = data.count

        if let range,
           let match = range.range(of: #"bytes=(\d*)-(\d*)"#, options: .regularExpression) {
            let spec = String(range[match]).dropFirst("bytes=".count)
            let bounds = spec.split(separator: "-", omittingEmptySubsequences: false)
            let start = Int(bounds.first ?? "") ?? 0
            let endRequested = bounds.count > 1 ? Int(bounds[1]) ?? (total - 1) : (total - 1)
            let end = min(endRequested, total - 1)

            guard start <= end, start < total else { fail(task, code: 416); return }

            let chunk = data.subdata(in: start..<(end + 1))
            let headers = [
                "Content-Type": "audio/mpeg",
                "Content-Length": String(chunk.count),
                "Content-Range": "bytes \(start)-\(end)/\(total)",
                "Accept-Ranges": "bytes",
            ]
            let response = HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: headers)!
            task.didReceive(response)
            task.didReceive(chunk)
            task.didFinish()
            return
        }

        let headers = [
            "Content-Type": "audio/mpeg",
            "Content-Length": String(total),
            "Accept-Ranges": "bytes",
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask, code: Int) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL)); return
        }
        let response = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: [:])!
        task.didReceive(response)
        task.didFinish()
    }
}
