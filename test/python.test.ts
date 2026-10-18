// Python 분석기 검증: 예제 프로젝트(py-django·py-flask·py-fastapi)와 작은 인라인 프로젝트
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
  if (!existsSync(root)) execFileSync('python3', [join(FIX, 'gen_python.py'), FIX]);
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

function mem(name: string, files: Record<string, string>): SourceFile[] {
  const enc = new TextEncoder();
  return Object.entries(files).map(([p, text]) => {
    const bytes = enc.encode(text.replace(/^\n/, ''));
    return { path: `${name}/${p}`, size: bytes.length, bytes };
  });
}

function screenOf(r: AnalysisResult, url: string, kind: 'page' | 'api') {
  const s = r.screens.find((x) => x.urls.includes(url) && (kind === 'api') === (x.kind === 'api'));
  assert.ok(s, `${kind} 없음: ${url} (있는 것: ${r.screens.map((x) => `${x.kind}:${x.url}`).join(', ')})`);
  return s;
}
const tableMap = (ts: { table: string; crud: string[] }[]) => Object.fromEntries(ts.map((t) => [t.table, t.crud.join('')]));
const crud = (r: AnalysisResult, url: string) => tableMap(screenOf(r, url, 'page').tables);
const apis = (r: AnalysisResult) => r.screens.filter((s) => s.kind === 'api').map((s) => s.name).sort();
function api(r: AnalysisResult, name: string) {
  const s = r.screens.find((x) => x.kind === 'api' && x.name === name);
  assert.ok(s, `API 없음: ${name} (있는 것: ${apis(r).join(', ')})`);
  return tableMap(s.tables);
}
const batch = (r: AnalysisResult, name: string) => {
  const b = r.batches.find((x) => x.name === name);
  assert.ok(b, `배치 없음: ${name} (있는 것: ${r.batches.map((x) => x.name).join(', ')})`);
  return b;
};

test('Django: include·app_name·namespace, 함수 뷰·제네릭 클래스 뷰, ModelForm, 서비스의 SQL 상수, 템플릿 {% url %}', async () => {
  const r = await analyze(loadDir('py-django'), { projectName: 'py-django' });
  assert.ok(r.databases.some((d) => d.type === 'MySQL' && d.access.includes('Django ORM')));
  assert.ok(r.project.title.startsWith('Django 기반'));
  assert.deepEqual(crud(r, '/blog/'), { blog_post: 'R' });
  // get_object_or_404 + 댓글 폼 저장(form.save(commit=False) → save) + 삭제 폼·게시 링크(리다이렉트만 하는 처리)
  assert.deepEqual(crud(r, '/blog/post/{pk}/'), { blog_post: 'RUD', tb_comment: 'C' });
  // 제네릭 클래스 뷰: CreateView C, UpdateView RU, ListView R (기본 템플릿 <앱>/<모델>_list.html)
  assert.deepEqual(crud(r, '/blog/post/new/'), { blog_post: 'C' });
  assert.deepEqual(crud(r, '/blog/post/{pk}/edit/'), { blog_post: 'RU' });
  assert.deepEqual(crud(r, '/blog/categories/'), { blog_category: 'R' });
  assert.ok(r.files.find((f) => f.id === screenOf(r, '/blog/categories/', 'page').view)?.path.endsWith('blog/templates/blog/category_list.html'));
  // services.category_stats() 의 모듈 상수 SQL (JOIN)
  assert.deepEqual(crud(r, '/blog/stats/'), { blog_category: 'R', blog_post: 'R' });
  // TemplateView.as_view(template_name=…)
  assert.deepEqual(crud(r, '/'), {});
  const detail = screenOf(r, '/blog/post/{pk}/', 'page');
  assert.equal(detail.name, '글 보기');
  assert.ok(detail.calls.some((c) => c.url === '/blog/post/{pk}/delete/' && c.kind === 'form'));
  assert.deepEqual(detail.flow.slice(0, 2).map((s) => s.layer), ['VIEW', 'CONTROLLER']);
  // 레이아웃·조각(base.html, includes/sidebar.html)은 화면이 아님
  assert.equal(r.screens.filter((s) => s.kind !== 'api').length, 8);
  assert.equal(r.tables.find((t) => t.name === 'blog_post')?.comment, '게시글');
  // 사이드바 템플릿의 {% url %} 를 풀어 메뉴로
  assert.deepEqual(r.menus.map((m) => `${m.name} ${m.url}`), ['글 목록 /blog/', '분류 /blog/categories/', '상품 /shop/']);
});

