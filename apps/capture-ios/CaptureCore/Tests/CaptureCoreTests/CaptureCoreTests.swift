import Foundation
import simd
import Testing
@testable import CaptureCore

private func sample(_ t: Double, at p: SIMD3<Float>, heading: Float, pitch: Float = 0) -> CameraSample {
    CameraSample(time: t, transform: .camera(at: p, heading: heading, pitch: pitch),
                 fx: 1400, fy: 1400, cx: 960, cy: 720, width: 1920, height: 1440)
}

@Suite struct CameraSampleTests {
    @Test func headingAndPitchRoundTrip() {
        let s = sample(0, at: .zero, heading: 0.7, pitch: 0.3)
        #expect(abs(s.heading - 0.7) < 1e-4)
        #expect(abs(s.pitch - 0.3) < 1e-4)
    }

    @Test func centreRayIsForward() {
        let s = sample(0, at: SIMD3(1, 1.4, 2), heading: .pi / 2)
        let r = s.ray(u: 960, v: 720)
        #expect(simd_distance(r.direction, SIMD3(1, 0, 0)) < 1e-4)
        // Lower image half looks down.
        #expect(s.ray(u: 960, v: 1400).direction.y < 0)
    }
}

@Suite struct SpeedTests {
    @Test func slowWalkIsFine() {
        var d = SpeedDetector()
        var last: SpeedDetector.Reading?
        for i in 0..<90 {  // 3 s, 0.3 m/s, 10°/s
            let t = Double(i) / 30
            last = d.update(sample(t, at: SIMD3(Float(t) * 0.3, 1.4, 0), heading: Float(t) * 10 * .pi / 180))
        }
        #expect(last?.fast == false)
        #expect(last?.showBanner == false)
    }

    @Test func fastTurnTriggersAndBannerHolds() {
        var d = SpeedDetector()
        var r = d.update(sample(0, at: .zero, heading: 0))
        for i in 1...15 {  // 90°/s for 0.5 s
            r = d.update(sample(Double(i) / 30, at: .zero, heading: Float(i) / 30 * .pi / 2))
        }
        #expect(r.fast)
        // Stop turning: fast clears once the smoothed rate decays, banner lingers briefly.
        var t = 0.5
        var cleared: Double?
        while t < 3 {
            t += 1.0 / 30
            r = d.update(sample(t, at: .zero, heading: .pi / 4))
            if !r.showBanner, cleared == nil { cleared = t }
        }
        #expect(cleared != nil)
        #expect(cleared! > 0.5 + 0.7)
    }

    @Test func excessiveMotionFromARKitCounts() {
        var d = SpeedDetector()
        #expect(d.update(sample(0, at: .zero, heading: 0), excessiveMotion: true).fast)
    }
}

@Suite struct CoverageTests {
    func room() -> CoverageMap {
        var m = CoverageMap()
        m.setFloor(y: 0)
        // 4 x 3 m floor, walls on the -z and +x sides.
        m.setFloorExtent(id: "floor", corners: [SIMD3(-2, 0, -1.5), SIMD3(2, 0, -1.5), SIMD3(2, 0, 1.5), SIMD3(-2, 0, 1.5)])
        m.setWall(id: "north", .init(origin: SIMD3(-2, 0, -1.5), right: SIMD3(1, 0, 0), width: 4, height: 2.5))
        return m
    }

    @Test func floorExtentCells() {
        let m = room()
        #expect(m.knownFloor.count == 16 * 12)
        #expect(m.floorFraction == 0)
    }

    @Test func lookingAroundFillsFloorAndWallNeedsTwoViews() {
        var m = room()
        m.observe(sample(0, at: SIMD3(0, 1.4, 1), heading: 0, pitch: -0.3))
        #expect(m.floorFraction > 0)
        #expect(m.wallFraction == 0)  // one viewpoint only
        m.observe(sample(1, at: SIMD3(0.6, 1.4, 1), heading: 0, pitch: -0.3))
        #expect(m.wallFraction > 0)
    }

    @Test func fullSweepLooksComplete() {
        var m = room()
        m.raysX = 24; m.raysY = 18
        var t = 0.0
        for x in stride(from: Float(-1.5), through: 1.5, by: 0.5) {
            for z in stride(from: Float(-1), through: 1, by: 0.5) {
                for h in stride(from: Float(0), to: 2 * .pi, by: .pi / 6) {
                    for p: Float in [-0.8, -0.2, 0.3] {
                        m.observe(sample(t, at: SIMD3(x, 1.3, z), heading: h, pitch: p)); t += 0.1
                    }
                }
            }
        }
        #expect(m.floorFraction >= 0.9)
        #expect(m.wallFraction >= 0.8)
        #expect(m.looksComplete)
    }

    @Test func limitedTrackingIsIgnored() {
        var m = room()
        var s = sample(0, at: SIMD3(0, 1.4, 1), heading: 0, pitch: -0.4)
        s.tracking = .limited
        m.observe(s)
        #expect(m.seenFloor.isEmpty)
    }

    @Test func pathIsDecimated() {
        var m = room()
        for i in 0..<100 { m.observe(sample(Double(i), at: SIMD3(Float(i) * 0.01, 1.4, 0), heading: 0)) }
        #expect(m.path.count == 10)
    }
}

