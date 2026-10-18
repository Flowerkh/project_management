"""화면 점검용 스크린샷: python3 scripts/ui-shots.py [이름 ...]
dist/web/project-analyzer.html 을 file:// 로 열어 ?mock=1 상태별로 1440×900 캡처 → dist/shots/*.png
레이아웃 문제(가로 넘침·잘린 글자)를 콘솔에 함께 출력한다."""
import os
import sys

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
HTML = os.path.join(ROOT, 'dist', 'web', 'project-analyzer.html')
OUT = os.path.join(ROOT, 'dist', 'shots')
FONTS = '/tmp/claude-0/-home-claude/6d747a07-d1a7-516e-a9ca-80b6c0690766/scratchpad/fonts/node_modules/@fontsource'

SHOTS = {
    'home': '?mock=1&phase=home',
    'confirm': '?mock=1&phase=confirm',
    'running': '?mock=1&phase=running',
    'summary': '?mock=1',
    'screen': '?mock=1&view=screen:S022',
    'table': '?mock=1&view=table:T017',
    'menu': '?mock=1&view=menu:M0300',
    'batch': '?mock=1&view=batch:B001',
    'pop-lang': '?mock=1&pop=lang',
    'pop-db': '?mock=1&pop=db',
    'settings': '?mock=1&modal=settings',
    'viewer': '?mock=1&view=screen:S022',
    'search': '?mock=1',
    # 데스크톱 기능 (가짜 메인 프로세스)
    'desk-home': '?mock=1&desk&phase=home',
    'desk-screen': '?mock=1&desk&view=screen:S022',
    'desk-chat': '?mock=1&desk&chat&view=screen:S022',
    'desk-project': '?mock=1&desk&dmodal=project',
    'desk-claude': '?mock=1&desk&dmodal=claude',
    'desk-changes': '?mock=1&desk&view=changes:W1',
    'desk-history': '?mock=1&desk&view=history',
}

CHECK_JS = r"""
() => {
  const out = [];
  const W = document.documentElement.clientWidth;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.right > W + 1 && !el.closest('.code') && !el.closest('.flow') && !el.closest('.tbl-wrap')) out.push('넘침: ' + el.tagName + '.' + el.className + ' ' + (el.textContent || '').trim().slice(0, 40));
  }
  if (document.documentElement.scrollWidth > W + 1) out.push('가로 스크롤 ' + document.documentElement.scrollWidth);
  return out.slice(0, 15);
}
"""


def font_css():
    css = ''
    for fam, ws in (('ibm-plex-sans-kr', (400, 500, 600, 700)), ('ibm-plex-mono', (400, 500, 600))):
        for w in ws:
            p = os.path.join(FONTS, fam, f'{w}.css')
            if os.path.exists(p):
                css += open(p, encoding='utf-8').read().replace('url(./files/', f'url(file://{FONTS}/{fam}/files/')
    return css


def main(names):
    os.makedirs(OUT, exist_ok=True)
    fcss = font_css()
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        for n in names:
            errors.clear()
            pg.goto('file://' + HTML + SHOTS[n])
            if fcss:
                pg.add_style_tag(content=fcss)
            pg.wait_for_timeout(350)
            if n == 'viewer':
                pg.click('text=OrderMapper.xml')
                pg.wait_for_timeout(400)
            if n == 'search':
                pg.fill('input[aria-label="트리 검색"]', 'order')
                pg.wait_for_timeout(250)
            pg.evaluate('document.fonts.ready')
            issues = pg.evaluate(CHECK_JS)
            shot = os.path.join(OUT, f'{n}.png')
            pg.screenshot(path=shot)
            print(n, '->', shot)
            for i in issues:
                print('   ', i)
            for e in errors:
                print('   ERROR', e)
        b.close()


if __name__ == '__main__':
    args = sys.argv[1:] or list(SHOTS)
    main(args)
