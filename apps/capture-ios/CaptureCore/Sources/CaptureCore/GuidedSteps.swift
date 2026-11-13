import Foundation
import simd

/// The room pass, step by step. Each step ticks when enough viewing directions (24 heading bins
/// of 15°) were filmed slowly in its height / tilt band:
///   1. chest loop: phone ≥ 1.1 m above the floor, roughly level, 20 of 24 directions
///   2. low loop:   phone ≤ 1.0 m above the floor, 20 of 24 directions
///   3. ceiling:    tilted ≥ 25° up, 12 of 24 directions (corners + edges)
/// Steps tick independently, so doing them in another order still counts.
public struct GuidedSteps: Sendable {
    public enum Step: Int, CaseIterable, Sendable {
        case chestLoop, lowLoop, ceiling

        public var title: String {
            switch self {
            case .chestLoop: "Loop 1: chest height"
            case .lowLoop: "Loop 2: lower"
            case .ceiling: "Ceiling corners"
            }
        }

        public var instruction: String {
            switch self {
            case .chestLoop:
                "Walk slowly along the walls with the phone at chest height, pointing into the room."
            case .lowLoop:
                "Hold the phone at waist height and do a second slow loop a little closer to the middle."
            case .ceiling:
                "Tilt the phone up and slowly sweep the ceiling edges and corners."
            }
        }

        var needed: Int { self == .ceiling ? 12 : 20 }
    }

    public static let bins = 24
    public var chestMinHeight: Float = 1.1
    public var lowMaxHeight: Float = 1.0
    public var levelMaxPitch: Float = 35 * .pi / 180
    public var ceilingMinPitch: Float = 25 * .pi / 180

    private var filled: [Step: Set<Int>] = [:]

    public init() {}

    /// Add a slow frame. `floorY` is the floor height if known.
    public mutating func observe(_ s: CameraSample, floorY: Float?) {
        guard s.tracking == .normal else { return }
        let bin = Self.bin(s.heading)
        let pitch = s.pitch
        if pitch >= ceilingMinPitch { filled[.ceiling, default: []].insert(bin) }
        guard let floorY, abs(pitch) <= levelMaxPitch else { return }
        let h = s.position.y - floorY
        if h >= chestMinHeight { filled[.chestLoop, default: []].insert(bin) }
        if h <= lowMaxHeight, h >= 0.2 { filled[.lowLoop, default: []].insert(bin) }
    }

    public static func bin(_ heading: Float) -> Int {
        let a = (heading + .pi) / (2 * .pi)  // 0...1
        return min(bins - 1, max(0, Int(a * Float(bins))))
    }

    public func progress(_ step: Step) -> Float {
        min(1, Float(filled[step]?.count ?? 0) / Float(step.needed))
    }

    public func isDone(_ step: Step) -> Bool { progress(step) >= 1 }

    /// Heading bins filled for a step (for the direction ring around the step card).
    public func filledBins(_ step: Step) -> Set<Int> { filled[step] ?? [] }

    /// The step to show: the first not done, nil when all are done.
    public var current: Step? { Step.allCases.first { !isDone($0) } }
}

/// Details pass: how far the owner has circled the object they are filming.
public struct OrbitMeter: Sendable {
    public let anchor: SIMD3<Float>
    public var fullDegrees: Float = 120
    private var lastAzimuth: Float?
    private var unwrapped: Float = 0
    private var low: Float = 0, high: Float = 0

    public init(anchor: SIMD3<Float>) { self.anchor = anchor }

    public mutating func observe(cameraPosition p: SIMD3<Float>) {
        let az = atan2(p.x - anchor.x, p.z - anchor.z)
        if let last = lastAzimuth {
            var d = az - last
            if d > .pi { d -= 2 * .pi }
            if d < -.pi { d += 2 * .pi }
            unwrapped += d
            low = min(low, unwrapped); high = max(high, unwrapped)
        }
        lastAzimuth = az
    }

    public var sweptDegrees: Float { (high - low) * 180 / .pi }
    public var fraction: Float { min(1, sweptDegrees / fullDegrees) }
}
