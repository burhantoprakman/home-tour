import ARKit
import CaptureCore
import SwiftUI

@main
struct HomeTourCaptureApp: App {
    @State private var model = CaptureModel()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .onOpenURL { model.open(url: $0) }
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @Bindable var model: CaptureModel

    var body: some View {
        switch model.phase {
        case .home: HomeView(model: model)
        case .roomPass, .detailsIntro, .detailsPass: RecordView(model: model)
        case .finishing, .finished, .failed: FinishView(model: model)
        }
    }
}

// MARK: home

struct HomeView: View {
    @Bindable var model: CaptureModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Home Tour Capture").font(.largeTitle.bold())
            if let t = model.target {
                Label("Recording **\(t.roomName)** in **\(t.homeName)**", systemImage: "link")
                Button("Unpair", role: .destructive) { model.unpair() }.font(.footnote)
            } else if model.link != nil {
                ProgressView("Connecting…")
            } else {
                Text("To upload straight to your home, open **Add room → Record with iPhone app** on the Home Tour website and scan the QR code with the Camera app.")
                    .foregroundStyle(.secondary)
                Text("You can also record without pairing and export the files.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let e = model.pairError { Text(e).foregroundStyle(.red) }
            VStack(alignment: .leading, spacing: 8) {
                Text("Before you start").font(.headline)
                Text("• Lights on, curtains open.\n• Clear people and pets out of the room.\n• Hold the phone upright and move slowly. The app tells you when to slow down.\n• Big rooms can take 10 minutes or more. That's fine.")
                    .font(.callout)
            }
            Spacer()
            Button(action: model.begin) {
                Text(model.target != nil ? "Start recording" : "Record without pairing")
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .disabled(model.link != nil && model.target == nil)
        }
        .padding(24)
    }
}

// MARK: recording

struct ARContainer: UIViewRepresentable {
    let view: ARSCNView
    func makeUIView(context: Context) -> ARSCNView { view }
    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}

struct RecordView: View {
    @Bindable var model: CaptureModel
    private var s: LiveStatus { model.status }

    var body: some View {
        ZStack {
            ARContainer(view: model.controller.view).ignoresSafeArea()
            VStack(spacing: 10) {
                topBar
                if let m = s.trackingMessage { Banner(text: m, color: .orange) }
                if s.showSlowDown { Banner(text: "Slow down", color: .red).transition(.opacity) }
                Spacer()
                bottom
            }
            .padding()
            .animation(.easeInOut(duration: 0.2), value: s.showSlowDown)
            if model.phase == .detailsIntro { DetailsIntro(model: model) }
        }
    }

