//
//  AudioStore.swift
//  hyperlit
//
//  On-disk store for LOCALLY generated (BYO-key) book audio: per-book MP3s +
//  a manifest.json, under Application Support/Hyperlit/audio/<book>/.
//  Backs the bridge's file.* methods and the hyperlit-local:// scheme handler.
//
//  Security: book ids and filenames are constrained to a safe charset before
//  any path is built — a traversal attempt ("../", absolute paths, exotic
//  characters) throws rather than resolving.
//

import Foundation

enum AudioStoreError: Error, LocalizedError {
    case badName(String)
    case io(String)

    var errorDescription: String? {
        switch self {
        case .badName(let n): return "Unsafe book/filename: \(n)"
        case .io(let m): return m
        }
    }
}

enum AudioStore {
    // book ids: alnum + _ - . (sub-books never reach here — the player blocks
    // ids containing "/"). Filenames: the same charset + a required .mp3 suffix.
    private static let bookPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_.-]+$")
    private static let filePattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_.-]+\\.mp3$")

    static func validateBook(_ book: String) throws {
        let range = NSRange(book.startIndex..., in: book)
        guard !book.contains(".."), bookPattern.firstMatch(in: book, range: range) != nil else {
            throw AudioStoreError.badName(book)
        }
    }

    static func validateFilename(_ name: String) throws {
        let range = NSRange(name.startIndex..., in: name)
        guard !name.contains(".."), filePattern.firstMatch(in: name, range: range) != nil else {
            throw AudioStoreError.badName(name)
        }
    }

    /// Application Support/Hyperlit/audio — created on first use.
    static func rootDir() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        )
        let dir = base.appendingPathComponent("Hyperlit/audio", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func bookDir(_ book: String, create: Bool = false) throws -> URL {
        try validateBook(book)
        let dir = try rootDir().appendingPathComponent(book, isDirectory: true)
        if create {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    static func audioFile(_ book: String, _ filename: String) throws -> URL {
        try validateFilename(filename)
        return try bookDir(book).appendingPathComponent(filename, isDirectory: false)
    }

    // ── file.* method implementations ─────────────────────────────────────────

    static func writeAudio(book: String, filename: String, base64: String) throws -> Int {
        guard let data = Data(base64Encoded: base64) else {
            throw AudioStoreError.io("audio payload is not valid base64")
        }
        _ = try bookDir(book, create: true)
        try data.write(to: audioFile(book, filename), options: .atomic)
        return data.count
    }

    static func readManifest(book: String) throws -> Any? {
        let url = try bookDir(book).appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    static func writeManifest(book: String, json: Any) throws {
        _ = try bookDir(book, create: true)
        let data = try JSONSerialization.data(withJSONObject: json)
        try data.write(to: bookDir(book).appendingPathComponent("manifest.json"), options: .atomic)
    }

    /// Delete specific files, or the whole book dir when filenames is nil.
    static func deleteAudio(book: String, filenames: [String]?) throws {
        let dir = try bookDir(book)
        if let names = filenames {
            for name in names {
                try? FileManager.default.removeItem(at: audioFile(book, name))
            }
        } else {
            try? FileManager.default.removeItem(at: dir)
        }
    }
}
