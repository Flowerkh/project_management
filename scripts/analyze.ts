// 사용법: npx tsx scripts/analyze.ts <폴더> [결과.json] [--quiet]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { analyze } from '../src/engine/index';
import type { SourceFile } from '../src/engine/types';

const SKIP = new Set(['.git', 'node_modules', '.svn']);

function walk(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const rec = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP.has(name)) {
          out.push({ path: relative(root, join(p, '.skipped')).split(sep).join('/'), size: 0, bytes: new Uint8Array() });
          continue;
        }
        rec(p);
      } else if (st.isFile()) {
        const rel = relative(root, p).split(sep).join('/');
        out.push({ path: `${basename(root)}/${rel}`, size: st.size, bytes: st.size < 4 * 1024 * 1024 ? new Uint8Array(readFileSync(p)) : new Uint8Array() });
      }
    }
  };
  rec(root);
  return out;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const quiet = process.argv.includes('--quiet');
const root = args[0];
if (!root) {
  console.error('폴더를 지정하세요');
  process.exit(1);
}
const files = walk(root).filter((f) => !f.path.endsWith('.skipped'));
const t0 = Date.now();
const result = await analyze(files, {
  projectName: basename(root),
  onProgress: (p) => {
    if (!quiet && p.done === p.total) console.error(`[${p.step}] ${p.stepName} ${p.done}/${p.total} ${p.message ?? ''}`);
  },
});
const ms = Date.now() - t0;
if (args[1]) writeFileSync(args[1], JSON.stringify(result, null, 1));

const fname = (id: string) => result.files.find((f) => f.id === id)?.path ?? id;
console.log(`\n== ${result.project.name}: ${result.project.title}`);
console.log(result.project.summary);
console.log(`types=${result.project.types.join(',')} conf=${result.project.confidence} time=${ms}ms`);
console.log(`files total=${result.stats.totalFiles} analyzed=${result.stats.analyzedFiles} excluded=${result.stats.excludedFiles}`);
console.log('langs:', result.languages.slice(0, 6).map((l) => `${l.name} ${(l.ratio * 100).toFixed(0)}%`).join(', '));
console.log('db:', result.databases.map((d) => `${d.type}(${d.confidence}) ${d.access.join('/')}`).join(', '));
console.log('tech:', result.tech.map((t) => `${t.layer}=${t.items}(${t.files})`).join(' | '));
console.log(`tables=${result.tables.length} screens=${result.screens.length} (pages ${result.screens.filter((s) => s.kind !== 'api').length}) menus=${result.menus.length} batches=${result.batches.length} sql=${result.sql.length}`);
if (!quiet) {
  console.log('\n-- screens');
  for (const s of result.screens.slice(0, 60)) {
    console.log(`${s.id} [${s.kind}] ${s.group} | ${s.name} | ${s.url ?? '-'} | ${s.tables.map((t) => `${t.table}:${t.crud.join('')}`).join(' ')} | ${s.confidence} | menu=${s.menu ?? '-'} | ${s.role}`);
  }
  console.log('\n-- tables');
  for (const t of result.tables.slice(0, 60)) {
    console.log(`${t.id} ${t.name} | ${t.role} (${t.roleConfidence}) | cols=${t.columns.length} | used=${t.usedBy.length}${t.common ? ' common' : ''}${t.unlinked ? ' UNLINKED' : ''}${t.fromSqlOnly ? ' sql-only' : ''}`);
  }
  console.log('\n-- menus');
  for (const m of result.menus.slice(0, 60)) console.log(`${'  '.repeat(m.depth)}${m.id} ${m.name} ${m.url ?? ''} → ${m.screens.join(',')} [${m.source}]`);
  console.log('\n-- batches');
  for (const b of result.batches) console.log(`${b.id} ${b.group} | ${b.name} | ${b.schedule?.text ?? '주기 없음'} | ${b.tables.map((t) => `${t.table}:${t.crud.join('')}`).join(' ')} | ${b.role}`);
  console.log('\n-- issues');
  for (const i of result.issues) console.log(`${i.title}: ${i.items.length} e.g. ${i.items.slice(0, 3).map((x) => (x.ref.startsWith('F') ? fname(x.ref) : x.ref) + (x.note ? `(${x.note})` : '')).join(', ')}`);
}
