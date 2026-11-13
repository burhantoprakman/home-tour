import ARKit
import CaptureCore
import SceneKit
import simd

/// What the overlay shows, published to the main thread ~10x a second.
struct LiveStatus {
    var trackingMessage: String?
    var showSlowDown = false
    var turnDegPerSec: Float = 0
    var metresPerSec: Float = 0
    var elapsed: TimeInterval = 0
    var floorFraction: Float = 0
    var wallFraction: Float = 0
    var looksComplete = false
    var floorFound = false
    var stepProgress: [GuidedSteps.Step: Float] = [:]
    var currentStep: GuidedSteps.Step? = .chestLoop
    var orbitFraction: Float?
    var orbitCount = 0
    var map = MapSnapshot()
}

struct MapSnapshot {
    var known: [CoverageMap.Cell] = []
    var seen: Set<CoverageMap.Cell> = []
    var path: [SIMD2<Float>] = []
    var camera = SIMD2<Float>(0, 0)
    var heading: Float = 0
}

/// Owns the AR session for the whole capture (both passes share one world frame, so the
/// details video is posed in the same coordinates as the room video). All AR state lives on
/// `queue`; the UI only gets LiveStatus snapshots.
final class CaptureController: NSObject, ARSessionDelegate {
    let view = ARSCNView(frame: .zero)
    var onStatus: ((LiveStatus) -> Void)?

    private let queue = DispatchQueue(label: "capture.ar", qos: .userInteractive)
    private(set) var videoFormat: ARConfiguration.VideoFormat?
    private(set) var exposureLocked = false

    // Everything below is touched on `queue` only.
    private var speed = SpeedDetector()
    private var coverage = CoverageMap()
    private var steps = GuidedSteps()
    private var floorPlanes: [UUID: (y: Float, area: Float)] = [:]
    private var voxels = Set<SIMD3<Int32>>()
    private var voxelPoints: [SIMD3<Float>] = []
    private var recorder: VideoRecorder?
    private var poseLog: PoseLogWriter?
    private var pass: CapturePass = .room
    private var orbit: OrbitMeter?
    private var orbitId: Int?
    private var orbitStart: Double = 0
    private(set) var objects: [CaptureObject] = []
    private var frameCount = 0
    private var lastStatus: TimeInterval = 0
    private var lastOverlay: TimeInterval = 0
    private var lastSample: CameraSample?
    private var sessionStart: TimeInterval?

    private let dotsNode = SCNNode()
    private let shadeNode = SCNNode()

    override init() {
        super.init()
        view.automaticallyUpdatesLighting = false
        view.rendersCameraGrain = false
        view.scene.rootNode.addChildNode(shadeNode)
        view.scene.rootNode.addChildNode(dotsNode)
        view.session.delegate = self
        view.session.delegateQueue = queue
    }

    // MARK: session

    func start() {
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity
        config.planeDetection = [.horizontal, .vertical]
        config.isAutoFocusEnabled = true
        // ~1920x1440 @ 30 fps: the pipeline downsizes frames to 1600 px, so 4K only costs upload.
        let formats = ARWorldTrackingConfiguration.supportedVideoFormats
            .filter { $0.framesPerSecond == 30 && $0.imageResolution.width <= 1920 }
            .sorted { $0.imageResolution.width * $0.imageResolution.height > $1.imageResolution.width * $1.imageResolution.height }
        if let f = formats.first { config.videoFormat = f }
        if config.videoFormat.isVideoHDRSupported { config.videoHDRAllowed = false }
        videoFormat = config.videoFormat
        view.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        // Meter for 2 s, then lock exposure + white balance so colours match across the room.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.lockExposure() }
    }

    func stop() { view.session.pause() }

    private func lockExposure() {
        guard let device = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera,
              (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }
        // Cap the shutter at 1/60 s (motion blur), raising ISO to keep the same brightness.
        let maxDuration = CMTime(value: 1, timescale: 60)
        let current = device.exposureDuration
        if current.seconds > maxDuration.seconds, device.isExposureModeSupported(.custom) {
            let gain = Float(current.seconds / maxDuration.seconds)
            let iso = min(device.activeFormat.maxISO, max(device.activeFormat.minISO, device.iso * gain))
            device.setExposureModeCustom(duration: maxDuration, iso: iso)
        } else if device.isExposureModeSupported(.locked) {
            device.exposureMode = .locked
        }
        if device.isWhiteBalanceModeSupported(.locked) { device.whiteBalanceMode = .locked }
        exposureLocked = true
    }

