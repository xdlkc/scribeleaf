#!/usr/bin/env python3
"""Compile the real PDF option helper and verify print settings and vector PDFs."""
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / 'evidence/pdf-export-options-verification.json'
RUNNER = r'''
import AppKit
import CoreText
import PDFKit

@main struct VerifyPDFOptions {
    static func main() {
        let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        var checks: [[String: Any]] = []
        func record(_ name: String, _ passed: Bool, _ detail: [String: Any] = [:]) {
            checks.append(["name":name,"passed":passed,"detail":detail])
        }
        func close(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a-b) < 0.01 }
        func line(_ text: String, _ context: CGContext, _ x: CGFloat, _ y: CGFloat) {
            let attributed = NSAttributedString(string:text, attributes:[.font:NSFont.systemFont(ofSize:18),.foregroundColor:NSColor.black])
            context.textMatrix = .identity; context.textPosition = CGPoint(x:x,y:y)
            CTLineDraw(CTLineCreateWithAttributedString(attributed), context)
        }
        do {
            let info = NSPrintInfo(dictionary: [:])
            info.paperSize = NSSize(width:777,height:555)
            info.topMargin=21;info.bottomMargin=22;info.leftMargin=23;info.rightMargin=24
            let empty = try PDFExportOptions([:]); empty.apply(to:info)
            record("Empty paper and margins retain actual NSPrintInfo defaults",close(info.paperSize.width,777)&&close(info.paperSize.height,555)&&close(info.topMargin,21)&&close(info.rightMargin,24),["paper":[info.paperSize.width,info.paperSize.height],"margins":[info.topMargin,info.bottomMargin,info.leftMargin,info.rightMargin]])
            let mm:CGFloat = 72/25.4
            for (paper,w,h) in [("A4",210.0,297.0),("Letter",215.9,279.4),("Legal",215.9,355.6)] {
                let target = NSPrintInfo(dictionary:[:]);target.orientation = .portrait
                try PDFExportOptions(["paper":paper]).apply(to:target)
                record("Named paper \(paper) uses public NSPrintInfo size",abs(target.paperSize.width-CGFloat(w)*mm)<0.6&&abs(target.paperSize.height-CGFloat(h)*mm)<0.6,["size":[target.paperSize.width,target.paperSize.height],"note":"NSPrintInfo quantizes known printer papers to whole points."])
            }
            let custom = NSPrintInfo(dictionary:[:]);custom.orientation = .portrait
            try PDFExportOptions(["paper":"custom","paper.custom":[120,180],"paper.margin":"custom","paper.marginTop":10,"paper.marginBottom":11,"paper.marginLeft":12,"paper.marginRight":13]).apply(to:custom)
            record("Custom millimetres and all four margins reach actual NSPrintInfo",close(custom.paperSize.width,120*mm)&&close(custom.paperSize.height,180*mm)&&close(custom.topMargin,10*mm)&&close(custom.bottomMargin,11*mm)&&close(custom.leftMargin,12*mm)&&close(custom.rightMargin,13*mm),["size":[custom.paperSize.width,custom.paperSize.height],"margins":[custom.topMargin,custom.bottomMargin,custom.leftMargin,custom.rightMargin]])
            var rejected=0
            for values:[String:Any] in [["paper":"custom","paper.custom":[0,100]],["paper":"custom","paper.custom":[100,Double.nan]],["paper":"unknown"],["paper.margin":"custom","paper.marginTop":-1],["paper":"A4","paper.margin":"custom","paper.marginLeft":300]] {
                do { _ = try PDFExportOptions(values) } catch { rejected += 1 }
            }
            record("Invalid dimensions, paper names and impossible margins are rejected",rejected==5,["rejected":rejected])
            let source=folder.appendingPathComponent("source.pdf")
            if !FileManager.default.fileExists(atPath:source.path) {
            guard let context=CGContext(source as CFURL,mediaBox:nil,nil) else { throw NSError(domain:"PDFVerifier",code:1) }
            let boxes=[CGRect(x:0,y:0,width:612,height:792),CGRect(x:13,y:17,width:500,height:700)]
            for (index,box) in boxes.enumerated() {
                var box=box
                let data=NSData(bytes:&box,length:MemoryLayout<CGRect>.size)
                context.beginPDFPage([kCGPDFContextMediaBox as String:data] as CFDictionary)
                context.setFillColor((index==0 ? NSColor.systemRed : NSColor.systemGreen).cgColor)
                context.fill(CGRect(x:box.minX+50,y:box.minY+60,width:80,height:90))
                line("BODY_\(index+1) 中文正文",context,box.minX+60,box.minY+box.height/2)
                context.endPDFPage()
            }
            context.closePDF()
            }
            if CommandLine.arguments.count>2 && CommandLine.arguments[2]=="generate" { return }
            let original=try Data(contentsOf:source)
            let destination=folder.appendingPathComponent("decorated.pdf")
            let sentinel=Data("EXISTING OUTPUT".utf8)
            try sentinel.write(to:destination)
            let options=try PDFExportOptions(["header":"HDR ${title} ${author} ${today} ${pageNo}/${totalPages}","footer":"FTR ${pageNo}/${totalPages}"],variables:["title":"中文标题","author":"作者","today":"2026-10-19","pageNo":"WRONG","totalPages":"WRONG"])
            try options.finalize(source:source,destination:destination)
            let output=PDFDocument(url:destination)!
            let input=PDFDocument(url:source)!
            var preserved=true, tokens=true
            var pages:[[String:Any]]=[]
            for index in 0..<2 {
                let page=output.page(at:index)!,before=input.page(at:index)!,text=page.string ?? ""
                let sourceCG=CGPDFDocument(source as CFURL)!.page(at:index+1)!,outputCG=CGPDFDocument(destination as CFURL)!.page(at:index+1)!
                let box=outputCG.getBoxRect(.mediaBox),originalBox=sourceCG.getBoxRect(.mediaBox)
                let compact=text.precomposedStringWithCompatibilityMapping.filter{!$0.isWhitespace}
                preserved = preserved && box.size==originalBox.size && box.origin == .zero && page.rotation==before.rotation && compact.contains("BODY_\(index+1)") && compact.contains("中文正文")
                let normalized=text.precomposedStringWithCompatibilityMapping
                tokens = tokens && normalized.contains("HDR 中文标题 作者 2026-10-19 \(index+1)/2") && normalized.contains("FTR \(index+1)/2") && !text.contains("WRONG")
                pages.append(["text":text,"mediaBox":[box.minX,box.minY,box.width,box.height],"sourceMediaBox":[originalBox.minX,originalBox.minY,originalBox.width,originalBox.height],"rotation":page.rotation,"sourceRotation":before.rotation])
            }
            record("Two real PDF pages retain body Unicode, page sizes and rotation with normalized origins",output.pageCount==2&&preserved,["pages":pages,"normalization":"Public PDFKit normalizes MediaBox origins; body and interaction coordinates receive the same translation."])
            record("Metadata and pageNo/totalPages tokens are drawn as extractable text",tokens,["pages":pages])
            let links=output.page(at:0)!.annotations
            let url=links.compactMap{$0.action as? PDFActionURL}.first?.url?.absoluteString
            let go=links.compactMap{$0.action as? PDFActionGoTo}.first?.destination
            let goIndex=go?.page.map{output.index(for:$0)} ?? -1
            let outline=output.outlineRoot?.child(at:0)?.destination
            let outlineIndex=outline?.page.map{output.index(for:$0)} ?? -1
            record("URL annotation remains interactive",url=="https://example.com/pdf-link",["url":url ?? "","linkCount":links.count])
            record("GoTo annotation keeps target page, normalized point and zoom",goIndex==1&&close(go?.point.x ?? -1,87)&&close(go?.point.y ?? -1,483)&&close(go?.zoom ?? -1,1.25),["page":goIndex,"point":[go?.point.x ?? -1,go?.point.y ?? -1],"zoom":go?.zoom ?? -1])
            record("Outline keeps label and normalized GoTo destination",outlineIndex==1&&output.outlineRoot?.child(at:0)?.label=="Second 中文"&&close(outline?.point.x ?? -1,87)&&close(outline?.point.y ?? -1,483),["page":outlineIndex,"label":output.outlineRoot?.child(at:0)?.label ?? "","point":[outline?.point.x ?? -1,outline?.point.y ?? -1]])
            record("Successful finalization replaces old target and leaves source bytes intact",try Data(contentsOf:source)==original && Data(contentsOf:destination) != sentinel)
            let exact=folder.appendingPathComponent("exact.pdf")
            try PDFExportOptions([:]).finalize(source:source,destination:exact)
            record("No header/footer is an exact atomic byte copy",try Data(contentsOf:exact)==original)
            var sameRejected=false
            do { try options.finalize(source:source,destination:source) } catch { sameRejected=true }
            let afterSame=try Data(contentsOf:source)
            record("Source==destination is rejected without changing source",sameRejected && afterSame==original)
            let invalid=folder.appendingPathComponent("invalid.pdf");try Data("not a PDF".utf8).write(to:invalid)
            let preservedTarget=folder.appendingPathComponent("preserved.pdf");try sentinel.write(to:preservedTarget)
            var invalidRejected=false
            do { try options.finalize(source:invalid,destination:preservedTarget) } catch { invalidRejected=true }
            let afterTarget=try Data(contentsOf:preservedTarget),afterInvalid=try Data(contentsOf:invalid)
            record("A malformed source preserves both prior target and source",invalidRejected && afterTarget==sentinel && afterInvalid==Data("not a PDF".utf8))
            let alias=folder.appendingPathComponent("alias.pdf")
            try FileManager.default.createSymbolicLink(at:alias,withDestinationURL:source)
            var aliasRejected=false
            do { try options.finalize(source:source,destination:alias) } catch { aliasRejected=true }
            let afterAlias=try Data(contentsOf:source)
            record("A destination symlink to source is rejected",aliasRejected && afterAlias==original)
        } catch { record("Verifier completed without an unexpected error",false,["error":error.localizedDescription]) }
        let result:[String:Any]=["passed":checks.allSatisfy{$0["passed"] as? Bool==true},"checks":checks]
        let data=try! JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys])
        try! data.write(to:folder.appendingPathComponent("result.json"))
        print(String(decoding:data,as:UTF8.self))
    }
}
'''


