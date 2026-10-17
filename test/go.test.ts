// Go 분석기 검증: 예제 프로젝트(go-gin·go-nethttp·go-chi)와 작은 인라인 프로젝트(Echo·Fiber·gorilla/mux)
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
const crud = (r: AnalysisResult, url: string, kind: 'page' | 'api' = 'page') =>
  Object.fromEntries(screenOf(r, url, kind).tables.map((t) => [t.table, t.crud.join('')]));
const apis = (r: AnalysisResult) => r.screens.filter((s) => s.kind === 'api').map((s) => s.name).sort();

test('Gin + GORM: 그룹 접두어, 인라인 핸들러, TableName, Preload, 화면 fetch', async () => {
  const r = await analyze(loadDir('go-gin'), { projectName: 'go-gin' });
  assert.ok(r.databases.some((d) => d.type === 'MySQL' && d.access.includes('GORM')));
  assert.deepEqual(crud(r, '/'), {});
  // 화면이 GET 목록·DELETE 를 fetch 로 부름: 삭제 API 의 테이블이 화면에 합쳐짐
  assert.deepEqual(crud(r, '/admin/orders'), { order_items: 'RD', tb_order: 'RD' });
  assert.deepEqual(apis(r), ['GET /api/v1/orders/:id', 'GET /api/v1/stats', 'POST /api/v1/orders']);
  assert.deepEqual(crud(r, '/api/v1/stats', 'api'), { tb_order: 'R' });
  assert.deepEqual(crud(r, '/api/v1/orders', 'api'), { tb_order: 'C' });
  const flow = screenOf(r, '/admin/orders', 'page').flow.map((s) => s.layer);
  assert.deepEqual(flow.slice(0, 4), ['VIEW', 'CONTROLLER', 'SERVICE', 'DAO']);
  assert.ok(r.tables.find((t) => t.name === 'tb_order')?.comment === '주문');
});

test('net/http + database/sql: ServeMux 패턴(POST /x), SQL 상수, ExecuteTemplate', async () => {
  const r = await analyze(loadDir('go-nethttp'), { projectName: 'go-nethttp' });
  assert.deepEqual(crud(r, '/posts'), { posts: 'R', users: 'R' });
  // 폼이 POST /posts/save 로 저장
  assert.deepEqual(crud(r, '/posts/view'), { boards: 'U', comments: 'R', posts: 'CR' });
  assert.deepEqual(apis(r), ['/health']);
  assert.ok(r.tech.some((t) => t.layer === '데이터 접근' && t.items.includes('database/sql')));
});

test('chi + sqlx: 중첩 Route·Mount·라우터 넘기기, 패키지별 같은 이름 타입, 인터페이스 구현체, render 도우미', async () => {
  const r = await analyze(loadDir('go-chi'), { projectName: 'go-chi' });
  assert.deepEqual(crud(r, '/'), {});
  assert.deepEqual(crud(r, '/members'), { member_grades: 'R', member_logs: 'C', members: 'CRU' });
  assert.deepEqual(crud(r, '/members/{id}'), { member_logs: 'C', members: 'CRU' });
  assert.deepEqual(apis(r), ['GET /admin/members/stats', 'GET /api/orders']);
  // order.Service 는 order 패키지 구현체로만 (member 의 같은 이름 타입과 섞이지 않음)
  assert.deepEqual(crud(r, '/api/orders', 'api'), { orders: 'R' });
  assert.deepEqual(crud(r, '/admin/members/stats', 'api'), { members: 'R' });
  assert.equal(screenOf(r, '/members', 'page').name, '회원 목록');
});

