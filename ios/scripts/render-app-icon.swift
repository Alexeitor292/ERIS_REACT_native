// Renders the ERIS logo (web/public/eris-logo.svg) as the iOS app icon:
//   swift ios/scripts/render-app-icon.swift web/public/eris-logo.svg ios/ERIS/Assets.xcassets/AppIcon.appiconset/AppIcon.png 1024
// Renders an SVG to a square, opaque PNG: background colour first, so the
// SVG's rounded corners do not leave transparent (black on iOS) corners.
import AppKit

let args = CommandLine.arguments
let (svgPath, outPath, size) = (args[1], args[2], Int(args[3])!)
guard let image = NSImage(contentsOf: URL(fileURLWithPath: svgPath)) else { fatalError("cannot read SVG") }
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(srgbRed: 1, green: 0xCC / 255.0, blue: 0x33 / 255.0, alpha: 1))  // #ffcc33, the logo's yellow
context.fill(CGRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.current = nil
let rep = NSBitmapImageRep(cgImage: context.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: outPath))
