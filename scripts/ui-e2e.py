"""실제 엔진으로 끝까지: python3 scripts/ui-e2e.py [폴더]
단일 HTML을 file:// 로 열고 폴더 선택 → 불러오기 확인 → Run → 결과 요약 → 화면·테이블 상세 → 소스 보기까지 캡처."""
import os
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
HTML = os.path.join(ROOT, 'dist', 'web', 'project-analyzer.html')
OUT = os.path.join(ROOT, 'dist', 'shots')
FOLDER = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'fixtures', 'shop-admin'))
TAG = os.path.basename(FOLDER.rstrip('/'))


def main():
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        pg.on('pageerror', lambda e: errors.append(f'pageerror: {e} {getattr(e, "stack", "")[:1500]}'))
        pg.on('console', lambda m: m.type == 'error' and errors.append(f'console: {m.text}'))
        pg.goto('file://' + HTML)
        pg.wait_for_timeout(300)
        with pg.expect_file_chooser() as fc:
            pg.click('button:has-text("폴더 선택")')
        fc.value.set_files(FOLDER)
        pg.wait_for_selector('text=불러오기 확인', timeout=20000)
        pg.wait_for_timeout(600)
        pg.screenshot(path=os.path.join(OUT, f'e2e-{TAG}-1-confirm.png'))
        t0 = time.time()
        pg.click('button:has-text("분석 시작")')
        pg.wait_for_timeout(250)
        pg.screenshot(path=os.path.join(OUT, f'e2e-{TAG}-2-running.png'))
        pg.wait_for_selector('text=분석 결과 요약', timeout=180000)
        print(f'analysis done in {time.time() - t0:.1f}s')
        pg.wait_for_timeout(500)
        pg.screenshot(path=os.path.join(OUT, f'e2e-{TAG}-3-summary.png'))
        counts = pg.evaluate("""() => [...document.querySelectorAll('.trow.cat')].map(r => r.innerText.replace(/\\s+/g,' '))""")
        print('tree:', counts)
        # 화면 상세: 트리 화면 그룹 첫 화면
        groups = pg.locator('.trow[data-key^="sg:"]')
        if groups.count():
            groups.first.click()
            pg.wait_for_timeout(200)
            scr = pg.locator('.trow[data-key^="s:"]')
            if scr.count():
                scr.nth(min(1, scr.count() - 1)).click()
                pg.wait_for_timeout(400)
                pg.screenshot(path=os.path.join(OUT, f'e2e-{TAG}-4-screen.png'))
                files = pg.locator('.tbl button.two')
                if files.count():
                    files.last.click()
                    pg.wait_for_timeout(700)
                    pg.screenshot(path=os.path.join(OUT, f'e2e-{TAG}-5-viewer.png'))
                    pg.keyboard.press('Escape')
        # 테이블 상세
        pg.click('.trow[data-key="cat:table"]')
        pg.wait_for_timeout(200)
        t = pg.locator('.trow[data-key^="t:"]')
        if t.count():
            t.nth(min(3, t.count() - 1)).click()
            pg.wait_for_timeout(400)
            pg.screenshot(path=os.path.join(OUT, f'e2e-{TAG}-6-table.png'))
        bt = pg.locator('.trow[data-key="cat:batch"]')
        if bt.count():
            bt.click()
            pg.wait_for_timeout(200)
            g = pg.locator('.trow[data-key^="bg:"]')
            if g.count():
                g.first.click()
                pg.wait_for_timeout(200)
                it = pg.locator('.trow[data-key^="b:"]')
                if it.count():
                    it.first.click()
                    pg.wait_for_timeout(400)
                    pg.screenshot(path=os.path.join(OUT, f'e2e-{TAG}-7-batch.png'))
        for e in errors[:20]:
            print('  ', e)
        b.close()


if __name__ == '__main__':
    main()
