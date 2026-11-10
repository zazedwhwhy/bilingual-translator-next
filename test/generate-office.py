from pathlib import Path
import sys, zipfile
if len(sys.argv)>1: sys.path.insert(0,sys.argv[1])
from docx import Document
from pptx import Presentation
from pptx.util import Inches
from openpyxl import Workbook
import xlsxwriter
root=Path(__file__).parent/'fixtures'/'documents';root.mkdir(parents=True,exist_ok=True)
doc=Document();doc.add_heading('Document translation',0);doc.add_paragraph('Hello from a Word paragraph.');doc.add_table(rows=1,cols=1).cell(0,0).text='A table cell.';doc.sections[0].header.paragraphs[0].text='Document header';doc.sections[0].footer.paragraphs[0].text='Document footer';doc.save(root/'sample.docx')
prs=Presentation();slide=prs.slides.add_slide(prs.slide_layouts[5]);slide.shapes.title.text='Slide one';slide.shapes.add_textbox(Inches(1),Inches(2),Inches(6),Inches(1)).text_frame.text='A presentation paragraph.';slide.notes_slide.notes_text_frame.text='Speaker notes.';slide2=prs.slides.add_slide(prs.slide_layouts[5]);slide2.shapes.title.text='Slide two';prs.save(root/'sample.pptx')
book=xlsxwriter.Workbook(str(root/'sample.xlsx'));sheet=book.add_worksheet('Data');fmt=book.add_format({'bold':True,'font_color':'#226633'});sheet.write('A1','Hello spreadsheet',fmt);sheet.write('A2',123);sheet.write_formula('A3','=A2*2',None,246);sheet.write('B1','Hello spreadsheet');book.close()
book=Workbook();sheet=book.active;sheet['A1']='Inline string';sheet['A2']=42;sheet['A3']='=A2+1';book.save(root/'inline.xlsx')
with zipfile.ZipFile(root/'sample.epub','w') as z:
 z.writestr('mimetype','application/epub+zip',compress_type=zipfile.ZIP_STORED)
 z.writestr('META-INF/container.xml','<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
 z.writestr('OPS/book.opf','<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test</dc:identifier><dc:title>Fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="two"/><itemref idref="one"/></spine></package>')
 for name,text in [('one','First chapter.'),('two','Second chapter comes first in spine.')]:z.writestr('OPS/'+name+'.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><head><title>'+name+'</title></head><body><p>'+text+'</p></body></html>')
(root/'sample.txt').write_text('First text paragraph.\n\nSecond text paragraph.',encoding='utf8')
(root/'sample.md').write_text('# Markdown title\n\nA Markdown paragraph.\n\n```js\nconst code=1;\n```',encoding='utf8')
(root/'sample.html').write_text('<!doctype html><html><head><title>Fixture</title></head><body><p onclick="alert(1)">Hello HTML.</p><script>window.malicious=true</script><img src="https://example.invalid/tracker"></body></html>',encoding='utf8')
print(root)
