// Scribeleaf original book-page / leaf mark. Editable vector geometry; no external assets/fonts.
// Run through scripts/build-icon.sh. Coordinates use a 1024-unit design canvas.
import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255)/255, green: CGFloat((hex >> 8) & 255)/255, blue: CGFloat(hex & 255)/255, alpha: alpha)
}
func drawMark() {
    let tile = NSBezierPath(roundedRect: NSRect(x:64,y:64,width:896,height:896), xRadius:196, yRadius:196)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow(); shadow.shadowColor = color(0x092E2A,0.2); shadow.shadowBlurRadius=20; shadow.shadowOffset=NSSize(width:0,height:-7); shadow.set()
    color(0x103F39).setFill(); tile.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(starting:color(0x0B3631),ending:color(0x185C53))!.draw(in:tile,angle:90)
    let rim = NSBezierPath(roundedRect:NSRect(x:66,y:66,width:892,height:892),xRadius:194,yRadius:194)
    color(0xB9E4D4,0.12).setStroke(); rim.lineWidth=2;rim.stroke()

    let page=NSBezierPath()
    page.move(to:NSPoint(x:298,y:250));page.curve(to:NSPoint(x:346,y:202),controlPoint1:NSPoint(x:298,y:223),controlPoint2:NSPoint(x:319,y:202))
    page.line(to:NSPoint(x:630,y:202));page.curve(to:NSPoint(x:678,y:250),controlPoint1:NSPoint(x:657,y:202),controlPoint2:NSPoint(x:678,y:223))
    page.line(to:NSPoint(x:678,y:678));page.line(to:NSPoint(x:560,y:796));page.line(to:NSPoint(x:346,y:796))
    page.curve(to:NSPoint(x:298,y:748),controlPoint1:NSPoint(x:319,y:796),controlPoint2:NSPoint(x:298,y:775));page.close()
    NSGraphicsContext.saveGraphicsState()
    let paperShadow=NSShadow();paperShadow.shadowColor=color(0x001F1B,0.24);paperShadow.shadowBlurRadius=18;paperShadow.shadowOffset=NSSize(width:0,height:-12);paperShadow.set()
    color(0xF8F5E9).setFill();page.fill();NSGraphicsContext.restoreGraphicsState()
    let fold=NSBezierPath();fold.move(to:NSPoint(x:560,y:796));fold.line(to:NSPoint(x:560,y:710));fold.curve(to:NSPoint(x:592,y:678),controlPoint1:NSPoint(x:560,y:692),controlPoint2:NSPoint(x:574,y:678));fold.line(to:NSPoint(x:678,y:678));fold.close()
    color(0xD4E3D8).setFill();fold.fill()
    let lines=NSBezierPath();lines.move(to:NSPoint(x:365,y:650));lines.line(to:NSPoint(x:486,y:650));lines.move(to:NSPoint(x:365,y:576));lines.line(to:NSPoint(x:455,y:576));lines.lineWidth=20;lines.lineCapStyle = .round;color(0x276A5C,0.38).setStroke();lines.stroke()

    let leaf=NSBezierPath();leaf.move(to:NSPoint(x:463,y:257))
    leaf.curve(to:NSPoint(x:795,y:692),controlPoint1:NSPoint(x:447,y:520),controlPoint2:NSPoint(x:619,y:734))
    leaf.curve(to:NSPoint(x:463,y:257),controlPoint1:NSPoint(x:831,y:440),controlPoint2:NSPoint(x:644,y:251));leaf.close()
    NSGraphicsContext.saveGraphicsState()
    let leafShadow=NSShadow();leafShadow.shadowColor=color(0x083F34,0.14);leafShadow.shadowBlurRadius=12;leafShadow.shadowOffset=NSSize(width:-3,height:-6);leafShadow.set()
    color(0x2AA481).setFill();leaf.fill();NSGraphicsContext.restoreGraphicsState()
    NSGradient(starting:color(0x13886C),ending:color(0x58C7A1))!.draw(in:leaf,angle:65)
    let vein=NSBezierPath();vein.move(to:NSPoint(x:486,y:290));vein.curve(to:NSPoint(x:751,y:635),controlPoint1:NSPoint(x:568,y:438),controlPoint2:NSPoint(x:665,y:561));vein.lineWidth=18;vein.lineCapStyle = .round;color(0xEAF5DC,0.95).setStroke();vein.stroke()
}
var masterImage: CGImage?
func render(_ pixels:Int) -> CGImage {
    if masterImage == nil {
        let context=CGContext(data:nil,width:1024,height:1024,bitsPerComponent:8,bytesPerRow:4096,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
        NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(cgContext:context,flipped:false);drawMark();NSGraphicsContext.restoreGraphicsState()
        masterImage=context.makeImage()!
    }
    if pixels == 1024 { return masterImage! }
    // Scale the vector-rendered master so shadow blur keeps its proportional margin.
    let context=CGContext(data:nil,width:pixels,height:pixels,bitsPerComponent:8,bytesPerRow:pixels*4,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.interpolationQuality = .high
    context.draw(masterImage!,in:CGRect(x:0,y:0,width:pixels,height:pixels))
    return context.makeImage()!
}
func write(_ image:CGImage,_ name:String) {
    let dest=CGImageDestinationCreateWithURL(output.appendingPathComponent(name) as CFURL,UTType.png.identifier as CFString,1,nil)!
    CGImageDestinationAddImage(dest,image,nil);precondition(CGImageDestinationFinalize(dest))
}
var reports:[[String:Any]]=[]
for pixels in [16,32,64,128,256,512,1024] {
    let image=render(pixels);write(image,"icon-\(pixels).png")
    let bytes=CFDataGetBytePtr(image.dataProvider!.data!)!;let row=image.bytesPerRow
    let corners=[bytes[3],bytes[(pixels-1)*4+3],bytes[(pixels-1)*row+3],bytes[(pixels-1)*row+(pixels-1)*4+3]]
    precondition(corners.allSatisfy{$0 == 0},"Corners must be transparent")
    var minX=pixels,minY=pixels,maxX=0,maxY=0
    for y in 0..<pixels {for x in 0..<pixels {if bytes[y*row+x*4+3] > 10 {minX=min(minX,x);minY=min(minY,y);maxX=max(maxX,x);maxY=max(maxY,y)}}}
    precondition(minX>0 && minY>0 && maxX<pixels-1 && maxY<pixels-1,"Icon must retain transparent padding")
    reports.append(["pixels":pixels,"transparentCorners":true,"alphaOver10Bounds":[minX,minY,maxX,maxY]])
}
let preview=CGContext(data:nil,width:1480,height:800,bitsPerComponent:8,bytesPerRow:1480*4,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(cgContext:preview,flipped:false)
color(0xF2F1EC).setFill();NSRect(x:0,y:0,width:1480,height:800).fill()
preview.draw(render(512),in:CGRect(x:35,y:240,width:512,height:512))
color(0x102C29).setFill();NSBezierPath(roundedRect:NSRect(x:590,y:400,width:820,height:340),xRadius:25,yRadius:25).fill()
preview.draw(render(256),in:CGRect(x:620,y:440,width:256,height:256))
preview.draw(render(128),in:CGRect(x:920,y:504,width:128,height:128))
preview.draw(render(64),in:CGRect(x:1100,y:536,width:64,height:64))
preview.draw(render(32),in:CGRect(x:1220,y:552,width:32,height:32))
preview.draw(render(16),in:CGRect(x:1300,y:560,width:16,height:16))
let textAttributes:[NSAttributedString.Key:Any]=[.font:NSFont.systemFont(ofSize:20,weight:.medium),.foregroundColor:color(0x23483E)]
let whiteAttributes:[NSAttributedString.Key:Any]=[.font:NSFont.systemFont(ofSize:17,weight:.medium),.foregroundColor:color(0xDCECE3)]
("512 px" as NSString).draw(at:NSPoint(x:245,y:220),withAttributes:textAttributes)
for (label,x) in [("256",720),("128",962),("64",1115),("32",1223),("16",1298)] {(label as NSString).draw(at:NSPoint(x:x,y:422),withAttributes:whiteAttributes)}
("Scribeleaf · original page + leaf icon" as NSString).draw(at:NSPoint(x:70,y:140),withAttributes:[.font:NSFont.systemFont(ofSize:28,weight:.semibold),.foregroundColor:color(0x123F36)])
("16 / 32 / 64 / 128 / 256 / 512 / 1024 px · transparent PNG · shared Lite / Full brand" as NSString).draw(at:NSPoint(x:70,y:92),withAttributes:textAttributes)
NSGraphicsContext.restoreGraphicsState();write(preview.makeImage()!,"preview.png")
try JSONSerialization.data(withJSONObject:reports,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("verification.json"))
