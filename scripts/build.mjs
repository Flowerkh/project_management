// 빌드: esbuild로 화면(app)과 분석 작업자(worker)를 묶는다.
//  - dist/web/project-analyzer.html : 파일 하나짜리 오프라인 앱 (Edge·Chrome에서 file:// 로 열기)
//  - dist/app/                      : Electron용 (index.html + app.js + app.css + worker-src.js)
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --dist <폴더>: 여러 작업이 동시에 빌드할 때 출력 폴더를 나눈다 (기본 dist/)
const distIdx = process.argv.indexOf('--dist');
const dist = distIdx > 0 && process.argv[distIdx + 1] ? path.resolve(process.argv[distIdx + 1]) : path.join(root, 'dist');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const dev = process.argv.includes('--dev');

// 엔진이 아직 없을 때를 위한 대체 모듈
const engineStub = {
  name: 'engine-stub',
  setup(build) {
    build.onResolve({ filter: /engine\/index$/ }, (args) => {
      const real = path.join(path.dirname(args.importer), `${args.path}.ts`);
      if (existsSync(real)) return undefined;
      return { path: 'engine-stub', namespace: 'stub' };
    });
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export async function analyze(){ throw new Error("분석 엔진이 아직 준비되지 않았습니다."); }',
      loader: 'js',
    }));
  },
};

const common = {
  bundle: true,
  minify: !dev,
  sourcemap: false,
  target: ['chrome100', 'edge100'],
  legalComments: 'none',
  logLevel: 'warning',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  charset: 'utf8',
  define: {
    'process.env.NODE_ENV': '"production"',
    __APP_VERSION__: JSON.stringify(pkg.version),
    // PA_DESK=0: 데스크톱 3단계 기능(Claude·형상관리·DB)을 숨긴 빌드
    __DESK_FEATURES__: JSON.stringify(process.env.PA_DESK !== '0'),
  },
  plugins: [engineStub],
  write: false,
  outdir: 'out',
};

const t0 = Date.now();
const [w, a] = await Promise.all([
  esbuild.build({ ...common, entryPoints: [path.join(root, 'src/worker.ts')], format: 'iife' }),
  esbuild.build({ ...common, entryPoints: [path.join(root, 'src/ui/main.tsx')], format: 'iife', loader: { '.css': 'css' } }),
]);
const workerJs = w.outputFiles.find((f) => f.path.endsWith('.js')).text;
const appJs = a.outputFiles.find((f) => f.path.endsWith('.js')).text;
const appCss = a.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';

const title = '프로젝트 분석 시스템';
const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>`;

// (a) 파일 하나짜리 HTML: 스크립트는 base64로 넣어 </script>·<!-- 같은 문자열이 HTML을 깨지 않게 한다
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const loader = `(function(){function d(b){var s=atob(b),u=new Uint8Array(s.length);for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return new TextDecoder().decode(u);}window.__WORKER_SRC__=d(document.getElementById('w').textContent);(0,eval)(d(document.getElementById('a').textContent));})();`;
const single = `<!doctype html>
<html lang="ko">
<head>
${head}
<style>${appCss}</style>
</head>
<body>
<div id="app"></div>
<script type="text/plain" id="w">${b64(workerJs)}</script>
<script type="text/plain" id="a">${b64(appJs)}</script>
<script>${loader}</script>
</body>
</html>
`;
await fs.mkdir(path.join(dist, 'web'), { recursive: true });
await fs.writeFile(path.join(dist, 'web', 'project-analyzer.html'), single);

// (b) Electron용 폴더
const appDir = path.join(dist, 'app');
await fs.mkdir(appDir, { recursive: true });
await fs.writeFile(path.join(appDir, 'app.js'), appJs);
await fs.writeFile(path.join(appDir, 'app.css'), appCss);
await fs.writeFile(path.join(appDir, 'worker.js'), workerJs);
await fs.writeFile(path.join(appDir, 'worker-src.js'), `window.__WORKER_SRC__=${JSON.stringify(workerJs)};\n`);
await fs.writeFile(
  path.join(appDir, 'index.html'),
  `<!doctype html>
<html lang="ko">
<head>
${head}
<link rel="stylesheet" href="app.css">
</head>
<body>
<div id="app"></div>
<script src="worker-src.js"></script>
<script src="app.js"></script>
</body>
</html>
`,
);

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)}KB`;
console.log(`build ok in ${Date.now() - t0}ms · app ${kb(appJs)} · worker ${kb(workerJs)} · css ${kb(appCss)} · single html ${kb(single)}`);
