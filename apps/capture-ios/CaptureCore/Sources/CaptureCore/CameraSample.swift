import Foundation
import simd

/// One tracked camera frame, as the rest of CaptureCore sees it (built from an ARFrame in the
/// app, or synthesised in tests). World space is ARKit's: metres, +y up.
/// Camera axes are ARKit's: +x right, +y up, -z forward, for the *captured image* orientation.
public struct CameraSample: Sendable {
    public var time: Double
    /// Camera-to-world.
    public var transform: simd_float4x4
    public var fx: Float, fy: Float, cx: Float, cy: Float
    public var width: Int, height: Int
    public var tracking: Tracking

    public enum Tracking: String, Sendable, Codable {
        case normal, limited, notAvailable
    }

    public init(time: Double, transform: simd_float4x4, fx: Float, fy: Float, cx: Float, cy: Float,
                width: Int, height: Int, tracking: Tracking = .normal) {
        self.time = time; self.transform = transform
        self.fx = fx; self.fy = fy; self.cx = cx; self.cy = cy
        self.width = width; self.height = height; self.tracking = tracking
    }

    public var position: SIMD3<Float> {
        SIMD3(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
    }

    /// World-space viewing direction (camera -z).
    public var forward: SIMD3<Float> {
        -simd_normalize(SIMD3(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z))
    }

    /// Heading of the view direction in the xz plane, radians in (-pi, pi]; 0 = world -z.
    public var heading: Float {
        let f = forward
        return atan2(f.x, -f.z)
    }

    /// Elevation of the view direction, radians (+ = looking up).
    public var pitch: Float {
        asin(max(-1, min(1, forward.y)))
    }

    /// World-space ray through pixel (u, v) of the captured image (v grows downwards).
    public func ray(u: Float, v: Float) -> (origin: SIMD3<Float>, direction: SIMD3<Float>) {
        let local = SIMD3<Float>((u - cx) / fx, -(v - cy) / fy, -1)
        let r = simd_float3x3(
            SIMD3(transform.columns.0.x, transform.columns.0.y, transform.columns.0.z),
            SIMD3(transform.columns.1.x, transform.columns.1.y, transform.columns.1.z),
            SIMD3(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z))
        return (position, simd_normalize(r * local))
    }
}

public extension simd_float4x4 {
    /// Camera-to-world pose at `position`, turned `heading` radians (0 = looking at world -z,
    /// positive turns towards +x) and tilted `pitch` radians up. Handy for tests and previews.
    static func camera(at position: SIMD3<Float>, heading: Float, pitch: Float = 0) -> simd_float4x4 {
        let yaw = simd_quatf(angle: -heading, axis: SIMD3(0, 1, 0))
        let tilt = simd_quatf(angle: pitch, axis: SIMD3(1, 0, 0))
        var m = simd_float4x4(yaw * tilt)
        m.columns.3 = SIMD4(position, 1)
        return m
    }

    /// Column-major floats, the layout of `transform` in poses.jsonl.
    var columnMajor: [Float] {
        [columns.0, columns.1, columns.2, columns.3].flatMap { [$0.x, $0.y, $0.z, $0.w] }
    }
}
