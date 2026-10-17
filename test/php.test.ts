// PHP 분석기 검증: Laravel·CodeIgniter 3·순수 PHP 예제 (fixtures/gen_php_go.py)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { analyze } from '../src/engine/index';
import type { AnalysisResult, SourceFile } from '../src/engine/types';

const FIX = join(import.meta.dirname, '..', 'fixtures');

function loadDir(name: string): SourceFile[] {
  const root = join(FIX, name);
  if (!existsSync(root)) execFileSync('python3', [join(FIX, 'gen_php_go.py'), FIX]);
  const out: SourceFile[] = [];
  const rec = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) rec(p);
      else {
        const bytes = new Uint8Array(readFileSync(p));
        out.push({ path: `${name}/${relative(root, p).split(sep).join('/')}`, size: bytes.length, bytes });
      }
    }
  };
  rec(root);
  return out;
}

function screenOf(r: AnalysisResult, url: string, kind: 'page' | 'api') {
  const s = r.screens.find((x) => x.urls.includes(url) && (kind === 'api') === (x.kind === 'api'));
  assert.ok(s, `${kind} 없음: ${url} (있는 것: ${r.screens.map((x) => `${x.kind}:${x.url}`).join(', ')})`);
  return s;
}
const crud = (r: AnalysisResult, url: string, kind: 'page' | 'api' = 'page') =>
  Object.fromEntries(screenOf(r, url, kind).tables.map((t) => [t.table, t.crud.join('')]));
const pages = (r: AnalysisResult) => r.screens.filter((s) => s.kind !== 'api').map((s) => s.url).sort();
const apis = (r: AnalysisResult) => r.screens.filter((s) => s.kind === 'api').map((s) => s.name).sort();

test('Laravel: 라우트 그룹·resource, 컨트롤러 → 서비스 → Eloquent, Blade 화면', async () => {
  const r = await analyze(loadDir('php-laravel'), { projectName: 'php-laravel' });
  assert.ok(r.project.title.includes('Laravel'));
  assert.ok(r.databases.some((d) => d.type === 'MySQL' && d.access.includes('Eloquent')));
  assert.deepEqual(pages(r), ['/', '/about', '/admin/orders', '/admin/orders/{order}', '/admin/products', '/admin/products/create']);
  assert.deepEqual(crud(r, '/'), { orders: 'R' });
  assert.deepEqual(crud(r, '/admin/orders'), { orders: 'R', users: 'R' });
  // 상세: 관계(items)·서비스의 이력·알림 등록, 상태 변경 폼(PUT)
  assert.deepEqual(crud(r, '/admin/orders/{order}'), { notifications: 'C', order_histories: 'C', order_items: 'R', orders: 'RU' });
  assert.deepEqual(crud(r, '/admin/products'), { categories: 'R', products: 'RD' });
  assert.deepEqual(crud(r, '/admin/products/create'), { categories: 'R', products: 'C' });
  assert.deepEqual(crud(r, '/about'), {});
  // PUT 과 짝인 PATCH(같은 메서드)는 API 로 따로 나오지 않음
  assert.deepEqual(apis(r), ['GET /health', 'POST /api/orders/{order}/status']);
  assert.equal(screenOf(r, '/admin/orders', 'page').name, '주문 목록');
  // 마이그레이션 주석이 테이블 설명으로
  assert.ok(r.tables.find((t) => t.name === 'orders')?.columns.length);
});

test('CodeIgniter 3: 기본 라우트(/컨트롤러/메서드), load->model 별칭, 쿼리 빌더', async () => {
  const r = await analyze(loadDir('php-ci3'), { projectName: 'php-ci3' });
  assert.ok(r.project.title.includes('CodeIgniter'));
  assert.deepEqual(crud(r, '/dashboard'), { orders: 'R' });
  assert.deepEqual(crud(r, '/order'), { members: 'R', orders: 'R' });
  assert.deepEqual(crud(r, '/order/detail'), { members: 'R', order_history: 'C', orders: 'RU' });
  assert.deepEqual(apis(r), []);
});

test('순수 PHP: 페이지 = URL, include 공통 파일, $sql .= 누적, ajax, EUC-KR', async () => {
  const r = await analyze(loadDir('php-plain'), { projectName: 'php-plain' });
  assert.deepEqual(pages(r), ['/index.php', '/order/list.php', '/order/view.php']);
  assert.deepEqual(crud(r, '/index.php'), { orders: 'R' });
  assert.deepEqual(crud(r, '/order/list.php'), { customers: 'R', orders: 'R' });
  assert.deepEqual(crud(r, '/order/view.php'), { customers: 'R', order_items: 'R', order_logs: 'C', orders: 'RU' });
  // EUC-KR 파일의 제목도 읽힘
  assert.equal(screenOf(r, '/order/list.php', 'page').name, '주문 목록');
  assert.ok(r.files.some((f) => f.encoding === 'euc-kr'));
});
