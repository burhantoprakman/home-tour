import Foundation
import simd

/// What has been filmed well so far: floor cells (25 cm) and wall cells (50 cm).
/// - The floor's extent comes from ARKit's horizontal floor planes; a floor cell is "seen" when a
///   slow, well-tracked frame looks at it from within `maxDistance`.
/// - Walls come from ARKit's vertical planes; a wall cell is "seen" once it was filmed from two
///   viewpoints at least `minBaseline` apart (one view can't triangulate it).
/// Only the nearest surface along each sample ray counts, so a wall hides the floor behind it.
public struct CoverageMap: Sendable {
    public struct Cell: Hashable, Sendable {
        public var x: Int32, z: Int32
        public init(x: Int32, z: Int32) { self.x = x; self.z = z }
    }
    public struct WallCell: Hashable, Sendable {
        public var col: Int32, row: Int32
        public init(col: Int32, row: Int32) { self.col = col; self.row = row }
    }

    public struct Wall: Sendable {
        /// Bottom-left corner (world), horizontal unit axis along the wall, size in metres.
        public var origin: SIMD3<Float>
        public var right: SIMD3<Float>
        public var width: Float
        public var height: Float
        public var normal: SIMD3<Float> { simd_normalize(simd_cross(right, SIMD3(0, 1, 0))) }
        public var columns: Int32 { max(1, Int32((width / CoverageMap.wallCell).rounded(.up))) }
        public var rows: Int32 { max(1, Int32((height / CoverageMap.wallCell).rounded(.up))) }
        public init(origin: SIMD3<Float>, right: SIMD3<Float>, width: Float, height: Float) {
            self.origin = origin; self.right = simd_normalize(right)
            self.width = width; self.height = height
        }
    }

    public static let floorCell: Float = 0.25
    public static let wallCell: Float = 0.5
    public var maxDistance: Float = 4
    public var minBaseline: Float = 0.4
    /// Rays per frame (columns x rows of the image).
    public var raysX = 10, raysY = 8

    public private(set) var floorY: Float?
    public private(set) var seenFloor = Set<Cell>()
    private var floorExtents: [String: Set<Cell>] = [:]
    public private(set) var knownFloor = Set<Cell>()
    public private(set) var walls: [String: Wall] = [:]
    /// First viewpoint per wall cell, and cells seen from two distinct viewpoints.
    private var firstView: [String: [WallCell: SIMD3<Float>]] = [:]
    public private(set) var seenWalls: [String: Set<WallCell>] = [:]
    /// Camera path on the floor (x, z), one point per 10 cm moved.
    public private(set) var path: [SIMD2<Float>] = []

    public init() {}

    public static func cell(_ p: SIMD3<Float>) -> Cell {
        Cell(x: Int32((p.x / floorCell).rounded(.down)), z: Int32((p.z / floorCell).rounded(.down)))
    }

    public mutating func setFloor(y: Float) { floorY = y }

    /// A horizontal floor plane's outline (world-space corners, any convex polygon).
    public mutating func setFloorExtent(id: String, corners: [SIMD3<Float>]) {
        guard corners.count >= 3 else { return }
        let xs = corners.map(\.x), zs = corners.map(\.z)
        let c = Self.floorCell
        var cells = Set<Cell>()
        var x = (xs.min()! / c).rounded(.down) * c
        while x < xs.max()! {
            var z = (zs.min()! / c).rounded(.down) * c
            while z < zs.max()! {
                let centre = SIMD2(x + c / 2, z + c / 2)
                if Self.inside(centre, corners.map { SIMD2($0.x, $0.z) }) {
                    cells.insert(Cell(x: Int32((x / c).rounded()), z: Int32((z / c).rounded())))
                }
                z += c
            }
            x += c
        }
        floorExtents[id] = cells
        knownFloor = floorExtents.values.reduce(into: Set<Cell>()) { $0.formUnion($1) }
    }