@Suite struct GuidedStepTests {
    @Test func stepsTickByHeightAndTilt() {
        var g = GuidedSteps()
        #expect(g.current == .chestLoop)
        for i in 0..<48 {
            let h = Float(i) / 48 * 2 * .pi - .pi
            g.observe(sample(0, at: SIMD3(0, 1.3, 0), heading: h), floorY: 0)
        }
        #expect(g.isDone(.chestLoop))
        #expect(g.current == .lowLoop)
        for i in 0..<48 {
            let h = Float(i) / 48 * 2 * .pi - .pi
            g.observe(sample(0, at: SIMD3(0, 0.8, 0), heading: h), floorY: 0)
            g.observe(sample(0, at: SIMD3(0, 1.3, 0), heading: h, pitch: 0.6), floorY: 0)
        }
        #expect(g.current == nil)
    }

    @Test func withoutFloorOnlyCeilingCounts() {
        var g = GuidedSteps()
        g.observe(sample(0, at: SIMD3(0, 1.3, 0), heading: 0), floorY: nil)
        #expect(g.progress(.chestLoop) == 0)
    }
}

@Suite struct OrbitTests {
    @Test func quarterCircle() {
        var o = OrbitMeter(anchor: SIMD3(0, 0.8, 0))
        for i in 0...90 {
            let a = Float(i) * .pi / 180
            o.observe(cameraPosition: SIMD3(sin(a), 1.3, cos(a)))
        }
        #expect(abs(o.sweptDegrees - 90) < 0.5)
        #expect(o.fraction == 0.75)
    }

    @Test func backAndForthDoesNotDoubleCount() {
        var o = OrbitMeter(anchor: .zero)
        for i in [0, 30, 60, 30, 0, 30, 60] {
            let a = Float(i) * .pi / 180
            o.observe(cameraPosition: SIMD3(sin(a), 0, cos(a)))
        }
        #expect(abs(o.sweptDegrees - 60) < 0.5)
    }

    @Test func crossingTheSeam() {
        var o = OrbitMeter(anchor: .zero)
        for i in 170...200 {
            let a = Float(i) * .pi / 180
            o.observe(cameraPosition: SIMD3(sin(a), 0, cos(a)))
        }
        #expect(abs(o.sweptDegrees - 30) < 0.5)
    }
}

@Suite struct LogAndZipTests {
    @Test func poseLineMatchesSharedSchemaKeys() throws {
        let line = PoseLine(pass: .room, frame: 3, t: 0.1, sample: sample(0, at: .zero, heading: 0),
                            trackingReason: nil, fast: false, objectId: nil)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(line)) as! [String: Any]
        #expect(Set(json.keys) == ["pass", "frame", "t", "transform", "fx", "fy", "cx", "cy",
                                   "width", "height", "tracking", "fast"])
        #expect((json["transform"] as! [Double]).count == 16)
    }

    @Test func deviceWritesNullFloor() throws {
        let d = CaptureDevice(model: "iPhone", systemVersion: "26", appVersion: "0.1",
                              video: .init(width: 1920, height: 1440, fps: 30),
                              exposureLocked: true, lidar: false, floorY: nil)
        let s = String(decoding: try JSONEncoder().encode(d), as: UTF8.self)
        #expect(s.contains("\"floorY\":null"))
    }

    @Test func crc32KnownValue() {
        #expect(ZipWriter.crc32(Data("123456789".utf8), seed: 0xFFFF_FFFF) ^ 0xFFFF_FFFF == 0xCBF4_3926)
    }

    @Test func zipIsReadableByUnzip() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let a = dir.appending(path: "a.txt"), b = dir.appending(path: "b.json")
        try Data("hello\n".utf8).write(to: a)
        try Data("{\"x\":1}".utf8).write(to: b)
        let zip = dir.appending(path: "out.zip")
        try ZipWriter.write([.init(name: "poses.jsonl", source: a), .init(name: "device.json", source: b)], to: zip)
        let p = Process()
        p.executableURL = URL(filePath: "/usr/bin/unzip")
        p.arguments = ["-p", zip.path, "device.json"]
        let pipe = Pipe(); p.standardOutput = pipe
        try p.run(); p.waitUntilExit()
        #expect(p.terminationStatus == 0)
        #expect(String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self) == "{\"x\":1}")
    }
}

@Suite struct PairLinkTests {
    @Test func parses() {
        let l = PairLink(url: URL(string: "hometour://pair?api=https%3A%2F%2Fexample.app&token=abcdefghijklmnopqrstuvwxyz.sig")!)
        #expect(l?.api.absoluteString == "https://example.app")
        #expect(l?.token.hasPrefix("abc") == true)
    }

    @Test func rejectsOtherLinks() {
        #expect(PairLink(url: URL(string: "https://pair?api=https://x&token=abcdefghijklmnopqrstuvwxyz")!) == nil)
        #expect(PairLink(url: URL(string: "hometour://pair?api=ftp://x&token=abcdefghijklmnopqrstuvwxyz")!) == nil)
        #expect(PairLink(url: URL(string: "hometour://pair?api=https://x&token=short")!) == nil)
    }
}