    // MARK: recording

    func startPass(_ pass: CapturePass, video: URL, poses: URL) {
        queue.async { [self] in
            guard let f = videoFormat else { return }
            do {
                recorder = try VideoRecorder(url: video, width: Int(f.imageResolution.width),
                                             height: Int(f.imageResolution.height), fps: Double(f.framesPerSecond))
                if poseLog == nil { poseLog = try PoseLogWriter(url: poses) }
            } catch {
                print("recorder failed: \(error)")
            }
            self.pass = pass
            speed.reset()
        }
    }

    /// Stops the current pass's video; returns its duration.
    func stopPass() async throws -> TimeInterval {
        let rec: VideoRecorder? = await withCheckedContinuation { c in
            queue.async { [self] in
                if orbitId != nil { endObjectLocked() }
                let r = recorder; recorder = nil; c.resume(returning: r)
            }
        }
        guard let rec else { return 0 }
        try await rec.finish()
        return rec.duration
    }

    func closeLog() {
        queue.sync { try? poseLog?.close(); poseLog = nil }
    }

    var floorY: Float? { queue.sync { coverage.floorY } }

    /// Details pass: anchor an orbit on whatever is at the centre of the screen.
    func startObject() {
        queue.async { [self] in
            guard let frame = view.session.currentFrame, let rec = recorder, let start = rec.startTime else { return }
            let query = frame.raycastQuery(from: CGPoint(x: 0.5, y: 0.5), allowing: .estimatedPlane, alignment: .any)
            let anchor: SIMD3<Float>
            if let hit = view.session.raycast(query).first {
                let c = hit.worldTransform.columns.3
                anchor = SIMD3(c.x, c.y, c.z)
            } else {  // nothing found: assume the object is ~1 m ahead
                let s = sample(frame)
                anchor = s.position + s.forward
            }
            orbit = OrbitMeter(anchor: anchor)
            orbitId = objects.count
            orbitStart = frame.timestamp - start
        }
    }

    func endObject() { queue.async { [self] in endObjectLocked() } }

    private func endObjectLocked() {
        guard let o = orbit, let id = orbitId, let start = recorder?.startTime,
              let now = view.session.currentFrame?.timestamp else { return }
        objects.append(CaptureObject(id: id, anchor: o.anchor, start: orbitStart, end: now - start,
                                     sweptDeg: o.sweptDegrees))
        orbit = nil; orbitId = nil
    }

    // MARK: ARSessionDelegate (on `queue`)

    private func sample(_ frame: ARFrame) -> CameraSample {
        let cam = frame.camera
        let k = cam.intrinsics
        let tracking: CameraSample.Tracking
        switch cam.trackingState {
        case .normal: tracking = .normal
        case .limited: tracking = .limited
        case .notAvailable: tracking = .notAvailable
        }
        return CameraSample(time: frame.timestamp, transform: cam.transform,
                            fx: k[0][0], fy: k[1][1], cx: k[2][0], cy: k[2][1],
                            width: Int(cam.imageResolution.width), height: Int(cam.imageResolution.height),
                            tracking: tracking)
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let s = sample(frame)
        if sessionStart == nil { sessionStart = frame.timestamp }
        var reason: String?
        var excessive = false
        if case .limited(let r) = frame.camera.trackingState {
            switch r {
            case .excessiveMotion: reason = "excessiveMotion"; excessive = true
            case .insufficientFeatures: reason = "insufficientFeatures"
            case .initializing: reason = "initializing"
            case .relocalizing: reason = "relocalizing"
            @unknown default: reason = "other"
            }
        }
        let reading = speed.update(s, excessiveMotion: excessive)
        let slow = !reading.fast && s.tracking == .normal

        if let rec = recorder, let (index, t) = rec.append(frame.capturedImage, timestamp: frame.timestamp) {
            try? poseLog?.append(PoseLine(pass: pass, frame: index, t: t, sample: s,
                                          trackingReason: reason, fast: reading.fast, objectId: orbitId))
        }
        frameCount += 1
        if slow {
            if pass == .room || recorder == nil {
                coverage.observe(s)
                steps.observe(s, floorY: coverage.floorY)
            }
            orbit?.observe(cameraPosition: s.position)
            if frameCount % 6 == 0, let pts = frame.rawFeaturePoints?.points { addPoints(pts) }
        }
        lastSample = s

        if frame.timestamp - lastStatus >= 0.1 {
            lastStatus = frame.timestamp
            publish(reading: reading, sample: s, frame: frame, withMap: Int(frame.timestamp * 10) % 5 == 0)
        }
        if frame.timestamp - lastOverlay >= 1 {
            lastOverlay = frame.timestamp
            rebuildOverlay()
        }
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { updatePlanes(anchors) }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { updatePlanes(anchors) }
    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        for a in anchors {
            coverage.removePlane(id: a.identifier.uuidString)
            floorPlanes[a.identifier] = nil
        }
        refreshFloorY()
    }

