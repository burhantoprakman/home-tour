import Foundation

/// Minimal "stored" (uncompressed) ZIP writer for capture.zip, so the app needs no dependency.
/// Python's zipfile reads it. Files are streamed from disk in 1 MiB blocks.
public enum ZipWriter {
    public struct Entry {
        public var name: String
        public var source: URL
        public init(name: String, source: URL) { self.name = name; self.source = source }
    }

    public enum ZipError: Error { case tooLarge(String) }

    public static func write(_ entries: [Entry], to url: URL) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let out = try FileHandle(forWritingTo: url)
        defer { try? out.close() }
        var central = Data()
        var offset: UInt64 = 0
        for e in entries {
            let (crc, size) = try crcAndSize(e.source)
            guard size < UInt64(UInt32.max), offset < UInt64(UInt32.max) else {
                throw ZipError.tooLarge(e.name)
            }
            let name = Data(e.name.utf8)
            var local = Data()
            local.u32(0x04034b50); local.u16(20); local.u16(0x0800); local.u16(0)  // stored, UTF-8
            local.u16(0); local.u16(0x21)  // time 00:00:00, date 1980-01-01
            local.u32(crc); local.u32(UInt32(size)); local.u32(UInt32(size))
            local.u16(UInt16(name.count)); local.u16(0); local.append(name)
            try out.write(contentsOf: local)
            let input = try FileHandle(forReadingFrom: e.source)
            while let block = try input.read(upToCount: 1 << 20), !block.isEmpty {
                try out.write(contentsOf: block)
            }
            try input.close()

            central.u32(0x02014b50); central.u16(20); central.u16(20); central.u16(0x0800)
            central.u16(0); central.u16(0); central.u16(0x21)
            central.u32(crc); central.u32(UInt32(size)); central.u32(UInt32(size))
            central.u16(UInt16(name.count)); central.u16(0); central.u16(0); central.u16(0)
            central.u16(0); central.u32(0); central.u32(UInt32(offset)); central.append(name)
            offset += UInt64(local.count) + size
        }
        var end = Data()
        end.u32(0x06054b50); end.u16(0); end.u16(0)
        end.u16(UInt16(entries.count)); end.u16(UInt16(entries.count))
        end.u32(UInt32(central.count)); end.u32(UInt32(offset)); end.u16(0)
        try out.write(contentsOf: central + end)
    }

    static func crcAndSize(_ url: URL) throws -> (UInt32, UInt64) {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var crc: UInt32 = 0xFFFF_FFFF
        var size: UInt64 = 0
        while let block = try h.read(upToCount: 1 << 20), !block.isEmpty {
            crc = crc32(block, seed: crc)
            size += UInt64(block.count)
        }
        return (crc ^ 0xFFFF_FFFF, size)
    }

    private static let table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ data: Data, seed: UInt32) -> UInt32 {
        var c = seed
        data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            for b in buf { c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        }
        return c
    }
}

private extension Data {
    mutating func u16(_ v: UInt16) { Swift.withUnsafeBytes(of: v.littleEndian) { append(contentsOf: $0) } }
    mutating func u32(_ v: UInt32) { Swift.withUnsafeBytes(of: v.littleEndian) { append(contentsOf: $0) } }
}
