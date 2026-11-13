import Foundation
import simd

/// Decides when the owner is moving too fast for sharp, well-overlapping frames.
/// Fast = ARKit reports excessive motion, or the smoothed turn rate / walking speed is above
/// the limits. The banner stays up for `holdSeconds` after the last fast sample so it doesn't
/// flicker.
public struct SpeedDetector: Sendable {
    public struct Limits: Sendable {
        /// Turn rate limit, degrees per second.
        public var maxTurnDegPerSec: Float = 45
        /// Walking speed limit, metres per second.
        public var maxMetresPerSec: Float = 0.6
        /// Smoothing time constant, seconds.
        public var smoothing: Double = 0.25
        public var holdSeconds: Double = 0.7
        public init() {}
    }

    public struct Reading: Sendable, Equatable {
        public var turnDegPerSec: Float
        public var metresPerSec: Float
        /// This sample is too fast (don't count it toward coverage).
        public var fast: Bool
        /// Show the "Slow down" banner (fast now or very recently).
        public var showBanner: Bool
    }

    public var limits: Limits
    private var last: CameraSample?
    private var turn: Float = 0
    private var speed: Float = 0
    private var lastFastTime: Double = -.infinity

    public init(limits: Limits = Limits()) { self.limits = limits }

    public mutating func reset() {
        last = nil; turn = 0; speed = 0; lastFastTime = -.infinity
    }

    public mutating func update(_ s: CameraSample, excessiveMotion: Bool = false) -> Reading {
        defer { last = s }
        if let p = last, s.time > p.time {
            let dt = Float(s.time - p.time)
            let rel = simd_quatf(p.transform).inverse * simd_quatf(s.transform)
            var angle = rel.angle  // 0...2pi
            if angle > .pi { angle = 2 * .pi - angle }
            let instTurn = angle * 180 / .pi / dt
            let instSpeed = simd_distance(p.position, s.position) / dt
            let a = Float(1 - exp(-Double(dt) / limits.smoothing))
            turn += a * (instTurn - turn)
            speed += a * (instSpeed - speed)
        }
        let fast = excessiveMotion
            || turn > limits.maxTurnDegPerSec || speed > limits.maxMetresPerSec
        if fast { lastFastTime = s.time }
        return Reading(turnDegPerSec: turn, metresPerSec: speed, fast: fast,
                       showBanner: s.time - lastFastTime <= limits.holdSeconds)
    }
}
