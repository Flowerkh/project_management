// 데스크톱 앱 빌드: 화면(scripts/build.mjs → dist/app) + 메인 프로세스(desktop/main.mjs) + preload(desktop/preload.cjs)
//   node scripts/build-desktop.mjs [--dev]
// 메인 프로세스는 ESM 하나로 묶는다 (Claude Agent SDK가 ESM). DB 드라이버(oracledb·mariadb)는 묶지 않고 desktop/node_modules에서 읽는다.
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const t0 = Date.now();

await import('./build.mjs');

const desktop = path.join(root, 'desktop');
const pkg = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8'));
const external = ['electron', ...Object.keys(pkg.dependencies ?? {})];

await Promise.all([
  esbuild.build({
    entryPoints: [path.join(root, 'src/desktop/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: path.join(desktop, 'main.mjs'),
    external,
    // 묶은 CommonJS 코드의 require(…)가 ESM 안에서도 동작하게
    banner: { js: "import { createRequire as __paCreateRequire } from 'node:module';\nconst require = __paCreateRequire(import.meta.url);" },
    minify: !dev,
    keepNames: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    charset: 'utf8',
  }),
  esbuild.build({
    entryPoints: [path.join(root, 'src/desktop/preload.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(desktop, 'preload.cjs'),
    external: ['electron'],
    minify: false,
    legalComments: 'none',
    logLevel: 'warning',
    charset: 'utf8',
  }),
]);

await fs.rm(path.join(desktop, 'app'), { recursive: true, force: true });
await fs.cp(path.join(root, 'dist', 'app'), path.join(desktop, 'app'), { recursive: true });
const st = await fs.stat(path.join(desktop, 'main.mjs'));
console.log(`desktop build ok in ${Date.now() - t0}ms · main.mjs ${Math.round(st.size / 1024)}KB`);
