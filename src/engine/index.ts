// 분석 엔진 진입점: analyze(files, opts) → AnalysisResult
// 브라우저(Web Worker)·Electron·Node 어디서나 같은 코드로 돈다 (DOM·fs를 쓰지 않음).
import type { AnalysisResult, AnalyzeOptions, Facts, Progress, SourceFile } from './types';
import { collect, commonRoot } from './files';
import { createCtx } from './context';
import { ANALYZERS } from './analyzers';
import { link } from './link';
import { databases, describe, languages, systemTypes, techTable } from './summary';

export * from './types';
export { decode } from './files';
export { cronText } from './link';

export const STEPS = ['파일 읽기', '기술 스택·DB 감지', '요소 추출', '연결', '역할 생성', '결과 정리'];

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function analyze(input: SourceFile[], opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const started = Date.now();
  const report = (p: Progress) => opts.onProgress?.(p);
  const total = input.length;

  // 1. 파일 읽기
  report({ step: 1, stepName: STEPS[0], done: 0, total });
  let lastTick = Date.now();
  const { files, texts } = collect(input, opts, (i) => {
    if (i % 200 === 0) report({ step: 1, stepName: STEPS[0], done: i, total });
  });
  report({ step: 1, stepName: STEPS[0], done: total, total, message: `분석 대상 ${texts.size}개 · 제외 ${files.length - texts.size}개` });
  await tick();

  const facts: Facts = {
    files, texts, sql: [], ddl: [], units: [], views: [], menus: [], batches: [], schedules: [], tech: [], notes: [], viewResolvers: [],
  };
  const ctx = createCtx(facts);
  const targets = files.filter((f) => !f.excluded);

  // 2~3. 감지·추출: 분석기를 순서대로 모든 파일에 적용
  const detect = ANALYZERS.filter((a) => a.order < 5);
  const extract = ANALYZERS.filter((a) => a.order >= 5);
  for (const [step, list] of [[2, detect], [3, extract]] as const) {
    let done = 0;
    for (const f of targets) {
      const text = texts.get(f.id) ?? '';
      for (const a of list) {
        try {
          if (a.accepts(f, text)) a.analyze(f, text, ctx);
        } catch (e) {
          facts.notes.push({ kind: 'unreadable', title: '분석 중 오류가 난 파일', items: [{ ref: f.id, note: `${a.name}: ${(e as Error).message}` }] });
        }
      }
      done++;
      if (Date.now() - lastTick > 120) {
        report({ step, stepName: STEPS[step - 1], done, total: targets.length, message: f.path });
        lastTick = Date.now();
        await tick();
      }
    }
    for (const a of list) {
      try {
        a.finish?.(ctx);
      } catch (e) {
        facts.notes.push({ kind: 'other', title: '분석 마무리 중 오류', items: [{ ref: a.name, note: (e as Error).message }] });
      }
    }
    report({ step, stepName: STEPS[step - 1], done: targets.length, total: targets.length });
    await tick();
  }

  // 4~5. 연결·역할
  report({ step: 4, stepName: STEPS[3], done: 0, total: 1 });
  await tick();
  const linked = link(facts);
  report({ step: 5, stepName: STEPS[4], done: 1, total: 1 });
  await tick();

  // 6. 결과 정리
  const name = opts.projectName || commonRoot(files.map((f) => f.path)).split('/').pop() || 'project';
  const types = systemTypes(facts, linked);
  const d = describe(facts, linked, types, name);
  const notes = mergeIssues(linked.issues);
  const result: AnalysisResult = {
    version: 1,
    project: {
      name,
      analyzedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      types,
      title: d.title,
      summary: d.summary,
      domainEstimated: d.domainEstimated,
      confidence: d.confidence,
      evidence: d.evidence,
      subProjects: [],
    },
    stats: {
      totalFiles: files.length,
      analyzedFiles: targets.length,
      excludedFiles: files.length - targets.length,
      totalBytes: files.reduce((s, f) => s + f.size, 0),
      analyzedBytes: targets.reduce((s, f) => s + f.size, 0),
    },
    languages: languages(facts),
    databases: databases(facts),
    tech: techTable(facts, linked),
    files,
    tables: linked.tables,
    screens: linked.screens,
    menus: linked.menus,
    batches: linked.batches,
    sql: facts.sql,
    issues: notes,
  };
  report({ step: 6, stepName: STEPS[5], done: 1, total: 1, message: '완료' });
  return result;
}

/** 같은 종류 확인 필요 항목 합치기 */
function mergeIssues(list: AnalysisResult['issues']): AnalysisResult['issues'] {
  const out: AnalysisResult['issues'] = [];
  for (const i of list) {
    const same = out.find((x) => x.kind === i.kind && x.title === i.title);
    if (same) same.items.push(...i.items);
    else out.push({ ...i, items: [...i.items] });
  }
  return out.filter((i) => i.items.length);
}
