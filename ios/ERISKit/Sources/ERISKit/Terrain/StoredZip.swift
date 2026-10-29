import Foundation

extension TerrainBundle {
    /// A ZIP of stored (uncompressed) entries, the layout `extractAndValidateBundle`
    /// reads: for packages built on the device (the demo) and in tests.
    public static func makeStoredZip(_ files: [(String, [UInt8])]) -> [UInt8] {
        func put16(_ bytes: inout [UInt8], _ at: Int, _ v: Int) {
            bytes[at] = UInt8(v & 0xff)
            bytes[at + 1] = UInt8((v >> 8) & 0xff)
        }
        func put32(_ bytes: inout [UInt8], _ at: Int, _ v: UInt32) {
            for i in 0..<4 { bytes[at + i] = UInt8((v >> (8 * UInt32(i))) & 0xff) }
        }
        var locals: [UInt8] = []
        var centrals: [UInt8] = []
        var offset = 0
        for (name, data) in files {
            let nb = Array(name.utf8)
            let crc = crc32(data)
            var lh = [UInt8](repeating: 0, count: 30 + nb.count)
            put32(&lh, 0, 0x0403_4b50)
            put16(&lh, 4, 20)
            put16(&lh, 8, 0) // STORED
            put32(&lh, 14, crc)
            put32(&lh, 18, UInt32(data.count))
            put32(&lh, 22, UInt32(data.count))
            put16(&lh, 26, nb.count)
            lh.replaceSubrange(30..<(30 + nb.count), with: nb)
            locals += lh + data

            var cd = [UInt8](repeating: 0, count: 46 + nb.count)
            put32(&cd, 0, 0x0201_4b50)
            put16(&cd, 4, 20)
            put16(&cd, 6, 20)
            put32(&cd, 16, crc)
            put32(&cd, 20, UInt32(data.count))
            put32(&cd, 24, UInt32(data.count))
            put16(&cd, 28, nb.count)
            put32(&cd, 42, UInt32(offset))
            cd.replaceSubrange(46..<(46 + nb.count), with: nb)
            centrals += cd
            offset += lh.count + data.count
        }
        var eocd = [UInt8](repeating: 0, count: 22)
        put32(&eocd, 0, 0x0605_4b50)
        put16(&eocd, 8, files.count)
        put16(&eocd, 10, files.count)
        put32(&eocd, 12, UInt32(centrals.count))
        put32(&eocd, 16, UInt32(offset))
        return locals + centrals + eocd
    }
}