    private func updatePlanes(_ anchors: [ARAnchor]) {
        let camY = lastSample?.position.y
        for case let p as ARPlaneAnchor in anchors {
            let id = p.identifier.uuidString
            let m = p.transform
            let world = { (v: SIMD3<Float>) -> SIMD3<Float> in
                let w = m * SIMD4(v, 1); return SIMD3(w.x, w.y, w.z)
            }
            if p.alignment == .horizontal {
                let y = m.columns.3.y
                let isFloor = ARPlaneAnchor.isClassificationSupported
                    ? p.classification == .floor
                    : camY.map { y < $0 - 0.7 } ?? false
                guard isFloor else { continue }
                coverage.setFloorExtent(id: id, corners: p.geometry.boundaryVertices.map(world))
                floorPlanes[p.identifier] = (y, p.planeExtent.width * p.planeExtent.height)
                refreshFloorY()
            } else {
                // Plane local x/z, rotated by rotationOnYAxis; one is horizontal, one vertical.
                let e = p.planeExtent
                let rot = simd_float4x4(simd_quatf(angle: e.rotationOnYAxis, axis: SIMD3(0, 1, 0)))
                let full = m * rot
                let ax = simd_normalize(SIMD3(full.columns.0.x, full.columns.0.y, full.columns.0.z))
                let az = simd_normalize(SIMD3(full.columns.2.x, full.columns.2.y, full.columns.2.z))
                let centre = world(p.center)
                let (right, width, up, height): (SIMD3<Float>, Float, SIMD3<Float>, Float) =
                    abs(ax.y) < abs(az.y) ? (ax, e.width, az, e.height) : (az, e.height, ax, e.width)
                guard abs(up.y) > 0.9, width >= 0.5 else { continue }  // skip tilted / furniture sides
                let r = simd_normalize(SIMD3(right.x, 0, right.z))
                let origin = centre - r * width / 2 - SIMD3(0, height / 2, 0)
                coverage.setWall(id: id, .init(origin: origin, right: r, width: width, height: height))
            }
        }
    }

    private func refreshFloorY() {
        if let biggest = floorPlanes.values.max(by: { $0.area < $1.area }) {
            coverage.setFloor(y: biggest.y)
        }
    }

    private func addPoints(_ pts: [SIMD3<Float>]) {
        guard voxels.count < 120_000 else { return }
        for p in pts {
            let key = SIMD3<Int32>(Int32((p.x / 0.04).rounded(.down)), Int32((p.y / 0.04).rounded(.down)),
                                   Int32((p.z / 0.04).rounded(.down)))
            if voxels.insert(key).inserted { voxelPoints.append(p) }
        }
    }

    private func publish(reading: SpeedDetector.Reading, sample s: CameraSample, frame: ARFrame, withMap: Bool) {
        var st = LiveStatus()
        st.showSlowDown = reading.showBanner && recorder != nil
        st.turnDegPerSec = reading.turnDegPerSec
        st.metresPerSec = reading.metresPerSec
        if case .limited(let r) = frame.camera.trackingState {
            switch r {
            case .initializing: st.trackingMessage = "Starting up: move the phone slowly side to side"
            case .insufficientFeatures: st.trackingMessage = "Not enough detail here: point at furniture, not a blank wall"
            case .relocalizing: st.trackingMessage = "Finding your place again: point back where you were"
            default: break
            }
        } else if case .notAvailable = frame.camera.trackingState {
            st.trackingMessage = "Tracking lost"
        }
        if let rec = recorder, let start = rec.startTime { st.elapsed = frame.timestamp - start }
        st.floorFound = coverage.floorY != nil
        st.floorFraction = coverage.floorFraction
        st.wallFraction = coverage.wallFraction
        st.looksComplete = coverage.looksComplete && steps.current == nil
        for step in GuidedSteps.Step.allCases { st.stepProgress[step] = steps.progress(step) }
        st.currentStep = steps.current
        st.orbitFraction = orbit?.fraction
        st.orbitCount = objects.count
        if withMap {
            st.map = MapSnapshot(known: Array(coverage.knownFloor), seen: coverage.seenFloor,
                                 path: coverage.path, camera: SIMD2(s.position.x, s.position.z), heading: s.heading)
        } else {
            st.map.camera = SIMD2(s.position.x, s.position.z); st.map.heading = s.heading
        }
        let cb = onStatus
        DispatchQueue.main.async { cb?(st) }
    }

