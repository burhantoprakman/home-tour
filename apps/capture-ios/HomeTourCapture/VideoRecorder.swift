import AVFoundation
import CoreVideo

/// Writes ARKit's captured frames (sensor orientation, SDR) to a HEVC .mov on disk as they
/// arrive, so recordings of any length don't grow memory. Presentation times are seconds since
/// the first frame, which is also `t` in poses.jsonl; the worker matches frames by that time.
final class VideoRecorder {
    let url: URL
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private(set) var startTime: TimeInterval?
    private(set) var frames = 0
    private var lastTime: TimeInterval = -1

    init(url: URL, width: Int, height: Int, fps: Double) throws {
        self.url = url
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.hevc,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 14_000_000,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: Int(fps),
            ],
        ])
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
    }

    /// Appends one frame; returns (frame index, seconds since start), or nil if the encoder was
    /// busy and the frame was dropped (its pose must then not be logged either).
    func append(_ buffer: CVPixelBuffer, timestamp: TimeInterval) -> (index: Int, t: Double)? {
        if startTime == nil {
            writer.startSession(atSourceTime: .zero)
            startTime = timestamp
        }
        let t = timestamp - startTime!
        guard t > lastTime, input.isReadyForMoreMediaData else { return nil }
        guard adaptor.append(buffer, withPresentationTime: CMTime(seconds: t, preferredTimescale: 600)) else {
            return nil
        }
        lastTime = t
        defer { frames += 1 }
        return (frames, t)
    }

    var duration: TimeInterval { max(0, lastTime) }

    func finish() async throws {
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? CocoaError(.fileWriteUnknown) }
    }
}
