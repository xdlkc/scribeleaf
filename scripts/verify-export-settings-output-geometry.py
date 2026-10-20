#!/usr/bin/env python3
"""Independently decode the real native QA outputs; do not create a PDF.

Use the bundled Python runtime (pypdf, pdfplumber, Pillow and NumPy).
The clip check targets this app's generated PDF structure, not arbitrary PDFs.
"""
from pathlib import Path
import datetime
import hashlib
import json
import logging
import numpy as np
from PIL import Image
from pypdf import PdfReader
import pdfplumber

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.cache/export-settings-native-verifier'
OUT = WORK / 'output'
result = json.loads((WORK / 'result.json').read_text())
checks = []
diagnostics = []

class Capture(logging.Handler):
    def emit(self, record):
        diagnostics.append(record.getMessage())

logging.getLogger('pypdf').addHandler(Capture())

def check(name, passed, **detail):
    checks.append({'name': name, 'passed': bool(passed), 'detail': detail})

png = np.asarray(Image.open(OUT / 'image.png').convert('RGB')).astype(int)
mask = (np.max(np.abs(png - np.array([27, 111, 90])), axis=2) <= 1) | (np.max(np.abs(png - np.array([238, 177, 37])), axis=2) <= 1)
y, x = np.where(mask)
box = [int(x.min()), int(y.min()), int(x.max() + 1), int(y.max() + 1)] if len(x) else []
check('Native PNG has 320 CSS px at quality2', png.shape[1] == 640, dimensions=[png.shape[1], png.shape[0]])
check('The fixed 100 CSS px image is 200 physical px', bool(box) and abs(box[2] - box[0] - 200) <= 1, pixelBox=box, sourceColors=[[27, 111, 90], [238, 177, 37]], pixelTolerance=1)

pdf = OUT / 'custom.pdf'
reader = PdfReader(pdf)
pages = []
mm = 72 / 25.4
for index, page in enumerate(reader.pages):
    width, height = float(page.mediabox.width), float(page.mediabox.height)
    text = page.extract_text()
    check(f'PDF page {index+1} paper is landscape 210x148mm', abs(width-210*mm) <= 1 and abs(height-148*mm) <= 1 and width > height, points=[width,height], tolerancePoints=1)
    check(f'PDF page {index+1} header, author and page number are present', 'QA_PDF_HEADER QA_AUTHOR' in text and f'QA_PDF_FOOTER {index+1}' in text)
    operations = page.get_contents().operations
    candidates = [(i, a) for i, (a, b) in enumerate(operations[:-1]) if b == b're' and operations[i+1][1] in [b'W', b'W*']]
    clip = None
    if candidates:
        position, values = candidates[0]
        if not any(b == b'cm' for _, b in operations[:position]):
            clip = [float(v) for v in values]
    expected = [13*mm,12*mm,width-(13+14)*mm,height-(11+12)*mm]
    error = [abs(a-b) for a,b in zip(clip,expected)] if clip else []
    check(f'PDF page {index+1} body clip consumes all four custom margins', bool(error) and max(error) <= 1.2, actualClip=clip, expectedClip=expected, errorsPoints=error, tolerancePoints=1.2)
    pages.append({'page':index+1,'points':[width,height],'bodyClip':clip,'text':text})
text = '\n'.join(p['text'] for p in pages)
check('PDF contains first and last body markers', 'QA_PDF_TOP' in text and 'QA_PDF_BOTTOM' in text)
with pdfplumber.open(pdf) as doc:
    for index, page in enumerate(doc.pages):
        words = page.extract_words()
        header = [w for w in words if w['text'] in ['QA_PDF_HEADER','QA_AUTHOR']]
        footer = [w for w in words if w['text'] == 'QA_PDF_FOOTER']
        body = [w for w in words if w['top'] > 11*mm and w['bottom'] < page.height-12*mm]
        check(f'PDF page {index+1} header and footer lie in separate margin bands', len(header)==2 and len(footer)==1 and max(w['bottom'] for w in header)<11*mm and min(w['top'] for w in footer)>page.height-12*mm)
        pages[index]['bodyWordBounds'] = [min(w['x0'] for w in body),min(w['top'] for w in body),max(w['x1'] for w in body),max(w['bottom'] for w in body)] if body else []

report = {'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bundleIdentifier':result['bundleIdentifier'],'checks':checks,'passed':all(c['passed'] for c in checks),'pages':pages,'pypdfDiagnostics':diagnostics,'sourceHashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [pdf,OUT/'image.png']},'scope':'Independent decode of real native QA artifacts. Four custom margins are checked on the first body clip, with point rounding tolerance; header/footer positions and body markers are decoded independently. PNG fixed-image size comes from its unique source color pattern. This is not Typora pixel parity or general PDF conformance.'}
(ROOT/'evidence/export-settings-output-geometry-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
for c in checks:
    print(('PASS ' if c['passed'] else 'FAIL ')+c['name'])
raise SystemExit(0 if report['passed'] else 1)
