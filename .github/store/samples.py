"""Builds the sample documents used for Store screenshots (all content is synthetic)."""
import io, math, os, random, sys
from PIL import Image, ImageDraw, ImageFilter
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.lib.colors import HexColor, white

OUT = sys.argv[1] if len(sys.argv) > 1 else 'samples'
os.makedirs(OUT, exist_ok=True)
PAL = [('#1C3D6E', '#F2A65A', '#2F6B5E'), ('#2B2D5E', '#F28C8C', '#4B3F72'), ('#0F4C5C', '#FFD166', '#2E7D6B'),
       ('#3A2E5C', '#FF9F68', '#5B3A6B'), ('#14394D', '#9AD1D4', '#1F5F5B'), ('#4A2C2A', '#F6C177', '#7A4B3A')]

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
def hx(h): h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

def landscape_img(w, h, seed):
    random.seed(seed)
    sky1, sun, land = [hx(c) for c in PAL[seed % len(PAL)]]
    sky2 = lerp(sky1, (255, 214, 170), .75)
    im = Image.new('RGB', (w, h)); d = ImageDraw.Draw(im)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(sky1, sky2, min(1, y / (h * .62))))
    r = int(min(w, h) * .09); cx, cy = int(w * random.uniform(.25, .75)), int(h * .42)
    for k in range(6, 0, -1):
        d.ellipse([cx - r - k * 10, cy - r - k * 10, cx + r + k * 10, cy + r + k * 10], fill=lerp(sky2, sun, .12 * (7 - k)))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=sun)
    for layer in range(4):
        base = h * (.5 + layer * .1); col = lerp(lerp(sky1, land, .5 + layer * .15), (10, 14, 20), layer * .18)
        pts = [(0, h)]; x = 0
        while x <= w:
            pts.append((x, base - random.uniform(.02, .16) * h * (1 - layer * .2))); x += random.randint(w // 14, w // 6)
        pts += [(w, base), (w, h)]
        d.polygon(pts, fill=col)
    im = im.filter(ImageFilter.GaussianBlur(1))
    px = im.load()
    for _ in range(w * h // 6):
        x, y = random.randrange(w), random.randrange(h); c = px[x, y]; n = random.randint(-9, 9)
        px[x, y] = tuple(max(0, min(255, v + n)) for v in c)
    return im

def jpeg_reader(im, q=92):
    b = io.BytesIO(); im.save(b, 'JPEG', quality=q); b.seek(0); return ImageReader(b)

TEXT = ('Narrow streets lead down to the harbour, where fishing boats leave before sunrise. '
        'In the afternoon the old market fills with spices, fresh bread and the sound of music. '
        'Take the coastal path at dusk for the best views of the bay and the lighthouse.').split()

def para(c, x, y, width, lines, size=10.5, color='#3A3F47'):
    c.setFont('Helvetica', size); c.setFillColor(HexColor(color)); random.seed(lines * 7 + int(y))
    for i in range(lines):
        words = []; ln = 0
        while True:
            w = random.choice(TEXT); tw = c.stringWidth(' '.join(words + [w]), 'Helvetica', size)
            if tw > width * (0.72 if i == lines - 1 else 1): break
            words.append(w)
        c.drawString(x, y - i * size * 1.55, ' '.join(words)); ln += 1

def guide(path, heavy=False):
    W, H = A4; c = canvas.Canvas(path, pagesize=A4); c.setTitle('Coastal Towns Guide')
    titles = ['Coastal Towns', 'The Old Harbour', 'Mountain Villages', 'Markets & Food', 'Hidden Beaches', 'Getting Around']
    for i, ttl in enumerate(titles):
        img = landscape_img(2400 if heavy else 1200, 1500 if heavy else 760, i)
        if i == 0:
            c.drawImage(jpeg_reader(img, 95 if heavy else 88), 0, H * .36, W, H * .64)
            c.setFillColor(white); c.setFont('Helvetica-Bold', 44); c.drawString(44, H - 110, ttl)
            c.setFont('Helvetica', 16); c.drawString(46, H - 140, 'A travel guide · 2026 edition')
            para(c, 44, H * .30, W - 88, 9, 11)
        else:
            c.setFillColor(HexColor(PAL[i % 6][0])); c.rect(0, H - 12, W, 12, stroke=0, fill=1)
            c.setFillColor(HexColor('#15181D')); c.setFont('Helvetica-Bold', 30); c.drawString(44, H - 76, ttl)
            c.drawImage(jpeg_reader(img, 95 if heavy else 88), 44, H - 400, W - 88, 300)
            para(c, 44, H - 440, W - 88, 14)
            c.setFillColor(HexColor(PAL[i % 6][1])); c.roundRect(44, 70, W - 88, 120, 10, stroke=0, fill=1)
            c.setFillColor(HexColor('#15181D')); c.setFont('Helvetica-Bold', 14); c.drawString(62, 166, 'Tip')
            para(c, 62, 144, W - 124, 4, 10, '#15181D')
        c.showPage()
    c.save()

def slides(path):
    W, H = landscape(A4); c = canvas.Canvas(path, pagesize=(W, H))
    data = [('Quarterly Results', '#1B2A4A'), ('Revenue Growth', '#0E5A57'), ('Customer Survey', '#5A2A4A'), ('Next Steps', '#7A3B12')]
    for i, (ttl, bg) in enumerate(data):
        c.setFillColor(HexColor(bg)); c.rect(0, 0, W, H, stroke=0, fill=1)
        c.setFillColor(white); c.setFont('Helvetica-Bold', 40); c.drawString(54, H - 100, ttl)
        c.setFont('Helvetica', 16); c.drawString(56, H - 132, 'Team meeting · November 2026')
        random.seed(i)
        if i in (0, 1):
            for k in range(6):
                v = random.uniform(.3, 1) * (1 + k * .12); bh = 230 * v / 1.6
                c.setFillColor(HexColor(['#FFD166', '#06D6A0', '#4CC9F0', '#F78C6B', '#B8F2E6', '#FFB4A2'][k]))
                c.roundRect(80 + k * 110, 70, 70, bh, 6, stroke=0, fill=1)
        else:
            for k in range(4):
                c.setFillColor(HexColor('#FFFFFF')); c.setFillAlpha(.12); c.roundRect(56 + k * 182, 90, 160, 220, 14, stroke=0, fill=1)
                c.setFillAlpha(1); c.setFont('Helvetica-Bold', 34); c.drawString(76 + k * 182, 250, f'{random.randint(40, 98)}%')
                c.setFont('Helvetica', 12); c.drawString(76 + k * 182, 225, ['Satisfied', 'Returning', 'Recommend', 'On time'][k])
        c.showPage()
    c.save()

def invoice(path):
    W, H = A4; c = canvas.Canvas(path, pagesize=A4)
    c.setFillColor(HexColor('#D63B25')); c.rect(0, H - 120, W, 120, stroke=0, fill=1)
    c.setFillColor(white); c.setFont('Helvetica-Bold', 34); c.drawString(44, H - 78, 'INVOICE')
    c.setFont('Helvetica', 12); c.drawRightString(W - 44, H - 70, 'No. 2026-118'); c.drawRightString(W - 44, H - 88, '27 November 2026')
    c.setFillColor(HexColor('#15181D')); c.setFont('Helvetica-Bold', 12); c.drawString(44, H - 170, 'Bill to'); c.setFont('Helvetica', 11)
    for k, l in enumerate(['Northwind Studio', '12 Harbour Road', 'Seaside']): c.drawString(44, H - 188 - k * 16, l)
    y = H - 280; c.setFillColor(HexColor('#F1EFEA')); c.rect(44, y - 6, W - 88, 24, stroke=0, fill=1)
    c.setFillColor(HexColor('#15181D')); c.setFont('Helvetica-Bold', 11)
    for x, h in [(54, 'Description'), (360, 'Qty'), (420, 'Price'), (W - 54, 'Total')]: (c.drawRightString if h == 'Total' else c.drawString)(x, y, h)
    c.setFont('Helvetica', 11); items = [('Website design', 1, 1200), ('Photography', 2, 350), ('Printing', 300, 1.2), ('Consulting', 6, 90)]
    tot = 0
    for k, (d, q, p) in enumerate(items):
        yy = y - 30 - k * 26; c.drawString(54, yy, d); c.drawString(360, yy, str(q)); c.drawString(420, yy, f'{p:,.2f}'); c.drawRightString(W - 54, yy, f'{q * p:,.2f}'); tot += q * p
    c.setFont('Helvetica-Bold', 14); c.drawRightString(W - 54, y - 170, f'Total  {tot:,.2f}')
    c.showPage(); c.save()

guide(f'{OUT}/Coastal Towns Guide.pdf')
guide(f'{OUT}/Travel Photos.pdf', heavy=True)
slides(f'{OUT}/Team Meeting.pdf')
invoice(f'{OUT}/Invoice.pdf')
for k in range(3): landscape_img(1600, 1100, 10 + k).save(f'{OUT}/photo-{k + 1}.jpg', quality=90)
print('samples ok')