test('Django REST framework: 라우터 register·ViewSet 액션·@action·@api_view·커스텀 매니저', async () => {
  const r = await analyze(loadDir('py-django'), { projectName: 'py-django' });
  // 화면이 fetch 로 @api_view, 링크로 라우터 목록 URL({% url 'shop:order-list' %})을 부름
  assert.deepEqual(crud(r, '/shop/'), { shop_product: 'R', tb_order: 'R' });
  assert.deepEqual(apis(r), [
    'DELETE /shop/api/products/{pk}/',
    'GET /shop/api/products/',
    'GET /shop/api/products/{pk}/',
    'PATCH /shop/api/products/{pk}/',
    'POST /shop/api/orders/',
    'POST /shop/api/orders/{pk}/cancel/',
    'POST /shop/api/products/',
    'PUT /shop/api/products/{pk}/',
  ]);
  assert.deepEqual(api(r, 'PUT /shop/api/products/{pk}/'), { shop_product: 'RU' });
  assert.deepEqual(api(r, 'DELETE /shop/api/products/{pk}/'), { shop_product: 'RD' });
  // serializer_class 의 Meta.model 로 모델을 앎
  assert.deepEqual(api(r, 'POST /shop/api/orders/'), { tb_order: 'C' });
  assert.deepEqual(api(r, 'POST /shop/api/orders/{pk}/cancel/'), { tb_order: 'U' });
});

test('Django 배치: crontab + pymysql 스크립트(docstring 제목·로그), manage.py 관리 명령', async () => {
  const r = await analyze(loadDir('py-django'), { projectName: 'py-django' });
  assert.equal(r.batches.length, 2);
  const settle = batch(r, '일별 정산');
  assert.equal(settle.schedule?.expr, '0 2 * * *');
  assert.deepEqual(tableMap(settle.tables), { tb_order: 'RD', tb_settle_daily: 'C' });
  assert.deepEqual(settle.logs, ['/var/log/shop/daily_settle.log']);
  const cleanup = batch(r, '빈 댓글 정리');
  assert.equal(cleanup.schedule?.expr, '30 3 * * *');
  assert.deepEqual(tableMap(cleanup.tables), { tb_comment: 'D' });
});

test('Flask: Blueprint 접두어(register_blueprint 가 덮어씀), url_for 엔드포인트, Flask-SQLAlchemy, MethodView, text() SQL', async () => {
  const r = await analyze(loadDir('py-flask'), { projectName: 'py-flask' });
  assert.ok(r.databases.some((d) => d.type === 'Oracle' && d.access.includes('SQLAlchemy')));
  assert.deepEqual(crud(r, '/'), { NOTICE: 'R' });
  // db.get_or_404 + 상세 화면 fetch DELETE → MethodView.delete (session.get + session.delete)
  assert.deepEqual(crud(r, '/notice/{notice_id}'), { NOTICE: 'RD', NOTICE_FILE: 'R' });
  assert.deepEqual(crud(r, '/notice/new'), { NOTICE: 'C' });
  // Blueprint url_prefix='/manage' 를 register_blueprint(url_prefix='/admin') 가 덮어씀, 서비스 객체 메서드의 select().join()
  assert.deepEqual(crud(r, '/admin/members'), { TB_MEMBER: 'RD', TB_ROLE: 'R' });
  assert.deepEqual(crud(r, '/admin/stats'), { TB_MEMBER_ROLE: 'R' });
  assert.equal(screenOf(r, '/admin/members', 'page').name, '회원 관리');
  assert.deepEqual(apis(r), ['GET /api/v1/notices', 'GET /api/v1/notices/{notice_id}', 'POST /api/v1/notices', 'PUT /api/v1/notices/{notice_id}']);
  assert.deepEqual(api(r, 'PUT /api/v1/notices/{notice_id}'), { NOTICE: 'U' });
  assert.equal(r.screens.filter((s) => s.kind !== 'api').length, 5);
  // 배치: cx_Oracle 스크립트만 (import 되는 jobs/common.py 는 배치가 아님)
  assert.deepEqual(r.batches.map((b) => b.name), ['ERP 회원 동기화']);
  const b = batch(r, 'ERP 회원 동기화');
  assert.equal(b.schedule?.expr, '0 1 * * *');
  assert.deepEqual(tableMap(b.tables), { ERP_USER: 'R', TB_MEMBER: 'U' });
});

test('FastAPI: APIRouter prefix + include_router(prefix=settings.X), SQLAlchemy 2.0 select·delete, SQLModel, TemplateResponse 화면', async () => {
  const r = await analyze(loadDir('py-fastapi'), { projectName: 'py-fastapi' });
  assert.ok(r.databases.some((d) => d.type === 'PostgreSQL' && d.access.includes('SQLAlchemy') && d.access.includes('SQLModel')));
  // 화면: select(func.count()).select_from(Item) + fetch 목록 API + url_for('read_heroes') 링크
  assert.deepEqual(crud(r, '/dashboard'), { hero: 'R', item_tags: 'R', items: 'R', tags: 'R' });
  assert.equal(screenOf(r, '/dashboard', 'page').name, '대시보드');
  assert.deepEqual(apis(r), ['DELETE /api/v1/items/{item_id}', 'GET /api/v1/items/{item_id}', 'PATCH /api/v1/heroes/{hero_id}', 'POST /api/v1/items/']);
  assert.deepEqual(api(r, 'POST /api/v1/items/'), { items: 'C' });
  assert.deepEqual(api(r, 'DELETE /api/v1/items/{item_id}'), { items: 'D' });
  assert.deepEqual(api(r, 'PATCH /api/v1/heroes/{hero_id}'), { hero: 'RU' });
  const post = r.screens.find((s) => s.name === 'POST /api/v1/items/')!;
  assert.deepEqual(post.flow.slice(0, 2).map((s) => s.layer), ['CONTROLLER', 'DAO']);
});

