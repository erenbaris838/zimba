"""Store screenshots for every UI language. env: APP (url), OUT (dir), SAMPLES (dir)."""
import asyncio, os
from playwright.async_api import async_playwright
APP = os.environ.get('APP', 'http://localhost:8765/')
OUT = os.environ.get('OUT', 'shots'); SM = os.environ.get('SAMPLES', 'samples')
LANGS = os.environ.get('LANGS', 'en,tr,de,es,fr,it,pt,ru,ja,zh').split(',')
LOCALE = {'en': 'en-US', 'tr': 'tr-TR', 'de': 'de-DE', 'es': 'es-ES', 'fr': 'fr-FR', 'it': 'it-IT', 'pt': 'pt-BR', 'ru': 'ru-RU', 'ja': 'ja-JP', 'zh': 'zh-CN'}
os.makedirs(OUT, exist_ok=True)
f = lambda *n: [f'{SM}/{x}' for x in n]

async def fresh(ctx, lang):
    pg = await ctx.new_page()
    await pg.goto(f'{APP}?lang={lang}')
    await pg.evaluate("localStorage.setItem('zimba.hint1','1')")
    await pg.reload(); await pg.wait_for_timeout(400)
    return pg

async def load(pg, files, n):
    await pg.set_input_files('#fileIn', files)
    await pg.wait_for_function(f'window.__zimba.S.pages.length >= {n}', timeout=60000)
    await pg.wait_for_function('[...document.querySelectorAll(".card img")].filter(i => !i.hidden && i.complete).length >= Math.min(12, document.querySelectorAll(".card").length)', timeout=60000)
    await pg.wait_for_timeout(500)

async def shoot(pg, lang, name):
    await pg.evaluate('document.querySelectorAll(".toast").forEach(t => t.remove())')
    await pg.screenshot(path=f'{OUT}/{lang}-{name}.png')

async def run(p, lang):
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={'width': 1280, 'height': 720}, device_scale_factor=1.5, locale=LOCALE[lang], accept_downloads=True, color_scheme='light')
    # 1 merge + drag to reorder
    pg = await fresh(ctx, lang)
    await load(pg, f('Coastal Towns Guide.pdf', 'Team Meeting.pdf', 'photo-1.jpg', 'photo-2.jpg', 'Invoice.pdf'), 13)
    cards = pg.locator('.card')
    await cards.nth(6).click(); await cards.nth(7).click()
    a = await cards.nth(10).bounding_box(); t = await cards.nth(3).bounding_box()
    await pg.mouse.move(a['x'] + a['width'] / 2, a['y'] + a['height'] / 2); await pg.mouse.down()
    await pg.mouse.move(a['x'] + 40, a['y'] + 30, steps=4)
    await pg.mouse.move(t['x'] + t['width'] * .78, t['y'] + t['height'] * .45, steps=12)
    await pg.wait_for_timeout(150)
    await shoot(pg, lang, '1-birlestir')
    await pg.mouse.up(); await pg.close()
    # 2 home
    pg = await fresh(ctx, lang); await pg.wait_for_timeout(300)
    await shoot(pg, lang, '2-araclar'); await pg.close()
    # 3 compress result
    pg = await fresh(ctx, lang)
    await load(pg, f('Travel Photos.pdf'), 6)
    await pg.click('#compBtn'); await pg.wait_for_selector('#dlg[open]')
    async with pg.expect_download(timeout=120000):
        await pg.click('#dlg [data-act=go]')
    await pg.wait_for_selector('#dlg .dlg-res:not([hidden])', timeout=60000)
    await pg.locator('#dlg [data-act=go]').blur()
    await shoot(pg, lang, '3-kucult'); await pg.close()
    # 4 split
    pg = await fresh(ctx, lang)
    await load(pg, f('Coastal Towns Guide.pdf', 'Team Meeting.pdf'), 10)
    await pg.click('#splitBtn'); await pg.wait_for_selector('#dlg[open]')
    await pg.click('#dlg input[name=ranges]'); await pg.type('#dlg input[name=ranges]', '1-6, 7-10', delay=10)
    await pg.locator('#dlg input[name=ranges]').evaluate('e => e.blur()')
    await shoot(pg, lang, '4-bol'); await pg.close()
    # 5 save with page numbers
    pg = await fresh(ctx, lang)
    await load(pg, f('photo-3.jpg', 'Coastal Towns Guide.pdf', 'photo-1.jpg'), 8)
    c = pg.locator('.card').nth(2); await c.hover(); await c.locator('[data-op=rotr]').click()
    await pg.mouse.move(5, 300)
    await pg.click('#saveBtn'); await pg.wait_for_selector('#dlg[open]')
    await pg.check('#dlg input[name=num]'); await pg.select_option('#dlg select[name=fmt]', 'of')
    await pg.locator('#dlg input[name=fname]').evaluate('e => e.blur()')
    await shoot(pg, lang, '5-numara'); await pg.close()
    await b.close()
    print(lang, 'done', flush=True)

async def main():
    async with async_playwright() as p:
        for lang in LANGS: await run(p, lang)
asyncio.run(main())
