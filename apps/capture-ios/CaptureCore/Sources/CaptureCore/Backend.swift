import Foundation

/// `hometour://pair?api=<origin>&token=<capture token>` from the QR code on the web
/// "Add room" screen (the system Camera app opens it in this app).
public struct PairLink: Sendable, Equatable {
    public var api: URL
    public var token: String

    public init?(url: URL) {
        guard url.scheme == "hometour", url.host == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let apiString = items.first(where: { $0.name == "api" })?.value,
              let api = URL(string: apiString), ["https", "http"].contains(api.scheme ?? ""),
              let token = items.first(where: { $0.name == "token" })?.value, token.count >= 20
        else { return nil }
        self.api = api; self.token = token
    }
}

// Mirrors packages/shared/src/api.ts (ResumableUpload, CaptureUploadTarget, CaptureUploadsResponse).
public struct ResumableUpload: Codable, Sendable, Equatable {
    public var `protocol`: String
    public var endpoint: URL
    public var bucketName: String
    public var objectName: String
    public var contentType: String
    public var chunkSize: Int
}

public struct UploadTarget: Codable, Sendable, Equatable {
    public var upload: ResumableUpload
    public var headers: [String: String]
}

public struct CaptureUploads: Codable, Sendable, Equatable {
    public var roomId: String
    public var roomName: String
    public var homeName: String
    public var video: UploadTarget
    public var details: UploadTarget
    public var bundle: UploadTarget
}

public struct BackendError: Error, LocalizedError, Sendable {
    public var status: Int
    public var message: String
    public var errorDescription: String? { message }
}

/// The two token-authenticated routes the app calls.
public struct Backend: Sendable {
    public var link: PairLink
    public var session: URLSession

    public init(link: PairLink, session: URLSession = .shared) {
        self.link = link; self.session = session
    }

    private func url(_ suffix: String) -> URL {
        link.api.appending(path: "api/capture/\(link.token)/\(suffix)")
    }

    public func uploads() async throws -> CaptureUploads {
        try await post("uploads", body: [String: String]())
    }

    public func done(details: Bool) async throws {
        struct Ok: Decodable {}
        let _: Ok = try await post("done", body: ["details": details])
    }

    private func post<Body: Encodable, Out: Decodable>(_ suffix: String, body: Body) async throws -> Out {
        var req = URLRequest(url: url(suffix))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, res) = try await session.data(for: req)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw BackendError(status: status, message: msg ?? "Server error (\(status))")
        }
        return try JSONDecoder().decode(Out.self, from: data)
    }
}

/// TUS 1.0 client for Supabase Storage (same protocol as apps/web/src/lib/tus.ts): create,
/// PATCH exact `chunkSize` chunks, HEAD to resume. The upload URL is remembered in
/// UserDefaults so a relaunch resumes from the server's offset.
public struct TusUploader: Sendable {
    public var target: UploadTarget
    public var session: URLSession
    public var retryDelays: [Double] = [0, 1, 3, 5, 10, 20]
    public var store: @Sendable (String, String?) -> Void
    public var load: @Sendable (String) -> String?

    public init(target: UploadTarget, session: URLSession = .shared) {
        self.target = target; self.session = session
        store = { k, v in UserDefaults.standard.set(v, forKey: k) }
        load = { UserDefaults.standard.string(forKey: $0) }
    }

    public func upload(file: URL, progress: @Sendable (Int64, Int64) -> Void) async throws {
        let size = try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int64 ?? 0
        let key = "tus:\(target.upload.bucketName)/\(target.upload.objectName):\(size)"
        var location = load(key).flatMap(URL.init(string:))
        var offset: Int64 = 0
        if let loc = location, let o = try? await head(loc) {
            offset = o
        } else {
            location = try await create(size: size)
            store(key, location!.absoluteString)
        }
        let h = try FileHandle(forReadingFrom: file)
        defer { try? h.close() }
        progress(offset, size)
        var failures = 0
        while offset < size {
            try Task.checkCancellation()
            try h.seek(toOffset: UInt64(offset))
            let chunk = try h.read(upToCount: target.upload.chunkSize) ?? Data()
            do {
                offset = try await patch(location!, offset: offset, chunk: chunk)
                failures = 0
                progress(offset, size)
            } catch let e as BackendError where e.status == 409 {
                offset = try await head(location!)  // offset mismatch: ask the server
            } catch {
                guard failures < retryDelays.count else { throw error }
                try await Task.sleep(for: .seconds(retryDelays[failures]))
                failures += 1
                if let o = try? await head(location!) { offset = o }
            }
        }
        store(key, nil)
    }

    private func request(_ url: URL, _ method: String) -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("1.0.0", forHTTPHeaderField: "Tus-Resumable")
        for (k, v) in target.headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    private func metadata() -> String {
        let u = target.upload
        return [("bucketName", u.bucketName), ("objectName", u.objectName),
                ("contentType", u.contentType), ("cacheControl", "3600")]
            .map { "\($0.0) \(Data($0.1.utf8).base64EncodedString())" }
            .joined(separator: ",")
    }

    private func create(size: Int64) async throws -> URL {
        var r = request(target.upload.endpoint, "POST")
        r.setValue(String(size), forHTTPHeaderField: "Upload-Length")
        r.setValue(metadata(), forHTTPHeaderField: "Upload-Metadata")
        r.setValue("true", forHTTPHeaderField: "x-upsert")
        let (_, res) = try await session.data(for: r)
        let http = res as! HTTPURLResponse
        guard http.statusCode == 201, let loc = http.value(forHTTPHeaderField: "Location"),
              let url = URL(string: loc, relativeTo: target.upload.endpoint)?.absoluteURL
        else { throw BackendError(status: http.statusCode, message: "Upload could not start (\(http.statusCode))") }
        return url
    }

    private func head(_ url: URL) async throws -> Int64 {
        let (_, res) = try await session.data(for: request(url, "HEAD"))
        let http = res as! HTTPURLResponse
        guard http.statusCode == 200 || http.statusCode == 204,
              let o = http.value(forHTTPHeaderField: "Upload-Offset").flatMap(Int64.init)
        else { throw BackendError(status: http.statusCode, message: "Upload expired") }
        return o
    }

    private func patch(_ url: URL, offset: Int64, chunk: Data) async throws -> Int64 {
        var r = request(url, "PATCH")
        r.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
        r.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
        let (_, res) = try await session.upload(for: r, from: chunk)
        let http = res as! HTTPURLResponse
        guard http.statusCode == 204,
              let o = http.value(forHTTPHeaderField: "Upload-Offset").flatMap(Int64.init)
        else { throw BackendError(status: http.statusCode, message: "Upload failed (\(http.statusCode))") }
        return o
    }
}
