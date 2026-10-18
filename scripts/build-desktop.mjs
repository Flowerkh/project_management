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
// --out <폴더>: desktop/ 대신 이 폴더에 앱을 만든다 (동시에 여러 작업이 시험할 때). node_modules는 desktop/ 것을 링크
const outIdx = process.argv.indexOf('--out');
const outDir = outIdx > 0 && process.argv[outIdx + 1] ? path.resolve(process.argv[outIdx + 1]) : null;
if (outDir && !process.argv.includes('--dist')) process.argv.push('--dist', path.join(outDir, 'dist'));
const distIdx = process.argv.indexOf('--dist');
const dist = distIdx > 0 ? path.resolve(process.argv[distIdx + 1]) : path.join(root, 'dist');

await import('./build.mjs');

const desktopSrc = path.join(root, 'desktop');
const desktop = outDir ?? desktopSrc;
await fs.mkdir(desktop, { recursive: true });
if (outDir) {
  await fs.copyFile(path.join(desktopSrc, 'package.json'), path.join(outDir, 'package.json'));
  const nm = path.join(outDir, 'node_modules');
  const exists = await fs.lstat(nm).catch(() => null);
  if (!exists) await fs.symlink(path.join(desktopSrc, 'node_modules'), nm, 'dir');
}
const pkg = JSON.parse(await fs.readFile(path.join(desktopSrc, 'package.json'), 'utf8'));
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
await fs.cp(path.join(dist, 'app'), path.join(desktop, 'app'), { recursive: true });
const st = await fs.stat(path.join(desktop, 'main.mjs'));
console.log(`desktop build ok in ${Date.now() - t0}ms · main.mjs ${Math.round(st.size / 1024)}KB`);