test('Echo + GORM (go-admin 꼴): 함수 슬라이스로 등록한 라우트 접두어, 내장 구조체 메서드, 트랜잭션', async () => {
  const r = await analyze(
    mem('shop', {
      'go.mod': 'module example.com/shop\n\ngo 1.21\n\nrequire (\n\tgithub.com/labstack/echo/v4 v4.11.4\n\tgorm.io/gorm v1.25.5\n\tgorm.io/driver/postgres v1.5.4\n)\n',
      'main.go': `
package main

import (
	"example.com/shop/router"
	"github.com/labstack/echo/v4"
)

func main() {
	e := echo.New()
	router.Init(e)
	e.Logger.Fatal(e.Start(":1323"))
}
`,
      'router/router.go': `
package router

import (
	"example.com/shop/apis"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

var routers = make([]func(*echo.Group), 0)

func Init(e *echo.Echo) {
	v1 := e.Group("/api/v1")
	for _, f := range routers {
		f(v1)
	}
	e.GET("/products", apis.ProductPage)
}

func init() {
	routers = append(routers, registerProduct)
}

func registerProduct(g *echo.Group) {
	api := apis.Product{}
	r := g.Group("/product", middleware.Logger())
	r.GET("", api.List)
	r.PUT("/:id", api.Update, middleware.Recover())
}
`,
      'apis/api.go': `
package apis

import "gorm.io/gorm"

type Api struct{}

var DB *gorm.DB

func (Api) Orm() *gorm.DB { return DB }
`,
      'apis/product.go': `
package apis

import (
	"net/http"

	"example.com/shop/models"
	"example.com/shop/service"
	"github.com/labstack/echo/v4"
)

type Product struct {
	Api
}

func (p Product) List(c echo.Context) error {
	s := service.Product{}
	list, err := s.List(p.Orm())
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, list)
}

func (p Product) Update(c echo.Context) error {
	s := service.Product{}
	var req models.Product
	_ = c.Bind(&req)
	return s.Update(p.Orm(), &req)
}

// ProductPage 상품 관리 화면
func ProductPage(c echo.Context) error {
	return c.Render(http.StatusOK, "products.html", nil)
}
`,
      'service/product.go': `
package service

import (
	"example.com/shop/models"
	"gorm.io/gorm"
)

type Product struct{}

func (Product) List(db *gorm.DB) ([]models.Product, error) {
	var list []models.Product
	err := db.Model(&models.Product{}).Preload("Category").Where("deleted = 0").Find(&list).Error
	return list, err
}

func (Product) Update(db *gorm.DB, p *models.Product) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(p).Updates(p).Error; err != nil {
			return err
		}
		return tx.Create(&models.ProductHistory{ProductID: p.ID}).Error
	})
}
`,
      'models/product.go': `
package models

type Product struct {
	ID         int64
	Name       string
	CategoryID int64
	Category   Category
}

func (Product) TableName() string { return "tb_product" }

type Category struct {
	ID   int64
	Name string
}

type ProductHistory struct {
	ID        int64
	ProductID int64
}
`,
      'templates/products.html': `<html><head><title>상품 관리</title></head><body>
<script>
fetch('/api/v1/product').then((r) => r.json());
function save(id) { fetch('/api/v1/product/' + id, { method: 'PUT' }); }
</script></body></html>
`,
    }),
    { projectName: 'shop' },
  );
  assert.deepEqual(crud(r, '/products'), { categories: 'R', product_histories: 'C', tb_product: 'RU' });
  assert.deepEqual(apis(r), []);
  const calls = screenOf(r, '/products', 'page').calls.map((c) => c.url);
  assert.ok(calls.includes('/api/v1/product'));
});

test('Fiber: Group·Route 접두어, database/sql', async () => {
  const r = await analyze(
    mem('notice', {
      'go.mod': 'module example.com/notice\n\ngo 1.21\n\nrequire github.com/gofiber/fiber/v2 v2.52.0\n',
      'main.go': `
package main

import (
	"database/sql"

	"github.com/gofiber/fiber/v2"
)

var db *sql.DB

func main() {
	app := fiber.New()
	api := app.Group("/api")
	api.Get("/notices", listNotices)
	app.Route("/admin", func(r fiber.Router) {
		r.Post("/notices", createNotice)
	})
	app.Listen(":3000")
}

func listNotices(c *fiber.Ctx) error {
	rows, err := db.Query("SELECT id, title FROM notices ORDER BY id DESC")
	if err != nil {
		return err
	}
	defer rows.Close()
	return c.JSON(rows)
}

func createNotice(c *fiber.Ctx) error {
	_, err := db.Exec("INSERT INTO notices (title) VALUES (?)", c.FormValue("title"))
	return err
}
`,
    }),
    { projectName: 'notice' },
  );
  assert.deepEqual(apis(r), ['GET /api/notices', 'POST /admin/notices']);
  assert.deepEqual(crud(r, '/api/notices', 'api'), { notices: 'R' });
  assert.deepEqual(crud(r, '/admin/notices', 'api'), { notices: 'C' });
});

