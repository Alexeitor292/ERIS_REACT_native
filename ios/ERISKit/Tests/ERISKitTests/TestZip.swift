import Foundation
@testable import ERISKit

// Building stored (uncompressed) ZIPs and little-endian bytes for the terrain tests.

func f32le(_ values: [Float]) -> [UInt8] {
    var out: [UInt8] = []
    for value in values { out += le32(value.bitPattern) }
    return out
}

func le32(_ v: UInt32) -> [UInt8] {
    [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)]
}

func put16(_ bytes: inout [UInt8], _ at: Int, _ v: Int) {
    bytes[at] = UInt8(v & 0xff)
    bytes[at + 1] = UInt8((v >> 8) & 0xff)
}

func put32(_ bytes: inout [UInt8], _ at: Int, _ v: UInt32) {
    bytes.replaceSubrange(at..<(at + 4), with: le32(v))
}

func makeStoredZip(_ files: [(String, [UInt8])]) -> [UInt8] {
    TerrainBundle.makeStoredZip(files)
}