    public mutating func setWall(id: String, _ wall: Wall) {
        walls[id] = wall
        // A plane that shrank keeps only cells still on it.
        seenWalls[id] = seenWalls[id]?.filter { $0.col < wall.columns && $0.row < wall.rows }
    }

    public mutating func removePlane(id: String) {
        walls[id] = nil; seenWalls[id] = nil; firstView[id] = nil
        if floorExtents.removeValue(forKey: id) != nil {
            knownFloor = floorExtents.values.reduce(into: Set<Cell>()) { $0.formUnion($1) }
        }
    }

    /// Add a slow, well-tracked frame. Call only for frames that were not flagged fast.
    public mutating func observe(_ s: CameraSample) {
        guard s.tracking == .normal else { return }
        let p = s.position
        if let last = path.last {
            if simd_distance(last, SIMD2(p.x, p.z)) >= 0.1 { path.append(SIMD2(p.x, p.z)) }
        } else {
            path.append(SIMD2(p.x, p.z))
        }
        for i in 0..<raysX {
            for j in 0..<raysY {
                let u = (Float(i) + 0.5) / Float(raysX) * Float(s.width)
                let v = (Float(j) + 0.5) / Float(raysY) * Float(s.height)
                cast(s.ray(u: u, v: v))
            }
        }
    }

    private mutating func cast(_ ray: (origin: SIMD3<Float>, direction: SIMD3<Float>)) {
        let (o, d) = ray
        var best = Float.infinity
        var hitFloor: Cell?
        var hitWall: (String, WallCell)?
        if let fy = floorY, d.y < -0.05 {
            let t = (fy - o.y) / d.y
            if t > 0, t < best {
                let h = o + t * d
                if simd_length(SIMD2(h.x - o.x, h.z - o.z)) <= maxDistance {
                    best = t; hitFloor = Self.cell(h)
                }
            }
        }
        for (id, w) in walls {
            let n = w.normal
            let denom = simd_dot(d, n)
            guard abs(denom) > 1e-3 else { continue }
            let t = simd_dot(w.origin - o, n) / denom
            guard t > 0, t < best, t <= maxDistance + 1 else { continue }
            let local = o + t * d - w.origin
            let a = simd_dot(local, w.right), b = local.y
            guard a >= 0, a < w.width, b >= 0, b < w.height else { continue }
            best = t; hitFloor = nil
            hitWall = (id, WallCell(col: Int32(a / Self.wallCell), row: Int32(b / Self.wallCell)))
        }
        if let c = hitFloor { seenFloor.insert(c) }
        if let (id, c) = hitWall {
            if seenWalls[id]?.contains(c) == true { return }
            if let first = firstView[id]?[c] {
                if simd_distance(first, o) >= minBaseline { seenWalls[id, default: []].insert(c) }
            } else {
                firstView[id, default: [:]][c] = o
            }
        }
    }

    public var floorFraction: Float {
        knownFloor.isEmpty ? 0 : Float(seenFloor.intersection(knownFloor).count) / Float(knownFloor.count)
    }

    public var wallFraction: Float {
        let total = walls.values.reduce(0) { $0 + Int($1.columns * $1.rows) }
        let seen = seenWalls.values.reduce(0) { $0 + $1.count }
        return total == 0 ? 0 : Float(seen) / Float(total)
    }

    /// Enough of the room is filmed to suggest stopping (recording never stops by itself).
    public var looksComplete: Bool {
        knownFloor.count >= 16 && floorFraction >= 0.9 && wallFraction >= 0.8
    }

    static func inside(_ p: SIMD2<Float>, _ poly: [SIMD2<Float>]) -> Bool {
        var inside = false
        var j = poly.count - 1
        for i in 0..<poly.count {
            let a = poly[i], b = poly[j]
            if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
                inside.toggle()
            }
            j = i
        }
        return inside
    }
}