    // MARK: overlay: feature dots + dark shading over not-yet-filmed floor and wall cells

    private func rebuildOverlay() {
        let dots = Overlay.points(voxelPoints.suffix(60_000))
        var quads: [Overlay.Quad] = []
        if let fy = coverage.floorY {
            let c = CoverageMap.floorCell
            for cell in coverage.knownFloor where !coverage.seenFloor.contains(cell) {
                let x = Float(cell.x) * c, z = Float(cell.z) * c, y = fy + 0.01
                quads.append(.init(SIMD3(x, y, z), SIMD3(x + c, y, z), SIMD3(x + c, y, z + c), SIMD3(x, y, z + c)))
            }
        }
        for (id, w) in coverage.walls {
            let seen = coverage.seenWalls[id] ?? []
            let c = CoverageMap.wallCell
            for col in 0..<w.columns {
                for row in 0..<w.rows where !seen.contains(.init(col: col, row: row)) {
                    let a = min(Float(col) * c, w.width), b = min(Float(col + 1) * c, w.width)
                    let lo = min(Float(row) * c, w.height), hi = min(Float(row + 1) * c, w.height)
                    let p = { (u: Float, v: Float) in w.origin + w.right * u + SIMD3(0, v, 0) }
                    quads.append(.init(p(a, lo), p(b, lo), p(b, hi), p(a, hi)))
                }
            }
        }
        let shade = Overlay.quads(quads)
        DispatchQueue.main.async { [dotsNode, shadeNode] in
            dotsNode.geometry = dots
            shadeNode.geometry = shade
        }
    }
}

enum Overlay {
    struct Quad {
        var a, b, c, d: SIMD3<Float>
        init(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>, _ d: SIMD3<Float>) {
            self.a = a; self.b = b; self.c = c; self.d = d
        }
    }

    static func points<S: Collection>(_ pts: S) -> SCNGeometry? where S.Element == SIMD3<Float> {
        guard !pts.isEmpty else { return nil }
        let verts = pts.map { SCNVector3($0.x, $0.y, $0.z) }
        let src = SCNGeometrySource(vertices: verts)
        let idx = (0..<Int32(verts.count)).map { $0 }
        let el = SCNGeometryElement(indices: idx, primitiveType: .point)
        el.pointSize = 5
        el.minimumPointScreenSpaceRadius = 1.5
        el.maximumPointScreenSpaceRadius = 3
        let g = SCNGeometry(sources: [src], elements: [el])
        let m = SCNMaterial()
        m.diffuse.contents = UIColor(red: 0.35, green: 0.95, blue: 0.75, alpha: 0.9)
        m.lightingModel = .constant
        g.materials = [m]
        return g
    }

    static func quads(_ quads: [Quad]) -> SCNGeometry? {
        guard !quads.isEmpty else { return nil }
        var verts: [SCNVector3] = []
        var idx: [Int32] = []
        verts.reserveCapacity(quads.count * 4)
        for q in quads {
            let base = Int32(verts.count)
            verts += [q.a, q.b, q.c, q.d].map { SCNVector3($0.x, $0.y, $0.z) }
            idx += [base, base + 1, base + 2, base, base + 2, base + 3]
        }
        let g = SCNGeometry(sources: [SCNGeometrySource(vertices: verts)],
                            elements: [SCNGeometryElement(indices: idx, primitiveType: .triangles)])
        let m = SCNMaterial()
        m.diffuse.contents = UIColor(white: 0, alpha: 0.45)
        m.lightingModel = .constant
        m.isDoubleSided = true
        m.writesToDepthBuffer = false
        g.materials = [m]
        return g
    }
}