def main():
    cache = ROOT / '.cache'
    cache.mkdir(exist_ok=True)
    evidence = {'scope': 'Real NSPrintInfo plus real CoreGraphics/CoreText/PDFKit source/output pages',
                'originalVisualParity': 'Header/footer native layout not established in original reference; independent public implementation, pending visual comparison.',
                'geometryPolicy': 'For this app print PDFs, public PDFKit normalizes nonzero MediaBox origins; preserve page dimensions/rotation and translate body, annotations and destinations together. CJK extraction comparisons use Unicode NFKC.',
                'reference': 'evidence/export-settings-reference.json',
                'sourceSHA256': hashlib.sha256((ROOT / 'native/PDFExportOptions.swift').read_bytes()).hexdigest()}
    if EVIDENCE.exists():
        previous=json.loads(EVIDENCE.read_text())
        if previous.get('harness'): evidence['harness']=previous['harness']
    with tempfile.TemporaryDirectory(prefix='pdf-export-options-', dir=cache) as folder_name:
        folder = Path(folder_name)
        (folder / 'Runner.swift').write_text(RUNNER)
        compiled = subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', '-target', platform.machine()+'-apple-macosx13.0', '-module-cache-path', str(cache/'swift'), str(ROOT/'native/PDFExportOptions.swift'), str(folder/'Runner.swift'), '-o', str(folder/'verify'), '-framework','AppKit','-framework','PDFKit'], cwd=ROOT, capture_output=True, text=True, timeout=90)
        evidence['compiler']={'passed':compiled.returncode==0,'diagnostics':compiled.stderr}
        if compiled.returncode==0:
            generated=subprocess.run([str(folder/'verify'),str(folder),'generate'],cwd=ROOT,capture_output=True,text=True,timeout=30)
            if generated.returncode != 0:
                raise RuntimeError('Real CoreGraphics source generation failed: '+generated.stderr[-1500:])
            from pypdf import PdfReader, PdfWriter
            from pypdf.generic import RectangleObject, DictionaryObject, NameObject, TextStringObject, ArrayObject, FloatObject, Fit
            from pypdf.annotations import Link
            writer=PdfWriter(clone_from=folder/'source.pdf')
            page=writer.pages[1]
            page.mediabox=RectangleObject([13,17,513,717])
            page.cropbox=RectangleObject([13,17,513,717])
            page.rotate(90)
            writer.add_annotation(0,DictionaryObject({NameObject('/Type'):NameObject('/Annot'),NameObject('/Subtype'):NameObject('/Link'),NameObject('/Rect'):RectangleObject([60,200,180,220]),NameObject('/A'):DictionaryObject({NameObject('/S'):NameObject('/URI'),NameObject('/URI'):TextStringObject('https://example.com/pdf-link')})}))
            writer.add_annotation(0,Link(rect=(60,230,180,250),target_page_index=1,fit=Fit.xyz(left=100,top=500,zoom=1.25)))
            writer.add_outline_item('Second 中文',1,fit=Fit.xyz(left=100,top=500,zoom=1.25))
            with (folder/'source-prepared.pdf').open('wb') as stream:
                writer.write(stream)
            (folder/'source-prepared.pdf').replace(folder/'source.pdf')
            result=subprocess.run([str(folder/'verify'),str(folder)],cwd=ROOT,capture_output=True,text=True,timeout=45)
            evidence['execution']={'returnCode':result.returncode,'stderr':result.stderr[-2500:]}
            if (folder/'result.json').exists():
                evidence['actualPDF']=json.loads((folder/'result.json').read_text())
                if evidence['actualPDF']['passed']:
                    decoded=PdfReader(folder/'decorated.pdf')
                    url_ok=False; go_ok=False
                    for item in decoded.pages[0].get('/Annots',[]):
                        annotation=item.get_object();action=annotation.get('/A',{})
                        if action.get('/S')=='/URI': url_ok=action.get('/URI')=='https://example.com/pdf-link'
                        destination=annotation.get('/Dest') or action.get('/D')
                        if isinstance(destination,list) and len(destination)>=5:
                            go_ok=destination[0].idnum==decoded.pages[1].indirect_reference.idnum and list(map(float,destination[2:5]))==[87.0,483.0,1.25]
                    outline=decoded.outline[0]
                    outline_ok=outline.title=='Second 中文' and decoded.get_destination_page_number(outline)==1 and float(outline.left)==87 and float(outline.top)==483
                    vector_only=all(len(page.images)==0 for page in decoded.pages)
                    evidence['independentPDFDecode']={'urlAnnotation':url_ok,'goToAnnotation':go_ok,'outline':outline_ok,'vectorBodyWithoutRasterImages':vector_only}
                    if not all(evidence['independentPDFDecode'].values()): evidence['actualPDF']['passed']=False
                    target=ROOT/'evidence/pdf-export-options-proof.pdf'
                    shutil.copyfile(folder/'decorated.pdf',target)
                    renderer=shutil.which('pdftoppm')
                    if renderer:
                        subprocess.run([renderer,'-scale-to','900','-png',str(target),str(ROOT/'evidence/pdf-export-options-proof')],check=True,capture_output=True,text=True,timeout=45)
                        subprocess.run([renderer,'-scale-to','900','-png',str(folder/'source.pdf'),str(folder/'source-proof')],check=True,capture_output=True,text=True,timeout=45)
                        from PIL import Image
                        geometry=[]
                        for number in (1,2):
                            before=Image.open(folder/f'source-proof-{number}.png').convert('RGB')
                            after=Image.open(ROOT/f'evidence/pdf-export-options-proof-{number}.png').convert('RGB')
                            def colored_box(image):
                                points=[(index%image.width,index//image.width) for index,(r,g,b) in enumerate(image.getdata()) if (r>170 and r-g>50 and r-b>50) or (g>120 and g-r>50 and g-b>50)]
                                return [min(x for x,y in points),min(y for x,y in points),max(x for x,y in points),max(y for x,y in points)] if points else None
                            first,last=colored_box(before),colored_box(after)
                            geometry.append({'page':number,'passed':before.size==after.size and first is not None and last is not None and all(abs(a-b)<=1 for a,b in zip(first,last)),'sourceColoredBodyBounds':first,'outputColoredBodyBounds':last,'renderedSize':list(after.size)})
                        evidence['bodyVisualGeometry']=geometry
                        if not all(item['passed'] for item in geometry):
                            evidence['actualPDF']['passed']=False
                    evidence['proofPDF']=str(target)
                    evidence['renderedPages']=sorted(str(p) for p in (ROOT/'evidence').glob('pdf-export-options-proof-*.png'))
            else:
                evidence['actualPDF']={'passed':False,'blocked':True,'reason':'Native CLI did not produce a result. No synthetic PDF correctness is claimed.'}
    EVIDENCE.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(evidence,ensure_ascii=False,indent=2))
    return 0 if evidence.get('actualPDF',{}).get('passed') else 1

if __name__=='__main__':
    raise SystemExit(main())