    private var topBar: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.phase == .detailsPass ? "Details" : "Room").font(.caption.bold()).foregroundStyle(.secondary)
                Text(Self.clock(s.elapsed)).font(.title2.monospacedDigit().bold())
            }
            Spacer()
            if model.phase == .roomPass {
                MiniMap(map: s.map).frame(width: 140, height: 140)
            }
        }
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private var bottom: some View {
        switch model.phase {
        case .roomPass: roomControls
        case .detailsPass: detailsControls
        default: EmptyView()
        }
    }

    private var roomControls: some View {
        VStack(spacing: 10) {
            StepCard(status: s)
            HStack {
                Meter(label: "Floor", value: s.floorFraction)
                Meter(label: "Walls", value: s.wallFraction)
            }
            if s.elapsed < 60 {
                Text("Keep going: at least a minute").font(.footnote).foregroundStyle(.secondary)
            } else if s.looksComplete {
                Text("Looks complete. You can stop, or keep filming spots that look thin.")
                    .font(.footnote.bold()).foregroundStyle(.green)
            }
            Button(action: model.finishRoomPass) {
                Label("Stop room recording", systemImage: "stop.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).tint(.red).controlSize(.large)
            .disabled(s.elapsed < 10)
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private var detailsControls: some View {
        VStack(spacing: 12) {
            if model.objectActive {
                Text("Slowly arc around it, keeping it in the middle").font(.callout)
                ProgressView(value: Double(s.orbitFraction ?? 0)).tint(.green)
                Text(s.orbitFraction ?? 0 >= 1 ? "Great, tap Done" : "Keep circling…").font(.footnote)
            } else {
                Text("Point at a vase, painting or chair, then tap Start.").font(.callout)
                Text("\(s.orbitCount) object\(s.orbitCount == 1 ? "" : "s") filmed").font(.footnote).foregroundStyle(.secondary)
            }
            HStack {
                Button(action: model.toggleObject) {
                    Text(model.objectActive ? "Done" : "Start").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                Button("Finish", action: model.finish).buttonStyle(.bordered).controlSize(.large)
                    .disabled(model.objectActive)
            }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    static func clock(_ t: TimeInterval) -> String {
        String(format: "%d:%02d", Int(t) / 60, Int(t) % 60)
    }
}

struct Banner: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text).font(.headline).foregroundStyle(.white)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(color.opacity(0.9), in: Capsule())
    }
}

struct Meter: View {
    let label: String
    let value: Float
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(label) \(Int(value * 100))%").font(.caption)
            ProgressView(value: Double(value)).tint(value >= 0.9 ? .green : .accentColor)
        }
    }
}

struct StepCard: View {
    let status: LiveStatus
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                ForEach(GuidedSteps.Step.allCases, id: \.self) { step in
                    let p = status.stepProgress[step] ?? 0
                    HStack(spacing: 4) {
                        Image(systemName: p >= 1 ? "checkmark.circle.fill" : "circle.dotted")
                            .foregroundStyle(p >= 1 ? .green : .secondary)
                        Text(step.title).font(.caption2).lineLimit(1)
                    }
                    .opacity(step == status.currentStep || p >= 1 ? 1 : 0.5)
                }
            }
            if let step = status.currentStep {
                Text(step.instruction).font(.callout)
                ProgressView(value: Double(status.stepProgress[step] ?? 0))
            } else {
                Text("All three steps done. Fill any dark patches you still see.").font(.callout)
            }
            if !status.floorFound {
                Text("Point at the floor for a moment so the app can find it.").font(.footnote).foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Top-down view: floor ARKit has found (grey), floor filmed well (green), walked path,
/// you (arrow). North-up, fitted to what's known.
struct MiniMap: View {
    let map: MapSnapshot

    var body: some View {
        Canvas { ctx, size in
            let c = CoverageMap.floorCell
            var lo = map.camera - 1, hi = map.camera + 1
            for cell in map.known {
                let p = SIMD2(Float(cell.x) * c, Float(cell.z) * c)
                lo = simd_min(lo, p); hi = simd_max(hi, p + c)
            }
            for p in map.path { lo = simd_min(lo, p); hi = simd_max(hi, p) }
            let span = max(hi.x - lo.x, hi.y - lo.y)
            let k = Float(min(size.width, size.height)) / span
            let pt = { (p: SIMD2<Float>) in CGPoint(x: CGFloat((p.x - lo.x) * k), y: CGFloat((p.y - lo.y) * k)) }
            let cellSize = CGFloat(c * k)
            for cell in map.known {
                let o = pt(SIMD2(Float(cell.x) * c, Float(cell.z) * c))
                let r = CGRect(origin: o, size: CGSize(width: cellSize, height: cellSize))
                ctx.fill(Path(r), with: .color(map.seen.contains(cell) ? .green.opacity(0.75) : .gray.opacity(0.45)))
            }
            if map.path.count > 1 {
                var path = Path()
                path.move(to: pt(map.path[0]))
                for p in map.path.dropFirst() { path.addLine(to: pt(p)) }
                ctx.stroke(path, with: .color(.white.opacity(0.8)), lineWidth: 1.5)
            }
            let me = pt(map.camera)
            let dir = CGPoint(x: CGFloat(sin(map.heading)), y: CGFloat(-cos(map.heading)))
            var arrow = Path()
            arrow.move(to: CGPoint(x: me.x + dir.x * 10, y: me.y + dir.y * 10))
            arrow.addLine(to: CGPoint(x: me.x - dir.y * 5, y: me.y + dir.x * 5))
            arrow.addLine(to: CGPoint(x: me.x + dir.y * 5, y: me.y - dir.x * 5))
            arrow.closeSubpath()
            ctx.fill(arrow, with: .color(.yellow))
        }
        .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct DetailsIntro: View {
    @Bindable var model: CaptureModel
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Room done 🎉").font(.title2.bold())
            Text("Now film close-ups of the things you love (vases, paintings, a nice chair) so they look sharp in your 3D home.")
            Text("For each one: point at it, tap **Start**, slowly walk a third of a circle around it, tap **Done**.")
                .font(.callout).foregroundStyle(.secondary)
            if let p = model.uploads["Room video"] {
                ProgressView(value: p) { Text("Uploading room video…").font(.caption) }
            }
            HStack {
                Button("Film details", action: model.startDetails).buttonStyle(.borderedProminent)
                Button("Skip", action: model.finish).buttonStyle(.bordered)
            }
            .controlSize(.large)
        }
        .padding(20)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .padding()
    }
}

// MARK: finish

struct FinishView: View {
    @Bindable var model: CaptureModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            switch model.phase {
            case .failed(let msg):
                Label("Something went wrong", systemImage: "exclamationmark.triangle").font(.title2.bold())
                Text(msg).foregroundStyle(.secondary)
                Text("Your recording is kept on the phone. You can export it below.").font(.footnote)
            case .finished:
                Label("All done", systemImage: "checkmark.seal.fill").font(.title2.bold()).foregroundStyle(.green)
                Text(model.target != nil
                     ? "Your room is uploading to Home Tour and will be processed. Follow progress on the website."
                     : "Export the files to your Mac (AirDrop or Finder → iPhone → Files).")
            default:
                Text("Finishing…").font(.title2.bold())
            }
            ForEach(model.uploads.keys.sorted(), id: \.self) { key in
                ProgressView(value: model.uploads[key] ?? 0) { Text(key).font(.caption) }
            }
            if model.phase != .finishing, !model.exportFiles.isEmpty {
                ShareLink(items: model.exportFiles) { Label("Export files", systemImage: "square.and.arrow.up") }
            }
            Spacer()
            if model.phase != .finishing {
                Button("New recording") { model.reset() }.buttonStyle(.borderedProminent).controlSize(.large)
            }
        }
        .padding(24)
    }
}