test('옛 Django: url() 정규식·include(namespace)·ROOT_URLCONF 없음, ViewSet.as_view({…}), trailing_slash=False 라우터, f-string SQL', async () => {
  const r = await analyze(
    mem('old-dj', {
      'proj/urls.py': `
from django.conf.urls import include, url

urlpatterns = [
    url(r'^api/', include('articles.urls', namespace='articles')),
]
`,
      'articles/models.py': `
from django.db import models


class Article(models.Model):
    slug = models.SlugField()

    class Meta:
        db_table = 'tb_article'
`,
      'articles/serializers.py': `
from rest_framework import serializers
from .models import Article


class ArticleSerializer(serializers.ModelSerializer):
    class Meta:
        model = Article
`,
      'articles/views.py': `
from django.db import connection
from rest_framework import generics, viewsets
from rest_framework.response import Response

from .models import Article
from .serializers import ArticleSerializer


class ArticleViewSet(viewsets.GenericViewSet):
    queryset = Article.objects.all()
    serializer_class = ArticleSerializer

    def list(self, request):
        return Response(self.serializer_class(self.get_queryset(), many=True).data)

    def create(self, request):
        serializer = self.serializer_class(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)


class TagViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Article.objects.all()


class ArticleDetail(generics.RetrieveDestroyAPIView):
    queryset = Article.objects.all()
    lookup_field = 'slug'


def archive(request, year):
    with connection.cursor() as cur:
        cur.execute(f"SELECT * FROM tb_article_archive WHERE year = {year} AND id > %s", [0])
    return Response([])
`,
      'articles/urls.py': `
from django.conf.urls import include, url
from rest_framework.routers import DefaultRouter

from .views import ArticleDetail, ArticleViewSet, TagViewSet, archive

router = DefaultRouter(trailing_slash=False)
router.register(r'tags', TagViewSet)

urlpatterns = [
    url(r'^', include(router.urls)),
    url(r'^articles/?$', ArticleViewSet.as_view({'get': 'list', 'post': 'create'})),
    url(r'^articles/(?P<slug>[-\\w]+)/?$', ArticleDetail.as_view()),
    url(r'^archive/(?P<year>[0-9]{4})/$', archive, name='archive'),
]
`,
    }),
    { projectName: 'old-dj' },
  );
  assert.deepEqual(apis(r), [
    '/api/archive/{year}/', 'DELETE /api/articles/{slug}', 'GET /api/articles', 'GET /api/articles/{slug}', 'GET /api/tags', 'GET /api/tags/{pk}', 'POST /api/articles',
  ]);
  assert.deepEqual(api(r, 'GET /api/articles'), { tb_article: 'R' });
  assert.deepEqual(api(r, 'POST /api/articles'), { tb_article: 'C' });
  assert.deepEqual(api(r, 'DELETE /api/articles/{slug}'), { tb_article: 'RD' });
  // f-string 의 {식}·%s 자리표시자
  assert.deepEqual(api(r, '/api/archive/{year}/'), { tb_article_archive: 'R' });
  assert.ok(r.sql.some((s) => s.text === 'SELECT * FROM tb_article_archive WHERE year = ${v} AND id > ${v}'));
});

test('스케줄만 있는 파이썬 실행(python x.py): 대상 파일의 SQL 테이블을 배치에 붙임', async () => {
  const r = await analyze(
    mem('cron-py', {
      'ops/crontab': `
0 5 * * 1 /usr/bin/python3 /opt/tools/weekly_report.py
`,
      'tools/weekly_report.py': `
import psycopg2

conn = psycopg2.connect("dbname=sales")
cur = conn.cursor()
cur.execute("SELECT region, SUM(amount) FROM tb_sales GROUP BY region")
cur.execute("INSERT INTO tb_report (body) VALUES (%s)", ["x"])
`,
    }),
    { projectName: 'cron-py' },
  );
  assert.equal(r.batches.length, 1);
  const b = r.batches[0];
  assert.equal(b.kind, 'python');
  assert.equal(b.schedule?.expr, '0 5 * * 1');
  assert.deepEqual(tableMap(b.tables), { tb_report: 'C', tb_sales: 'R' });
});
