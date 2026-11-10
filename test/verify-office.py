from pathlib import Path
import sys,json,zipfile
if len(sys.argv)>1:sys.path.insert(0,sys.argv[1])
from docx import Document
from pptx import Presentation
from openpyxl import load_workbook
folder=Path(sys.argv[2]);source=Path(__file__).parent/'fixtures'/'documents';checks=[]
doc=Document(folder/'sample-双语.docx');text='\n'.join(p.text for p in doc.paragraphs);assert 'Hello from a Word paragraph.' in text and 'MOCK' in text;assert 'MOCK' in doc.tables[0].cell(0,0).text;assert 'MOCK' in doc.sections[0].header.paragraphs[0].text;checks.append('DOCX reopens with original body/table/header and translations')
prs=Presentation(folder/'sample-双语.pptx');assert len(prs.slides)==2;slide=prs.slides[0];assert 'Slide one' in slide.shapes.title.text and 'MOCK' in slide.shapes.title.text;assert 'Speaker notes.' in slide.notes_slide.notes_text_frame.text and 'MOCK' in slide.notes_slide.notes_text_frame.text;checks.append('PPTX reopens with bilingual slide and speaker notes')
for name in ['sample','inline']:
 book=load_workbook(folder/(name+'-双语.xlsx'),data_only=False);sheet=book.active;assert 'MOCK' in sheet['A1'].value;assert isinstance(sheet['A2'].value,int);assert sheet['A3'].data_type=='f';assert sheet['A3'].value==('=A2*2' if name=='sample' else '=A2+1');checks.append(name+' XLSX reopens with bilingual string, numeric cell and formula intact')
with zipfile.ZipFile(source/'sample.xlsx') as before,zipfile.ZipFile(folder/'sample-双语.xlsx') as after:
 assert before.read('xl/worksheets/sheet1.xml')==after.read('xl/worksheets/sheet1.xml')
 assert before.read('xl/styles.xml')==after.read('xl/styles.xml');checks.append('Shared-string XLSX worksheet XML and styles preserved byte-for-byte')
with zipfile.ZipFile(folder/'sample-双语.epub') as book:
 assert book.infolist()[0].filename=='mimetype' and book.infolist()[0].compress_type==0
 for name in ['one','two']:assert 'MOCK' in book.read('OPS/'+name+'.xhtml').decode('utf8')
 checks.append('EPUB mimetype, native chapters and bilingual XHTML preserved')
text=(folder/'sample-双语.html').read_text('utf8');assert '<script' not in text and 'onclick=' not in text and 'example.invalid' not in text;assert 'MOCK' in text;checks.append('HTML output removes executable code and remote URL')
print(json.dumps({'checks':checks},ensure_ascii=False,indent=2))
