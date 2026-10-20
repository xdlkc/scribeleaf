import AppKit
import CoreGraphics
import CoreText
import Foundation
import PDFKit

enum PDFExportError: LocalizedError {
    case invalidPaper
    case invalidMargins
    case invalidSource
    case identicalPaths
    case overlayFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidPaper: return "PDF export received an invalid paper size."
        case .invalidMargins: return "PDF export received invalid page margins."
        case .invalidSource: return "PDF export could not read a valid source PDF."
        case .identicalPaths: return "PDF export source and destination must be different files."
        case .overlayFailed(let reason): return "PDF header/footer overlay failed: \(reason)"
        }
    }
}

/// Independent WebKit-PDF print options. Visual header/footer layout is our own
/// (centered 9pt in the margin band) and is not claimed as Typora-identical.
struct PDFExportOptions {
    private let paperSizePoints: NSSize?
    private let customMarginsPoints: (top: CGFloat, bottom: CGFloat, left: CGFloat, right: CGFloat)?
    private let headerTemplate: String
    private let footerTemplate: String
    private let variables: [String: String]

    init(_ values: [String: Any], variables: [String: String] = [:]) throws {
        self.variables = variables
        self.headerTemplate = Self.string(values["header"]) ?? ""
        self.footerTemplate = Self.string(values["footer"]) ?? ""

        let paperName = (Self.string(values["paper"]) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if paperName.isEmpty {
            paperSizePoints = nil
        } else if paperName.lowercased() == "custom" {
            guard let pair = Self.millimetrePair(values["paper.custom"]) else { throw PDFExportError.invalidPaper }
            paperSizePoints = try Self.validatedSize(widthMM: pair.0, heightMM: pair.1)
        } else if let named = Self.namedPaperMillimetres[paperName.lowercased()] {
            paperSizePoints = try Self.validatedSize(widthMM: named.0, heightMM: named.1)
        } else {
            throw PDFExportError.invalidPaper
        }

        let marginMode = (Self.string(values["paper.margin"]) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if marginMode.isEmpty {
            customMarginsPoints = nil
        } else if marginMode == "custom" {
            let top = try Self.marginMillimetres(values["paper.marginTop"])
            let bottom = try Self.marginMillimetres(values["paper.marginBottom"])
            let left = try Self.marginMillimetres(values["paper.marginLeft"])
            let right = try Self.marginMillimetres(values["paper.marginRight"])
            let paper: NSSize
            if let paperSizePoints {
                paper = paperSizePoints
            } else {
                paper = NSPrintInfo.shared.paperSize
            }
            customMarginsPoints = try Self.validatedMargins(topMM: top, bottomMM: bottom, leftMM: left, rightMM: right, paper: paper)
        } else {
            throw PDFExportError.invalidMargins
        }
    }

    func apply(to printInfo: NSPrintInfo) {
        if let paperSizePoints {
            printInfo.paperSize = paperSizePoints
        }
        if let customMarginsPoints {
            printInfo.topMargin = customMarginsPoints.top
            printInfo.bottomMargin = customMarginsPoints.bottom
            printInfo.leftMargin = customMarginsPoints.left
            printInfo.rightMargin = customMarginsPoints.right
        }
    }

    func finalize(source: URL, destination: URL) throws {
        guard source.isFileURL, destination.isFileURL else { throw PDFExportError.invalidSource }
        let sourceReal = source.standardizedFileURL.resolvingSymlinksInPath()
        let destinationReal = destination.standardizedFileURL.resolvingSymlinksInPath()
        if sourceReal.path == destinationReal.path { throw PDFExportError.identicalPaths }

        let original = try Data(contentsOf: source, options: [.mappedIfSafe])
        guard let provider = CGDataProvider(data: original as CFData),
              let document = CGPDFDocument(provider),
              document.numberOfPages > 0 else {
            throw PDFExportError.invalidSource
        }

        let overlay = !headerTemplate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !footerTemplate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if !overlay {
            try original.write(to: destination, options: .atomic)
            return
        }

        let output = NSMutableData()
        var firstBox = document.page(at: 1)?.getBoxRect(.mediaBox) ?? CGRect(x: 0, y: 0, width: 612, height: 792)
        let auxiliary = Self.auxiliaryInfo(from: document.info)
        guard let consumer = CGDataConsumer(data: output as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: &firstBox, auxiliary as CFDictionary?) else {
            throw PDFExportError.overlayFailed("Could not create a PDF context.")
        }

        let total = document.numberOfPages
        for index in 1...total {
            guard let page = document.page(at: index) else {
                throw PDFExportError.overlayFailed("Missing page \(index).")
            }
            let mediaBox = page.getBoxRect(.mediaBox)
            guard mediaBox.width.isFinite, mediaBox.height.isFinite,
                  mediaBox.width > 0, mediaBox.height > 0 else {
                throw PDFExportError.overlayFailed("Page \(index) has an invalid MediaBox.")
            }
            // Quartz normalizes a nonzero MediaBox to zero. Paint in the
            // original page coordinate system, then restore its boxes below.
            let pageInfo: [CFString: CFData] = [kCGPDFContextMediaBox: Self.rectData(CGRect(origin: .zero, size: mediaBox.size))]
            context.beginPDFPage(pageInfo as CFDictionary)
            context.saveGState()
            context.translateBy(x: -mediaBox.minX, y: -mediaBox.minY)
            context.drawPDFPage(page)
            context.restoreGState()
            Self.drawBand(context: context, page: page, mediaBox: CGRect(origin: .zero, size: mediaBox.size), text: expand(headerTemplate, page: index, total: total), top: true)
            Self.drawBand(context: context, page: page, mediaBox: CGRect(origin: .zero, size: mediaBox.size), text: expand(footerTemplate, page: index, total: total), top: false)
            context.endPDFPage()
        }
        context.closePDF()
        guard output.length > 0 else { throw PDFExportError.overlayFailed("The overlaid PDF was empty.") }
        let finalized = try Self.preserveInteractions(output as Data, original: original, source: document)
        try finalized.write(to: destination, options: .atomic)
    }

    /// This helper consumes this app's print PDF. Public PDFKit writing uses a
    /// zero-origin MediaBox. Body geometry and interaction coordinates are
    /// normalized by the same translation; page sizes and rotation are retained.
    private static func preserveInteractions(_ generated: Data, original: Data, source: CGPDFDocument) throws -> Data {
        guard let input = PDFDocument(data: original), let output = PDFDocument(data: generated),
              input.pageCount == output.pageCount, input.pageCount == source.numberOfPages else {
            throw PDFExportError.overlayFailed("The generated page count changed.")
        }
        func origin(_ index: Int) -> CGPoint {
            source.page(at: index + 1)?.getBoxRect(.mediaBox).origin ?? .zero
        }
        func destination(_ before: PDFDestination?) -> PDFDestination? {
            guard let before, let page = before.page else { return nil }
            let index = input.index(for: page)
            guard index >= 0, index < output.pageCount, let target = output.page(at: index) else { return nil }
            let offset = origin(index)
            let result = PDFDestination(page: target, at: CGPoint(x: before.point.x - offset.x, y: before.point.y - offset.y))
            result.zoom = before.zoom
            return result
        }
        func action(_ before: PDFAction?) -> PDFAction? {
            if let go = before as? PDFActionGoTo, let mapped = destination(go.destination) {
                return PDFActionGoTo(destination: mapped)
            }
            if let url = before as? PDFActionURL, let target = url.url { return PDFActionURL(url: target) }
            return before?.copy() as? PDFAction
        }
        for index in 0..<input.pageCount {
            guard let before = input.page(at: index), let after = output.page(at: index),
                  let originalPage = source.page(at: index + 1) else {
                throw PDFExportError.overlayFailed("A generated page is missing.")
            }
            after.rotation = before.rotation
            let offset = origin(index)
            for (box, target): (CGPDFBox, PDFDisplayBox) in [(.cropBox,.cropBox),(.bleedBox,.bleedBox),(.trimBox,.trimBox),(.artBox,.artBox)] {
                after.setBounds(originalPage.getBoxRect(box).offsetBy(dx: -offset.x, dy: -offset.y), for: target)
            }
            for annotation in before.annotations {
                guard let copied = annotation.copy() as? PDFAnnotation else {
                    throw PDFExportError.overlayFailed("An annotation could not be preserved.")
                }
                copied.bounds = annotation.bounds.offsetBy(dx: -offset.x, dy: -offset.y)
                if let mapped = action(annotation.action) {
                    // Link /Dest and /A are alternatives. A copied /Dest still
                    // points at the source graph even after setting a new /A.
                    copied.removeValue(forAnnotationKey: .destination)
                    copied.action = mapped
                }
                after.addAnnotation(copied)
            }
        }
        func outline(_ before: PDFOutline) -> PDFOutline {
            let result = PDFOutline()
            result.label = before.label
            if let oldAction = before.action { result.action = action(oldAction) }
            else { result.destination = destination(before.destination) }
            for index in 0..<before.numberOfChildren {
                if let child = before.child(at: index) { result.insertChild(outline(child), at: index) }
            }
            result.isOpen = before.isOpen
            return result
        }
        if let root = input.outlineRoot { output.outlineRoot = outline(root) }
        output.documentAttributes = input.documentAttributes
        guard let result = output.dataRepresentation(), let verified = PDFDocument(data: result), verified.pageCount == input.pageCount else {
            throw PDFExportError.overlayFailed("The generated PDF could not be encoded.")
        }
        return result
    }

    // MARK: - Paper tables (ISO 216 / US, millimetres)

    private static let namedPaperMillimetres: [String: (Double, Double)] = [
        "a0": (841, 1189), "a1": (594, 841), "a2": (420, 594), "a3": (297, 420),
        "a4": (210, 297), "a5": (148, 210), "a6": (105, 148),
        "b4": (250, 353), "b5": (176, 250),
        "letter": (215.9, 279.4), "legal": (215.9, 355.6), "tabloid": (279.4, 431.8)
    ]

    private static let pointsPerMillimetre: CGFloat = 72.0 / 25.4
    private static let defaultCustomMarginMM: Double = 16

    private static func mmToPoints(_ mm: Double) -> CGFloat { CGFloat(mm) * pointsPerMillimetre }

    private static func validatedSize(widthMM: Double, heightMM: Double) throws -> NSSize {
        guard widthMM.isFinite, heightMM.isFinite, widthMM > 0, heightMM > 0 else { throw PDFExportError.invalidPaper }
        let size = NSSize(width: mmToPoints(widthMM), height: mmToPoints(heightMM))
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { throw PDFExportError.invalidPaper }
        return size
    }

    private static func marginMillimetres(_ value: Any?) throws -> Double {
        if value == nil { return defaultCustomMarginMM }
        if let text = value as? String, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return defaultCustomMarginMM
        }
        guard let number = number(value), number.isFinite, number >= 0 else { throw PDFExportError.invalidMargins }
        return number
    }

    private static func validatedMargins(topMM: Double, bottomMM: Double, leftMM: Double, rightMM: Double, paper: NSSize) throws -> (CGFloat, CGFloat, CGFloat, CGFloat) {
        let top = mmToPoints(topMM), bottom = mmToPoints(bottomMM), left = mmToPoints(leftMM), right = mmToPoints(rightMM)
        guard [top, bottom, left, right].allSatisfy({ $0.isFinite && $0 >= 0 }) else { throw PDFExportError.invalidMargins }
        let printableWidth = paper.width - left - right
        let printableHeight = paper.height - top - bottom
        guard printableWidth.isFinite, printableHeight.isFinite, printableWidth > 0, printableHeight > 0 else {
            throw PDFExportError.invalidMargins
        }
        return (top, bottom, left, right)
    }

    private static func string(_ value: Any?) -> String? {
        if let text = value as? String { return text }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    private static func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let text = value as? String {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return nil }
            return Double(trimmed)
        }
        return nil
    }

