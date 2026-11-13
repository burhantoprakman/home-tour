import Foundation
import simd

/// Files of capture.zip. Keys match packages/shared/src/capture.ts (CapturePose,
/// CaptureObject, CaptureDevice); keep both in sync.
public enum CapturePass: String, Codable, Sendable { case room, details }

public struct PoseLine: Codable, Sendable, Equatable {
    public var pass: CapturePass
    public var frame: Int
    public var t: Double
    public var transform: [Float]
    public var fx: Float, fy: Float, cx: Float, cy: Float
    public var width: Int, height: Int
    public var tracking: CameraSample.Tracking
    public var trackingReason: String?
    public var fast: Bool
    public var objectId: Int?

    public init(pass: CapturePass, frame: Int, t: Double, sample: CameraSample,
                trackingReason: String?, fast: Bool, objectId: Int?) {
        self.pass = pass; self.frame = frame; self.t = t
        transform = sample.transform.columnMajor
        fx = sample.fx; fy = sample.fy; cx = sample.cx; cy = sample.cy
        width = sample.width; height = sample.height
        tracking = sample.tracking
        self.trackingReason = trackingReason; self.fast = fast; self.objectId = objectId
    }
}

public struct CaptureObject: Codable, Sendable, Equatable {
    public var id: Int
    public var anchor: [Float]
    public var start: Double
    public var end: Double
    public var sweptDeg: Float
    public init(id: Int, anchor: SIMD3<Float>, start: Double, end: Double, sweptDeg: Float) {
        self.id = id; self.anchor = [anchor.x, anchor.y, anchor.z]
        self.start = start; self.end = end; self.sweptDeg = sweptDeg
    }
}

public struct CaptureDevice: Codable, Sendable, Equatable {
    public struct Video: Codable, Sendable, Equatable {
        public var width: Int, height: Int
        public var fps: Double
        public init(width: Int, height: Int, fps: Double) {
            self.width = width; self.height = height; self.fps = fps
        }
    }
    public var model: String
    public var systemVersion: String
    public var appVersion: String
    public var video: Video
    public var exposureLocked: Bool
    public var lidar: Bool
    public var floorY: Float?

    public init(model: String, systemVersion: String, appVersion: String, video: Video,
                exposureLocked: Bool, lidar: Bool, floorY: Float?) {
        self.model = model; self.systemVersion = systemVersion; self.appVersion = appVersion
        self.video = video; self.exposureLocked = exposureLocked; self.lidar = lidar
        self.floorY = floorY
    }

    // floorY is always written (null when unknown) to match the zod schema.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(model, forKey: .model); try c.encode(systemVersion, forKey: .systemVersion)
        try c.encode(appVersion, forKey: .appVersion); try c.encode(video, forKey: .video)
        try c.encode(exposureLocked, forKey: .exposureLocked); try c.encode(lidar, forKey: .lidar)
        try c.encode(floorY, forKey: .floorY)
    }
}

/// Appends pose lines to poses.jsonl on disk as frames are recorded (no RAM growth on long
/// recordings).
public final class PoseLogWriter {
    private let handle: FileHandle
    private let encoder: JSONEncoder
    public private(set) var count = 0

    public init(url: URL) throws {
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    }

    public func append(_ line: PoseLine) throws {
        var data = try encoder.encode(line)
        data.append(0x0A)
        try handle.write(contentsOf: data)
        count += 1
    }

    public func close() throws { try handle.close() }
}
