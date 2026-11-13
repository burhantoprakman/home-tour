import CaptureCore
import Observation
import UIKit

/// The capture flow: home -> room pass -> details intro -> details pass (optional) -> finishing.
/// Paired (QR from the website): uploads each file and starts processing.
/// Not paired: keeps the files for export (share sheet / Finder over USB).
@MainActor @Observable
final class CaptureModel {
    enum Phase: Equatable {
        case home, roomPass, detailsIntro, detailsPass, finishing, finished, failed(String)
    }

    var phase: Phase = .home
    var status = LiveStatus()
    var link: PairLink?
    var target: CaptureUploads?
    var pairError: String?
    /// Upload progress per file name (0...1).
    var uploads: [String: Double] = [:]
    var folder: URL?
    var hasDetails = false
    var objectActive = false

    let controller = CaptureController()
    private var videoUpload: Task<Void, Error>?

    init() {
        controller.onStatus = { [weak self] s in self?.status = s }
    }

    // MARK: pairing

    func open(url: URL) {
        guard let l = PairLink(url: url) else { pairError = "That link isn't a Home Tour pairing code."; return }
        link = l; pairError = nil; target = nil
        Task {
            do { target = try await Backend(link: l).uploads() } catch {
                pairError = error.localizedDescription; link = nil
            }
        }
    }

    func unpair() { link = nil; target = nil }

    // MARK: flow

    func begin() {
        let dir = URL.documentsDirectory.appending(path: "captures/\(Self.stamp())")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        folder = dir
        hasDetails = false; uploads = [:]
        UIApplication.shared.isIdleTimerDisabled = true
        controller.start()
        controller.startPass(.room, video: dir.appending(path: "video.mov"), poses: dir.appending(path: "poses.jsonl"))
        phase = .roomPass
    }

    func finishRoomPass() {
        Task {
            do {
                _ = try await controller.stopPass()
                if let t = target, let dir = folder {
                    videoUpload = upload(t.video, file: dir.appending(path: "video.mov"), label: "Room video")
                }
                phase = .detailsIntro
            } catch { fail(error) }
        }
    }

    func startDetails() {
        guard let dir = folder else { return }
        hasDetails = true
        controller.startPass(.details, video: dir.appending(path: "details.mov"), poses: dir.appending(path: "poses.jsonl"))
        phase = .detailsPass
    }

    func toggleObject() {
        if objectActive { controller.endObject() } else { controller.startObject() }
        objectActive.toggle()
    }

    func finish() {
        phase = .finishing
        Task {
            do {
                if hasDetails { _ = try await controller.stopPass() }
                objectActive = false
                let floorY = controller.floorY
                controller.closeLog()
                controller.stop()
                UIApplication.shared.isIdleTimerDisabled = false
                try writeBundle(floorY: floorY)
                if let t = target, let dir = folder, let l = link {
                    let bg = UIApplication.shared.beginBackgroundTask(withName: "upload")
                    defer { UIApplication.shared.endBackgroundTask(bg) }
                    var tasks = [upload(t.bundle, file: dir.appending(path: "capture.zip"), label: "Camera path")]
                    if hasDetails { tasks.append(upload(t.details, file: dir.appending(path: "details.mov"), label: "Details video")) }
                    try await videoUpload?.value
                    for task in tasks { try await task.value }
                    try await Backend(link: l).done(details: hasDetails)
                }
                phase = .finished
            } catch { fail(error) }
        }
    }

    func reset() {
        controller.stop()
        UIApplication.shared.isIdleTimerDisabled = false
        videoUpload?.cancel()
        phase = .home
    }

    var exportFiles: [URL] {
        guard let dir = folder else { return [] }
        return ["video.mov", "details.mov", "capture.zip"].map { dir.appending(path: $0) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    // MARK: helpers

    private func writeBundle(floorY: Float?) throws {
        guard let dir = folder else { return }
        let f = controller.videoFormat
        let device = CaptureDevice(
            model: Self.modelIdentifier, systemVersion: UIDevice.current.systemVersion,
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            video: .init(width: Int(f?.imageResolution.width ?? 0), height: Int(f?.imageResolution.height ?? 0),
                         fps: Double(f?.framesPerSecond ?? 30)),
            exposureLocked: controller.exposureLocked, lidar: false, floorY: floorY)
        let enc = JSONEncoder()
        try enc.encode(device).write(to: dir.appending(path: "device.json"))
        try enc.encode(controller.objects).write(to: dir.appending(path: "objects.json"))
        try ZipWriter.write([
            .init(name: "poses.jsonl", source: dir.appending(path: "poses.jsonl")),
            .init(name: "objects.json", source: dir.appending(path: "objects.json")),
            .init(name: "device.json", source: dir.appending(path: "device.json")),
        ], to: dir.appending(path: "capture.zip"))
    }

    private func upload(_ target: UploadTarget, file: URL, label: String) -> Task<Void, Error> {
        uploads[label] = 0
        return Task {
            try await TusUploader(target: target).upload(file: file) { sent, total in
                Task { @MainActor in self.uploads[label] = total > 0 ? Double(sent) / Double(total) : 1 }
            }
        }
    }

    private func fail(_ error: Error) {
        UIApplication.shared.isIdleTimerDisabled = false
        phase = .failed(error.localizedDescription)
    }

    private static func stamp() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd_HH-mm-ss"; return f.string(from: .now)
    }

    private static var modelIdentifier: String {
        var info = utsname(); uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
}