test('gorilla/mux: 구조체 필드 라우터, PathPrefix·Subrouter, Methods(http.MethodPost), PostgreSQL $1', async () => {
  const r = await analyze(
    mem('users', {
      'go.mod': 'module example.com/users\n\ngo 1.21\n\nrequire (\n\tgithub.com/gorilla/mux v1.8.1\n\tgithub.com/lib/pq v1.10.9\n)\n',
      'app.go': `
package main

import (
	"database/sql"
	"net/http"

	"github.com/gorilla/mux"
)

type App struct {
	DB     *sql.DB
	Router *mux.Router
}

func (a *App) initRoutes() {
	a.Router = mux.NewRouter()
	s := a.Router.PathPrefix("/api").Subrouter()
	s.HandleFunc("/users/{id:[0-9]+}", a.getUser).Methods("GET")
	s.HandleFunc("/users", a.createUser).Methods(http.MethodPost)
}

func (a *App) getUser(w http.ResponseWriter, r *http.Request) {
	u := user{}
	u.get(a.DB)
}

func (a *App) createUser(w http.ResponseWriter, r *http.Request) {
	var u user
	u.create(a.DB)
}
`,
      'model.go': `
package main

import "database/sql"

type user struct {
	ID   int
	Name string
}

func (u *user) get(db *sql.DB) error {
	return db.QueryRow("SELECT name FROM users WHERE id=$1", u.ID).Scan(&u.Name)
}

func (u *user) create(db *sql.DB) error {
	return db.QueryRow("INSERT INTO users(name) VALUES($1) RETURNING id", u.Name).Scan(&u.ID)
}
`,
    }),
    { projectName: 'users' },
  );
  assert.deepEqual(apis(r), ['GET /api/users/{id}', 'POST /api/users']);
  assert.deepEqual(crud(r, '/api/users/{id}', 'api'), { users: 'R' });
  assert.deepEqual(crud(r, '/api/users', 'api'), { users: 'C' });
  assert.equal(r.databases[0]?.type, 'PostgreSQL');
});

test('sqlc 생성 코드(-- name: 주석 SQL 상수) + net/http 1.22 + 제네릭 도우미', async () => {
  const r = await analyze(
    mem('authors', {
      'go.mod': 'module example.com/authors\n\ngo 1.22\n\nrequire github.com/jackc/pgx/v5 v5.5.0\n',
      'db/query.sql.go': `
// Code generated by sqlc. DO NOT EDIT.
package db

import "context"

const listAuthors = \`-- name: ListAuthors :many
SELECT id, name, bio FROM authors
ORDER BY name
\`

func (q *Queries) ListAuthors(ctx context.Context) ([]Author, error) {
	rows, err := q.db.Query(ctx, listAuthors)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return nil, nil
}

const createAuthor = \`-- name: CreateAuthor :one
INSERT INTO authors (name, bio) VALUES ($1, $2) RETURNING id, name, bio
\`

func (q *Queries) CreateAuthor(ctx context.Context, name string) (Author, error) {
	row := q.db.QueryRow(ctx, createAuthor, name)
	var i Author
	err := row.Scan(&i.ID, &i.Name, &i.Bio)
	return i, err
}
`,
      'db/db.go': `
package db

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type DBTX interface {
	Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error)
	Query(context.Context, string, ...interface{}) (pgx.Rows, error)
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}

func New(db DBTX) *Queries { return &Queries{db: db} }

type Queries struct {
	db DBTX
}

type Author struct {
	ID   int64
	Name string
	Bio  string
}
`,
      'main.go': `
package main

import (
	"context"
	"encoding/json"
	"net/http"

	"example.com/authors/db"
	"github.com/jackc/pgx/v5"
)

func writeJSON[T any](w http.ResponseWriter, v T) { json.NewEncoder(w).Encode(v) }

type server struct {
	q *db.Queries
}

func (s *server) list(w http.ResponseWriter, r *http.Request) {
	authors, _ := s.q.ListAuthors(r.Context())
	writeJSON(w, authors)
}

func (s *server) create(w http.ResponseWriter, r *http.Request) {
	a, _ := s.q.CreateAuthor(r.Context(), r.FormValue("name"))
	writeJSON(w, a)
}

func main() {
	conn, _ := pgx.Connect(context.Background(), "postgres://localhost/authors")
	s := &server{q: db.New(conn)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /authors", s.list)
	mux.HandleFunc("POST /authors", s.create)
	http.ListenAndServe(":8080", mux)
}
`,
    }),
    { projectName: 'authors' },
  );
  assert.deepEqual(apis(r), ['GET /authors', 'POST /authors']);
  assert.deepEqual(crud(r, '/authors', 'api'), { authors: 'R' });
  const post = r.screens.find((s) => s.name === 'POST /authors');
  assert.deepEqual(post?.tables.map((t) => `${t.table}:${t.crud.join('')}`), ['authors:C']);
  assert.ok(r.tech.some((t) => t.items.includes('pgx')));
});