    private static func millimetrePair(_ value: Any?) -> (Double, Double)? {
        if let array = value as? [Any], array.count >= 2,
           let width = number(array[0]), let height = number(array[1]) {
            return (width, height)
        }
        if let array = value as? NSArray, array.count >= 2,
           let width = number(array[0]), let height = number(array[1]) {
            return (width, height)
        }
        return nil
    }

    private func expand(_ template: String, page: Int, total: Int) -> String {
        guard !template.isEmpty else { return "" }
        var output = ""
        var search = template.startIndex
        while let open = template[search...].range(of: "${") {
            output += template[search..<open.lowerBound]
            let after = open.upperBound
            if let close = template[after...].range(of: "}") {
                let name = String(template[after..<close.lowerBound])
                if name == "pageNo" {
                    output += String(page)
                } else if name == "totalPages" {
                    output += String(total)
                } else if let replacement = variables[name] {
                    output += replacement
                } else {
                    output += "${\(name)}"
                }
                search = close.upperBound
            } else {
                output += String(template[open.lowerBound...])
                return output
            }
        }
        output += template[search...]
        return output
    }

    private static func drawBand(context: CGContext, page: CGPDFPage, mediaBox: CGRect, text: String, top: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let rotation = page.rotationAngle
        let visual = visualBounds(mediaBox: mediaBox, rotation: rotation)
        let font = NSFont.systemFont(ofSize: 9) as CTFont
        let color = CGColor(gray: 0.15, alpha: 1)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color
        ]
        let attributed = NSAttributedString(string: trimmed, attributes: attributes)
        let line = CTLineCreateWithAttributedString(attributed)
        let typographic = CTLineGetTypographicBounds(line, nil, nil, nil)
        let textWidth = CGFloat(typographic)
        let inset: CGFloat = 6
        let x = visual.midX - textWidth / 2
        let y = top ? visual.maxY - 9 - inset : visual.minY + inset
        context.saveGState()
        context.concatenate(visualTransform(mediaBox: mediaBox, rotation: rotation))
        context.textMatrix = .identity
        context.textPosition = CGPoint(x: x, y: y)
        CTLineDraw(line, context)
        context.restoreGState()
    }

    /// Map visual upright coordinates onto the unrotated MediaBox, including a
    /// nonzero origin. Header/footer then sit on the visual top/bottom edge.
    private static func visualBounds(mediaBox: CGRect, rotation: Int32) -> CGRect {
        let angle = ((rotation % 360) + 360) % 360
        if angle == 90 || angle == 270 {
            return CGRect(x: 0, y: 0, width: mediaBox.height, height: mediaBox.width)
        }
        return CGRect(x: 0, y: 0, width: mediaBox.width, height: mediaBox.height)
    }

    private static func visualTransform(mediaBox: CGRect, rotation: Int32) -> CGAffineTransform {
        let angle = ((rotation % 360) + 360) % 360
        var transform = CGAffineTransform(translationX: mediaBox.minX, y: mediaBox.minY)
        switch angle {
        case 90:
            transform = transform.translatedBy(x: mediaBox.width, y: 0).rotated(by: .pi / 2)
        case 180:
            transform = transform.translatedBy(x: mediaBox.width, y: mediaBox.height).rotated(by: .pi)
        case 270:
            transform = transform.translatedBy(x: 0, y: mediaBox.height).rotated(by: -.pi / 2)
        default:
            break
        }
        return transform
    }

    private static func rectData(_ rect: CGRect) -> CFData {
        var box = rect
        return withUnsafeBytes(of: &box) { Data($0) as CFData }
    }

    private static func auxiliaryInfo(from info: CGPDFDictionaryRef?) -> [CFString: String] {
        guard let info else { return [:] }
        var result: [CFString: String] = [:]
        let map: [(String, CFString)] = [
            ("Title", kCGPDFContextTitle),
            ("Author", kCGPDFContextAuthor),
            ("Subject", kCGPDFContextSubject),
            ("Keywords", kCGPDFContextKeywords),
            ("Creator", kCGPDFContextCreator)
        ]
        for (name, key) in map {
            var string: CGPDFStringRef?
            if CGPDFDictionaryGetString(info, name, &string), let string,
               let text = CGPDFStringCopyTextString(string) as String? {
                result[key] = text
            }
        }
        return result
    }
}
