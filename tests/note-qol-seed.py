"""Seed only the isolated recording server on port 47891 with fictional demo data."""
import io
import json
import pathlib
import urllib.request
from PIL import Image, ImageDraw, ImageFont

BASE = 'http://127.0.0.1:47891'

def api(path, value=None, method=None, raw=None):
    data = raw if raw is not None else json.dumps(value).encode() if value is not None else None
    request = urllib.request.Request(BASE + path, data=data, method=method,
        headers={'Content-Type': 'application/octet-stream' if raw is not None else 'application/json', 'Origin': BASE})
    return json.load(urllib.request.urlopen(request))

expected=pathlib.Path(__file__).resolve().parents[1]/'target/note-qol-recording/data'
if pathlib.Path(api('/api/settings')['data_dir']).resolve()!=expected.resolve():
    raise SystemExit('Refusing to seed a server outside the isolated recording data directory.')

api('/api/library/rename', {'target':'L1','name':'Research notebook'})
notes = api('/api/notes?target=L1')
note = api('/api/notes/L1/'+notes[0]['id']) if notes else api('/api/notes',{'target':'L1','title':'Understanding latent dynamics'})
note['title']='Understanding latent dynamics'
note['blocks'] = [
    {'id':'intro','type':'text','src':r'\section{Research question}'+'\nHow can a compact representation preserve the dynamics needed for prediction?\n\n'+r'We study a linear latent model $z_{t+1}=Az_t+Bu_t$.'},
    {'id':'method','type':'text','src':r'\section{Working notes}'+'\nCompare prediction error across horizons and inspect where the model loses fine detail.\n\n'+r'\[\mathcal{L}=\frac{1}{T}\sum_{t=1}^{T}\|\hat z_t-z_t\|^2\]'},
]
api('/api/notes/L1/'+note['id'], note, 'PUT')
image = Image.new('RGB', (1000,440), '#181b25'); draw = ImageDraw.Draw(image)
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',27)
small = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',21)
draw.text((50,45),'A compact predictive model',font=font,fill='#f0edf6')
for x,label in [(50,'Observation'),(380,'Encoder'),(710,'Latent state')]:
    draw.rounded_rectangle((x,155,x+240,265),radius=18,fill='#292b45',outline='#9587ff',width=3)
    draw.text((x+25,192),label,font=font,fill='#f0edf6')
for x in [305,635]:
    draw.line((x,210,x+55,210),fill='#9587ff',width=4)
    draw.polygon([(x+55,210),(x+43,201),(x+43,219)],fill='#9587ff')
draw.text((50,340),'Fictional research diagram for the Noctua feature demo',font=small,fill='#b3b3c8')
buffer=io.BytesIO();image.save(buffer,format='PNG')
m=api('/api/workspaces/L1')
if not any(e['name']=='latent-model.png' and not e.get('deleted') for e in m['entries']):
    api('/api/workspaces/L1/upload?name=latent-model.png&revision='+str(m['revision']),raw=buffer.getvalue())
# A small selectable-text PDF, created locally; no network paper download.
lines=[('Learning compact latent dynamics',54,735,22),('Fictional paper for the Noctua feature demonstration',54,705,11),('Abstract',54,660,16),('A compact latent representation can preserve useful dynamics.',54,630,12),('We compare prediction error across multiple planning horizons.',54,610,12),('1  Method',54,550,16),('The encoder maps each observation into a latent state.',54,520,12),('A linear predictor estimates the next state from the current input.',54,500,12),('2  Interpretation',54,440,16),('Prediction error grows when the representation loses fine detail.',54,410,12),('Annotation comments can connect this passage to a mathematical model.',54,390,12)]
stream='\n'.join(f'BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET' for text,x,y,size in lines)
objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',f'<< /Length {len(stream)} >>\nstream\n{stream}\nendstream']
pdf='%PDF-1.7\n'; offsets=[]
for i,obj in enumerate(objects,1): offsets.append(len(pdf));pdf+=f'{i} 0 obj\n{obj}\nendobj\n'
xref=len(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+''.join(f'{x:010d} 00000 n \n' for x in offsets)+f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'
if not api('/api/library/items?target=L1'):
    api('/api/library/import-pdf?target=L1&name=Learning%20compact%20latent%20dynamics.pdf',raw=pdf.encode())
print('Seeded isolated notes, media, and fictional PDF.')
