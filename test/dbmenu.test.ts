// DB 메뉴 테이블에서 읽은 메뉴를 엔진에 넣기 (AnalyzeOptions.dbMenus, 기획서 6.5)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { analyze } from '../src/engine/index';
import type { SourceFile } from '../src/engine/types';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'shop-admin');

function load(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const rec = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) rec(p);
      else out.push({ path: `shop-admin/${relative(root, p).split(sep).join('/')}`, size: st.size, bytes: new Uint8Array(readFileSync(p)) });
    }
  };
  rec(root);
  return out;
}

test('DB 메뉴가 있으면 DB 기준으로 메뉴를 만들고 소스와 다른 곳을 확인 필요에 넣는다', async () => {
  const base = await analyze(load(ROOT), { projectName: 'shop-admin' });
  const srcMenus = base.menus.filter((m) => m.source !== 'url-guess');
  assert.ok(srcMenus.length > 5, '소스 메뉴가 있어야 함');
  const top = srcMenus.find((m) => !m.parent && /주문/.test(m.name))!;
  const child = srcMenus.find((m) => m.parent === top.id && m.url)!;
  const rows = [
    { key: '100', parentKey: '0', name: top.name, order: 1 },
    { key: '101', parentKey: '100', name: child.name, url: child.url, order: 1 },
    { key: '102', parentKey: '100', name: 'DB에만 있는 메뉴', url: '/order/onlyInDb.do', order: 2 },
    { key: '102', parentKey: '100', name: '중복 키는 무시', url: '/dup.do' },
    { key: '103', parentKey: '999', name: '부모가 없으면 최상위', url: '/orphan.do' },
  ];
  const r = await analyze(load(ROOT), { projectName: 'shop-admin', dbMenus: { table: 'TB_MENU', rows } });
  assert.ok(r.menus.every((m) => m.source === 'db'), '메뉴는 DB 기준');
  assert.equal(r.menus.length, 4);
  const dbTop = r.menus.find((m) => m.name === top.name)!;
  const dbChild = r.menus.find((m) => m.name === child.name)!;
  assert.equal(dbChild.parent, dbTop.id);
  assert.ok(dbChild.screens.length > 0, 'URL로 화면 연결');
  assert.equal(r.menus.find((m) => m.name === '부모가 없으면 최상위')!.parent, undefined);
  assert.equal(dbTop.evidence?.text, 'TB_MENU');
  const mm = r.issues.find((i) => i.kind === 'menu-mismatch')!;
  assert.ok(mm, '차이 항목');
  assert.ok(mm.items.some((i) => i.ref === 'DB에만 있는 메뉴' && /DB에만/.test(i.note ?? '')));
  assert.ok(mm.items.some((i) => /소스에만/.test(i.note ?? '')));
});
