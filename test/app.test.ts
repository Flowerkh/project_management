// 모바일 앱 분석 검증: Android(Kotlin·Java)·React Native·Flutter 예제와 Flutter 앱 + Go API 서버(하위 프로젝트)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { analyze } from '../src/engine/index';
import type { AnalysisResult, ScreenResult, SourceFile } from '../src/engine/types';

const FIX = join(import.meta.dirname, '..', 'fixtures');
let generated = false;

function loadDir(name: string): SourceFile[] {
  const root = join(FIX, name);
  if (!existsSync(root) || !generated) {
    execFileSync('python3', [join(FIX, 'gen_apps.py'), FIX]);
    generated = true;
  }
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

function screen(r: AnalysisResult, name: string): ScreenResult {
  const s = r.screens.find((x) => x.name === name);
  assert.ok(s, `화면 없음: ${name} (있는 것: ${r.screens.map((x) => x.name).join(', ')})`);
  return s;
}
const crud = (s: ScreenResult) => Object.fromEntries(s.tables.map((t) => [t.table, t.crud.join('')]));
const calls = (s: ScreenResult) => s.calls.map((c) => c.url).sort();
const fileName = (r: AnalysisResult, id: string | undefined) => r.files.find((f) => f.id === id)?.name;
function menuTree(r: AnalysisResult): string[] {
  return r.menus.map((m) => `${'  '.repeat(m.depth)}${m.name}${m.screens.length ? ` → ${m.screens.map((id) => r.screens.find((s) => s.id === id)?.name).join(',')}` : ''}`);
}

test('Android Kotlin MVVM: Activity·Fragment 화면, strings.xml 제목, 하단 탭 메뉴, Room·Retrofit', async () => {
  const r = await analyze(loadDir('app-android'), { projectName: 'app-android' });
  assert.deepEqual(r.project.types, ['모바일 앱']);
  assert.ok(r.screens.every((s) => s.platform === 'Android' && s.kind === 'page'));
  assert.deepEqual(r.screens.map((s) => s.name).sort(), ['공지사항', '내 정보', '상품 상세', '쇼핑몰', '주문 내역', '홈']);
  // 화면 → ViewModel → Repository → Room DAO
  const home = screen(r, '홈');
  assert.deepEqual(crud(home), { products: 'CR' });
  assert.deepEqual(calls(home), ['GET /api/products']);
  assert.deepEqual(home.flow.slice(0, 5).map((f) => f.layer), ['VIEW', 'CONTROLLER', 'SERVICE', 'DAO', 'DAO']);
  assert.ok(home.files.some((f) => fileName(r, f.file) === 'fragment_home.xml'), '레이아웃 XML 포함');
  assert.ok(home.files.some((f) => fileName(r, f.file) === 'view_toolbar.xml'), '중첩 include');
  assert.ok(home.evidence.some((e) => fileName(r, e.file) === 'strings.xml' && e.text === '홈'));
  // 인터페이스 → 구현체(OrderRepositoryImpl), db.orderDao() 필드 타입 추정
  assert.deepEqual(crud(screen(r, '주문 내역')), { orders: 'CR' });
  // init 블록(ViewModel 생성 시) + 버튼 처리
  assert.deepEqual(crud(screen(r, '내 정보')), { users: 'CD' });
  const detail = screen(r, '상품 상세');
  assert.deepEqual(crud(detail), { products: 'R' });
  assert.deepEqual(calls(detail), ['GET /api/products/{p}', 'POST /api/orders']);
  // 하이브리드 웹뷰
  assert.deepEqual(screen(r, '공지사항').calls.map((c) => `${c.kind} ${c.url}`), ['webview https://m.example.com/notice/list.do']);
  // 메뉴: 하단 탭(menu XML) + 내비게이션 그래프 action
  assert.deepEqual(menuTree(r), ['홈 → 홈', '  상품 상세 → 상품 상세', '주문 내역 → 주문 내역', '내 정보 → 내 정보']);
  assert.ok(r.menus.every((m) => m.source === 'config'));
  // Room 엔티티 → 테이블 컬럼
  const products = r.tables.find((t) => t.name === 'products');
  assert.deepEqual(products?.columns.map((c) => `${c.name}${c.pk ? '*' : ''}`), ['id*', 'name', 'unit_price']);
  assert.ok(r.databases.some((d) => d.type === 'SQLite' && d.access.includes('Room')));
  assert.equal(r.project.subProjects.length, 0);
});

test('Android Java: SQLiteOpenHelper SQL·테이블 API, Volley, 매니페스트·툴바 제목', async () => {
  const r = await analyze(loadDir('app-android-java'), { projectName: 'app-android-java' });
  assert.deepEqual(r.screens.map((s) => s.name).sort(), ['메모 작성', '메모장', '설정']);
  assert.deepEqual(crud(screen(r, '메모장')), { memo: 'R' });
  assert.deepEqual(calls(screen(r, '메모장')), ['GET /api/memos']);
  assert.deepEqual(crud(screen(r, '메모 작성')), { memo: 'CUD' });
  const memo = r.tables.find((t) => t.name === 'memo');
  assert.deepEqual(memo?.columns.map((c) => c.name), ['id', 'title', 'body', 'updated_at']);
  // 옵션 메뉴(설정)는 내비게이션 메뉴가 아님
  assert.equal(r.menus.length, 0);
});

test('React Native: Stack·Tab 내비게이터, 탭 안 스택, axios 인스턴스 기준 URL(.env), SQLite, WebView', async () => {
  const r = await analyze(loadDir('app-rn'), { projectName: 'app-rn' });
  assert.deepEqual(r.project.types, ['모바일 앱']);
  assert.ok(!r.tech.some((t) => /Android/.test(t.items)), 'android/ 호스트 폴더는 Android 앱으로 보지 않음');
  assert.deepEqual(r.screens.map((s) => s.name).sort(), ['공지사항', '상품 상세', '장바구니', '주문 내역', '주문 상세', '홈']);
  assert.ok(r.screens.every((s) => s.platform === 'React Native'));
  assert.deepEqual(calls(screen(r, '홈')), ['GET /api/products']);
  assert.deepEqual(calls(screen(r, '주문 내역')), ['GET /api/orders']);
  assert.deepEqual(calls(screen(r, '주문 상세')), ['DELETE /api/orders/{p}', 'GET /api/orders/{p}']);
  assert.deepEqual(crud(screen(r, '장바구니')), { cart_items: 'RD' });
  assert.deepEqual(calls(screen(r, '장바구니')), ['POST /api/orders']);
  assert.deepEqual(crud(screen(r, '상품 상세')), { cart_items: 'C' });
  assert.deepEqual(screen(r, '공지사항').calls.map((c) => c.kind), ['webview']);
  assert.deepEqual(menuTree(r), ['홈 → 홈', '주문 → 주문 내역', '  주문 상세 → 주문 상세', '장바구니 → 장바구니']);
  assert.deepEqual(r.tables.find((t) => t.name === 'cart_items')?.columns.map((c) => c.name), ['id', 'product_id', 'qty']);
});

test('Flutter: GoRouter 경로, 하단 탭 페이지 목록, ARB 한국어 제목, dio BaseOptions, sqflite', async () => {
  const r = await analyze(loadDir('app-flutter'), { projectName: 'app-flutter' });
  assert.deepEqual(r.project.types, ['모바일 앱']);
  assert.ok(r.screens.every((s) => s.platform === 'Flutter'), 'web/index.html은 화면이 아님');
  assert.deepEqual(r.screens.map((s) => s.name).sort(), ['Main Shell', '상품 상세', '장바구니', '주문 내역', '주문 상세', '홈']);
  assert.equal(screen(r, '주문 상세').url, '/orders/:id');
  assert.ok(screen(r, '상품 상세').evidence.some((e) => fileName(r, e.file) === 'app_ko.arb'));
  assert.deepEqual(calls(screen(r, '홈')), ['GET /api/products']);
  assert.deepEqual(calls(screen(r, '주문 상세')), ['DELETE /api/orders/{p}', 'GET /api/orders/{p}']);
  assert.deepEqual(crud(screen(r, '장바구니')), { cart_items: 'RD' });
  assert.deepEqual(crud(screen(r, '상품 상세')), { cart_items: 'C' });
  // 탭 묶음 화면은 각 탭 화면의 테이블을 끌어오지 않음
  assert.deepEqual(crud(screen(r, 'Main Shell')), {});
  assert.deepEqual(menuTree(r), ['홈 → 홈', '주문 → 주문 내역', '  주문 상세 → 주문 상세', '장바구니 → 장바구니']);
  assert.deepEqual(r.tables.find((t) => t.name === 'cart_items')?.columns.map((c) => c.name), ['id', 'product_id', 'qty']);
});

test('Flutter 앱 + Go(Gin) API 서버: 하위 프로젝트, 앱 화면 → API URL → 서버 핸들러 → MySQL 테이블', async () => {
  const r = await analyze(loadDir('app-with-server'), { projectName: 'app-with-server' });
  assert.deepEqual(r.project.types, ['모바일 앱', 'API 서버']);
  assert.deepEqual(r.project.subProjects, [
    { id: 'P1', name: 'app', root: 'app-with-server/app', types: ['모바일 앱'] },
    { id: 'P2', name: 'server', root: 'app-with-server/server', types: ['API 서버'] },
  ]);
  const list = screen(r, '작업 목록');
  assert.equal(list.project, 'P1');
  assert.deepEqual(crud(list), { tb_task: 'R' });
  assert.deepEqual(list.calls.map((c) => `${c.url} → ${c.handler}`), ['GET /api/v1/tasks → TaskHandler.ListTasks()']);
  assert.deepEqual(crud(screen(r, '작업 상세')), { tb_task: 'RU', tb_task_log: 'C' });
  assert.deepEqual(crud(screen(r, '작업 등록')), { tb_task: 'C' });
  assert.ok(list.flow.some((f) => f.symbol === 'TaskHandler.ListTasks()'));
  // 서버 API 목록은 그대로 (앱이 부르는 API도 서버 쪽 항목으로 남음)
  assert.ok(r.screens.filter((s) => s.kind === 'api').every((s) => s.project === 'P2'));
  assert.equal(r.screens.filter((s) => s.kind === 'api').length, 5);
  const task = r.tables.find((t) => t.name === 'tb_task');
  assert.ok(task?.usedBy.some((u) => u.id === list.id));
  // 앱 화면만으로 URL 추정 메뉴를 만들지 않음
  assert.ok(!r.menus.some((m) => m.source === 'url-guess' && m.screens.includes(list.id)));
  const app = r.files.filter((f) => f.path.startsWith('app-with-server/app/'));
  assert.ok(app.length && app.every((f) => f.project === 'P1'));
  assert.ok(!r.files.find((f) => f.path === 'app-with-server/README.md')?.project);
});

test('Expo Router: app/ 파일 경로 = 화면, (tabs) 레이아웃 탭 메뉴, 다른 파일 컴포넌트 재내보내기, 감싼 쿼리 함수', async () => {
  const r = await analyze(mem('expo', {
    'package.json': '{ "name": "expo-shop", "dependencies": { "expo": "~51.0.0", "expo-router": "~3.5.0", "react-native": "0.74.1", "axios": "^1.7.0" } }\n',
    '.env': 'EXPO_PUBLIC_API_URL=https://api.example.com/v1\n',
    'src/app/_layout.tsx': "import { Stack } from 'expo-router';\nexport default function Root() { return <Stack />; }\n",
    'src/app/(tabs)/_layout.tsx': `
import { Tabs } from 'expo-router';

export default function TabLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: '상품' }} />
      <Tabs.Screen name="orders" options={{ title: '주문' }} />
      <Tabs.Screen name="hidden" options={{ href: null }} />
    </Tabs>
  );
}
`,
    'src/app/(tabs)/index.tsx': "export { ProductListScreen as default } from '@/features/product/product-list-screen';\n",
    'src/app/(tabs)/orders.tsx': `
import { useOrders } from '@/features/order/api';

export default function OrdersScreen() {
  const { data } = useOrders();
  return null;
}
`,
    'src/app/product/[id].tsx': `
import { client } from '@/lib/api';

export default function ProductDetail() {
  const add = () => client({ url: 'cart', method: 'POST' });
  return <Button onPress={add} title="담기" />;
}
`,
    'src/features/product/product-list-screen.tsx': `
import { client } from '@/lib/api';

export function ProductListScreen() {
  React.useEffect(() => {
    client.get('products');
  }, []);
  return null;
}
`,
    'src/features/order/api.ts': `
import { createQuery } from 'react-query-kit';
import { client } from '@/lib/api';

export const useOrders = createQuery<Order[], void, Error>({
  queryKey: ['orders'],
  fetcher: () => client.get('orders').then((r) => r.data),
});
`,
    'src/lib/api/index.ts': "export * from './client';\n",
    'src/lib/api/client.ts': "import axios from 'axios';\nexport const client = axios.create({ baseURL: process.env.EXPO_PUBLIC_API_URL });\n",
  }), { projectName: 'expo' });
  assert.deepEqual(r.screens.map((s) => `${s.name} ${s.url}`).sort(), ['상품 /', '상품 상세 /product/{id}', '주문 /orders']);
  assert.equal(fileName(r, screen(r, '상품').view), 'product-list-screen.tsx');
  assert.deepEqual(calls(screen(r, '상품')), ['GET /v1/products']);
  assert.deepEqual(calls(screen(r, '주문')), ['GET /v1/orders']);
  assert.deepEqual(calls(screen(r, '상품 상세')), ['POST /v1/cart']);
  assert.deepEqual(menuTree(r), ['상품 → 상품', '주문 → 주문']);
});

test('하이브리드 웹뷰: 같은 폴더의 웹(Spring MVC) 화면 URL과 이어짐', async () => {
  const r = await analyze(mem('hybrid', {
    'app/build.gradle': "apply plugin: 'com.android.application'\n",
    'app/src/main/AndroidManifest.xml': '<manifest package="com.x.hy"><application><activity android:name=".NoticeActivity" android:label="공지"/></application></manifest>\n',
    'app/src/main/java/com/x/hy/NoticeActivity.kt': `
package com.x.hy

import android.os.Bundle
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity

class NoticeActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        findViewById<WebView>(R.id.web).loadUrl("https://m.example.com/notice/list.do")
    }
}
`,
    'web/pom.xml': '<project><dependencies><dependency><artifactId>spring-webmvc</artifactId></dependency></dependencies></project>\n',
    'web/src/main/java/com/x/web/NoticeController.java': `
package com.x.web;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;

@Controller
public class NoticeController {
    private NoticeDAO noticeDAO;

    @RequestMapping("/notice/list.do")
    public String list() {
        noticeDAO.selectList();
        return "notice/list";
    }
}
`,
    'web/src/main/java/com/x/web/NoticeDAO.java': `
package com.x.web;

public class NoticeDAO {
    public void selectList() {
        String sql = "SELECT NOTICE_ID, TITLE FROM TB_NOTICE ORDER BY NOTICE_ID DESC";
    }
}
`,
    'web/src/main/webapp/WEB-INF/jsp/notice/list.jsp': '<%@ page contentType="text/html; charset=UTF-8" %>\n<html><head><title>공지 목록</title></head><body></body></html>\n',
  }), { projectName: 'hybrid' });
  const app = screen(r, '공지');
  assert.equal(app.platform, 'Android');
  assert.deepEqual(app.calls.map((c) => `${c.kind} ${c.url} → ${c.handler}`), ['webview https://m.example.com/notice/list.do → NoticeController.list()']);
  assert.deepEqual(crud(app), { TB_NOTICE: 'R' });
  const web = screen(r, '공지 목록');
  assert.equal(web.platform, undefined);
  assert.deepEqual(r.project.subProjects.map((p) => `${p.name}:${p.types.join('+')}`), ['app:모바일 앱', 'web:웹']);
});

test('Jetpack Compose: NavHost 경로, @Composable 화면, TopAppBar 제목, 하단 탭(NavigationBarItem)', async () => {
  const r = await analyze(mem('compose', {
    'app/build.gradle.kts': 'plugins { id("com.android.application") }\nandroid { namespace = "com.x.todo"; buildFeatures { compose = true } }\n',
    'app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="할 일"><activity android:name=".MainActivity"><intent-filter><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>\n',
    'app/src/main/java/com/x/todo/MainActivity.kt': `
package com.x.todo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { TodoApp() }
    }
}
`,
    'app/src/main/java/com/x/todo/TodoApp.kt': `
package com.x.todo

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.x.todo.ui.list.TodoListScreen
import com.x.todo.ui.stats.StatsScreen

@Composable
fun TodoApp() {
    val nav = rememberNavController()
    Scaffold(bottomBar = {
        NavigationBar {
            NavigationBarItem(selected = true, onClick = { nav.navigate("todos") }, icon = {}, label = { Text("할 일") })
            NavigationBarItem(selected = false, onClick = { nav.navigate("stats") }, icon = {}, label = { Text("통계") })
        }
    }) {
        NavHost(nav, startDestination = "todos") {
            composable("todos") { TodoListScreen() }
            composable(route = "stats") { StatsScreen() }
        }
    }
}
`,
    'app/src/main/java/com/x/todo/ui/list/TodoListScreen.kt': `
package com.x.todo.ui.list

import androidx.compose.runtime.Composable
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun TodoListScreen(viewModel: TodoViewModel = hiltViewModel()) {
    val state by viewModel.items.collectAsState()
    Scaffold(topBar = { TopAppBar(title = { Text("할 일 목록") }) }) {
        Button(onClick = { viewModel.add("x") }) { Text("추가") }
    }
}
`,
    'app/src/main/java/com/x/todo/ui/list/TodoViewModel.kt': `
package com.x.todo.ui.list

import androidx.lifecycle.ViewModel
import com.x.todo.data.TodoDao

class TodoViewModel(private val dao: TodoDao) : ViewModel() {
    val items = dao.observeAll()
    fun add(title: String) { dao.insert(title) }
}
`,
    'app/src/main/java/com/x/todo/ui/stats/StatsScreen.kt': `
package com.x.todo.ui.stats

import androidx.compose.runtime.Composable

@Composable
fun StatsScreen() {
    Text("통계")
}
`,
    'app/src/main/java/com/x/todo/data/TodoDao.kt': `
package com.x.todo.data

import androidx.room.Dao
import androidx.room.Query

@Dao
interface TodoDao {
    @Query("SELECT * FROM todo ORDER BY id")
    fun observeAll(): Flow<List<Todo>>

    @Query("INSERT INTO todo(title) VALUES (:title)")
    fun insert(title: String)
}
`,
  }), { projectName: 'compose' });
  const list = screen(r, '할 일 목록');
  assert.equal(list.url, '/todos');
  assert.deepEqual(crud(list), { todo: 'CR' });
  // 제목이 없는 화면은 연결된 메뉴 이름을 씀
  assert.equal(screen(r, '통계').url, '/stats');
  assert.deepEqual(menuTree(r), ['할 일 → 할 일 목록', '통계 → 통계']);
  assert.ok(screen(r, '할 일').platform === 'Android', '런처 액티비티는 앱 이름');
});

test('Android Java Retrofit: 인터페이스 애노테이션 + baseUrl 상수', async () => {
  const r = await analyze(mem('java-retrofit', {
    'app/build.gradle': "apply plugin: 'com.android.application'\ndependencies { implementation 'com.squareup.retrofit2:retrofit:2.9.0' }\n",
    'app/src/main/AndroidManifest.xml': '<manifest package="com.x.memo"><application><activity android:name=".MemoActivity" android:label="메모 보기"/></application></manifest>\n',
    'app/src/main/java/com/x/memo/MemoActivity.java': `
package com.x.memo;

import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;

public class MemoActivity extends AppCompatActivity {
    private MemoService service;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        service = RetrofitClient.create();
        load(3L);
    }

    private void load(long id) {
        service.get(id).enqueue(null);
        service.remove(id);
    }
}
`,
    'app/src/main/java/com/x/memo/MemoService.java': `
package com.x.memo;

import retrofit2.Call;
import retrofit2.http.*;

public interface MemoService {
    @GET("memos/{id}")
    Call<Memo> get(@Path("id") long id);

    @DELETE("memos/{id}")
    Call<Void> remove(@Path("id") long id);
}
`,
    'app/src/main/java/com/x/memo/RetrofitClient.java': `
package com.x.memo;

import retrofit2.Retrofit;

public class RetrofitClient {
    private static final String BASE = "https://memo.example.com/api/";

    public static MemoService create() {
        return new Retrofit.Builder().baseUrl(BASE).build().create(MemoService.class);
    }
}
`,
  }), { projectName: 'java-retrofit' });
  assert.deepEqual(calls(screen(r, '메모 보기')), ['DELETE /api/memos/{p}', 'GET /api/memos/{p}']);
});

test('Spring Kotlin 서버: 라우트·JPA 리포지토리', async () => {
  const r = await analyze(mem('kt-server', {
    'server/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.2.0" }\ndependencies { implementation("org.springframework.boot:spring-boot-starter-web"); implementation("org.springframework.boot:spring-boot-starter-data-jpa") }\n',
    'server/src/main/kotlin/com/x/api/NoticeController.kt': `
package com.x.api

import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/notices")
class NoticeController(private val service: NoticeService) {
    @GetMapping
    fun list() = service.list()

    @PostMapping("/{id}/read")
    fun read(@PathVariable id: Long) = service.markRead(id)
}
`,
    'server/src/main/kotlin/com/x/api/NoticeService.kt': `
package com.x.api

import org.springframework.stereotype.Service

@Service
class NoticeService(private val repo: NoticeRepository) {
    fun list() = repo.findAll()
    fun markRead(id: Long) = repo.save(repo.findById(id).get())
}
`,
    'server/src/main/kotlin/com/x/api/Notice.kt': `
package com.x.api

import jakarta.persistence.*

@Entity
@Table(name = "tb_notice")
class Notice(@Id val id: Long, val title: String)

interface NoticeRepository : JpaRepository<Notice, Long>
`,
  }), { projectName: 'kt-server' });
  const apis = r.screens.filter((s) => s.kind === 'api');
  assert.deepEqual(apis.map((s) => s.name).sort(), ['GET /api/notices', 'POST /api/notices/{id}/read']);
  assert.deepEqual(crud(apis.find((s) => s.name === 'GET /api/notices')!), { tb_notice: 'R' });
  assert.deepEqual(crud(apis.find((s) => s.name === 'POST /api/notices/{id}/read')!), { tb_notice: 'CRU' });
});
