// 소스에서 데스크톱 앱 실행: 저장소 폴더나 desktop 폴더에서 `npm start`
//   1) 패키지 확인: 저장소 폴더·desktop 폴더 각각, 설치되지 않은 패키지가 있거나 지난 설치 뒤로
//      package.json·package-lock.json이 바뀌었으면(git pull 등) npm install
//   2) 빌드: scripts/build-desktop.mjs → desktop/main.mjs·preload.cjs·app/
//   3) 실행: desktop 폴더를 Electron으로 연다 (창을 닫으면 끝)
//   npm start -- --dev   코드를 줄이지 않고 빌드 (오류 위치 확인용). 그 밖의 인자는 Electron에 넘긴다
//   npm run package      실행 파일 zip 만들기 → release/ProjectAnalyzer-<버전>-win.zip
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'desktop');
const argv = process.argv.slice(2);
const dev = argv.includes('--dev');
const pack = argv.includes('--package');
const electronArgs = argv.filter((a) => a !== '--dev' && a !== '--package');

function fail(...lines) {
  console.error(`\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** package.json의 패키지 중 설치되지 않았거나 package-lock.json과 버전이 다른 것 */
function outdated(dir) {
  const pkg = readJson(path.join(dir, 'package.json')) ?? {};
  const lock = readJson(path.join(dir, 'package-lock.json'));
  const out = [];
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const got = readJson(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'));
    const want = lock?.packages?.[`node_modules/${name}`]?.version;
    if (!got) out.push(name);
    else if (want && got.version !== want) out.push(`${name} ${got.version} → ${want}`);
  }
  return out;
}

/** npm 실행. npm start로 불렸으면 그 npm을 그대로 쓴다 (Windows에서도 셸을 거치지 않음) */
function npm(args, cwd) {
  const env = { ...process.env };
  delete env.npm_config_prefix;
  const cli = process.env.npm_execpath;
  const r =
    cli && /npm-cli\.[cm]?js$/.test(cli)
      ? spawnSync(process.execPath, [cli, ...args], { cwd, env, stdio: 'inherit' })
      : spawnSync('npm', args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status === 0;
}

/** 지난 npm install 때의 package.json·package-lock.json (node_modules 안에 남겨 둔다) */
const stampFile = (dir) => path.join(dir, 'node_modules', '.project-analyzer-install');

function lockHash(dir) {
  const h = createHash('sha256');
  for (const f of ['package.json', 'package-lock.json']) {
    try {
      h.update(fs.readFileSync(path.join(dir, f)));
    } catch {}
    h.update('\0');
  }
  return h.digest('hex');
}

function npmInstall(dir, label) {
  // --no-save: package-lock.json을 고쳐 쓰지 않는다 (git pull이 '로컬 변경' 때문에 막히지 않게)
  if (!npm(['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error'], dir))
    fail(`${label}에서 npm install이 실패했습니다. 위의 npm 오류를 확인해 주세요.`, '회사망이라면 npm 프록시 설정이 필요할 수 있습니다: npm config set proxy http://<프록시 주소>:<포트>');
  fs.writeFileSync(stampFile(dir), lockHash(dir));
}

function install(dir, label) {
  const need = outdated(dir);
  let stamp = null;
  try {
    stamp = fs.readFileSync(stampFile(dir), 'utf8').trim();
  } catch {}
  if (!need.length && stamp === lockHash(dir)) return;
  let what;
  if (!fs.existsSync(path.join(dir, 'node_modules'))) what = '처음이라 패키지를 설치합니다 (몇 분 걸릴 수 있습니다)';
  else if (need.length) what = `바뀐 패키지를 설치합니다: ${need.slice(0, 4).join(', ')}${need.length > 4 ? ` 외 ${need.length - 4}개` : ''}`;
  else if (stamp) what = '패키지 목록(package-lock.json)이 바뀌어 다시 설치합니다';
  else what = '설치된 패키지를 확인합니다 (npm install)';
  console.log(`  ${label}: ${what}`);
  npmInstall(dir, label);
  const left = outdated(dir);
  if (left.length) console.log(`  ${label}: 설치 후에도 버전이 다른 패키지가 있습니다 (${left.join(', ')}). 계속 진행합니다`);
}

/** desktop 폴더에 설치된 Electron 실행 파일 경로. 내려받기가 끝나지 않았으면 null */
function electronExe() {
  try {
    const exe = createRequire(path.join(desktop, 'package.json'))('electron');
    return typeof exe === 'string' && fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) fail(`지금 Node.js 버전은 ${process.versions.node}입니다. Node.js 22 LTS를 설치한 뒤 다시 실행해 주세요.`);

console.log('\n[1/3] 패키지 확인');
install(root, '저장소 폴더');
install(desktop, 'desktop 폴더');
if (!pack && !electronExe()) {
  console.log('  Electron 실행 파일이 없어 다시 내려받습니다');
  fs.rmSync(path.join(desktop, 'node_modules', 'electron'), { recursive: true, force: true });
  npmInstall(desktop, 'desktop 폴더');
  if (!electronExe()) fail('Electron 실행 파일을 내려받지 못했습니다 (github.com에서 받습니다).', '인터넷 연결을 확인한 뒤 다시 npm start 를 실행해 주세요.');
}
console.log('  준비됨');

console.log(`\n[2/3] 빌드${dev ? ' (--dev)' : ''}`);
const built = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-desktop.mjs'), ...(dev ? ['--dev'] : [])], { cwd: root, stdio: 'inherit' });
if (built.status !== 0) fail('빌드하지 못했습니다. 위의 오류 내용을 알려 주세요.');

if (pack) {
  console.log('\n[3/3] 실행 파일 zip 만들기 (electron-builder)');
  const t0 = Date.now();
  const builder = path.join(desktop, 'node_modules', 'electron-builder', 'cli.js');
  const r = spawnSync(process.execPath, [builder, '--win', 'zip', '--x64', '--publish', 'never'], { cwd: desktop, stdio: 'inherit' });
  if (r.status !== 0) fail('zip을 만들지 못했습니다. 위의 오류 내용을 알려 주세요.');
  const release = path.join(root, 'release');
  const zips = fs.readdirSync(release).filter((f) => f.endsWith('.zip') && fs.statSync(path.join(release, f)).mtimeMs >= t0);
  console.log(`\n  완료: ${zips.map((f) => path.join(release, f)).join(', ') || release}`);
  process.exit(0);
}

console.log('\n[3/3] 실행 (앱 창을 닫으면 여기도 끝납니다)');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronExe(), [desktop, ...electronArgs], { cwd: desktop, env, stdio: 'inherit' });
child.on('error', (e) => fail(`앱을 실행하지 못했습니다: ${e.message}`));
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => !child.killed && child.kill(sig));
