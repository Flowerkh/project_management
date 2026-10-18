// [Claude에게 묻기]로 대화를 시작할 때 붙이는 맥락 (SCR-09 ② 맥락 칩).
// 선택한 화면·테이블·메뉴·배치의 관련 파일·사용 테이블·호출 흐름과 시스템 요약을 글로 만든다. 접속 정보는 넣지 않는다.
import type { AnalysisResult, Crud } from '../../../engine/types';
import type { ChatContext } from '../../../shared/desktop-api';
import { menuPath, menuScreens, type Model, type Target, tableOf } from '../../model';

const crudText = (c: Crud[]) => c.join('');

function filesText(model: Model, ids: string[], max = 40): string {
  const lines: string[] = [];
  for (const id of ids.slice(0, max)) {
    const f = model.fileById.get(id);
    if (f) lines.push(`- ${f.path} (${f.layer})`);
  }
  if (ids.length > max) lines.push(`- 외 ${ids.length - max}개`);
  return lines.join('\n');
}

function tablesText(model: Model, list: { table: string; crud: Crud[] }[], max = 40): string {
  return list
    .slice(0, max)
    .map((t) => {
      const tr = tableOf(model, t.table);
      return `- ${t.table} ${crudText(t.crud)}${tr?.comment ? ` (${tr.comment})` : tr?.role ? ` (${tr.role})` : ''}`;
    })
    .join('\n');
}

export function summaryText(r: AnalysisResult): string {
  const langs = r.languages.filter((l) => l.name !== 'Other').slice(0, 4).map((l) => `${l.name} ${Math.round(l.ratio * 100)}%`).join(', ');
  const dbs = r.databases.map((d) => `${d.type}${d.access.length ? ` (${d.access.slice(0, 2).join(', ')})` : ''}`).join(', ');
  const pages = r.screens.filter((s) => s.kind !== 'api').length;
  const apis = r.screens.length - pages;
  return [
    `프로젝트: ${r.project.name}`,
    `시스템: ${r.project.title}`,
    `요약: ${r.project.summary}`,
    `유형: ${r.project.types.join(', ')}`,
    langs && `언어: ${langs}`,
    dbs && `DB: ${dbs}`,
    `화면 ${pages}개${apis ? `, API ${apis}개` : ''}, 테이블 ${r.tables.length}개, 메뉴 ${r.menus.length}개, 배치 ${r.batches.length}개`,
    r.tech.length ? `기술 구성: ${r.tech.map((t) => `${t.layer} ${t.items}`).join(' / ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 대화 맥락. 결과가 없거나 요약 화면이면 시스템 요약만 */
export function buildChatContext(model: Model | null, target: Target): ChatContext | undefined {
  if (!model) return undefined;
  const r = model.r;
  const chips: ChatContext['chips'] = [];
  let title = r.project.name;
  if (target.kind === 'screen') {
    const s = model.screenById.get(target.id);
    if (s) {
      title = s.name;
      const path = menuPath(model, s.menu).map((m) => m.name).join(' > ');
      chips.push({
        kind: 'screen',
        label: s.name,
        text: [`화면: ${s.name} (${s.kind === 'api' ? 'API' : s.kind === 'popup' ? '팝업' : '화면'})`, s.url && `URL: ${s.urls.join(', ')}`, path && `메뉴: ${path}`, `역할: ${s.role}`].filter(Boolean).join('\n'),
      });
      const fileIds = s.files.map((f) => f.file);
      if (fileIds.length) chips.push({ kind: 'file', label: `파일 ${fileIds.length}`, text: `관련 파일:\n${filesText(model, fileIds)}` });
      if (s.tables.length) chips.push({ kind: 'table', label: `테이블 ${s.tables.length}`, text: `사용 테이블(CRUD):\n${tablesText(model, s.tables)}` });
      const flow = s.flow.map((f) => f.symbol).join(' → ');
      const calls = s.calls.slice(0, 20).map((c) => `- ${c.url}${c.handler ? ` → ${c.handler}` : ''}${c.tables.length ? ` (${c.tables.map((t) => `${t.table} ${crudText(t.crud)}`).join(', ')})` : ''}`);
      if (flow || calls.length) chips.push({ kind: 'flow', label: '호출 흐름', text: [flow && `대표 흐름: ${flow}`, calls.length ? `호출 URL:\n${calls.join('\n')}` : ''].filter(Boolean).join('\n') });
    }
  } else if (target.kind === 'table') {
    const t = model.tableById.get(target.id);
    if (t) {
      title = t.name;
      const cols = t.columns.slice(0, 60).map((c) => `- ${c.name}${c.type ? ` ${c.type}` : ''}${c.pk ? ' PK' : ''}${c.comment ? ` (${c.comment})` : ''}`);
      chips.push({ kind: 'table', label: t.name, text: [`테이블: ${t.name}${t.comment ? ` (${t.comment})` : ''}`, `역할: ${t.role}`, cols.length ? `컬럼:\n${cols.join('\n')}` : '컬럼: DDL 없음'].join('\n') });
      const used = t.usedBy.slice(0, 40).map((u) => {
        const name = u.kind === 'screen' ? model.screenById.get(u.id)?.name : model.batchById.get(u.id)?.name;
        return `- ${u.kind === 'screen' ? '화면' : '배치'} ${name ?? u.id} ${crudText(u.crud)}`;
      });
      if (used.length) chips.push({ kind: 'screen', label: `사용 화면·배치 ${t.usedBy.length}`, text: `이 테이블을 쓰는 화면·배치:\n${used.join('\n')}` });
      if (t.files.length) chips.push({ kind: 'file', label: `파일 ${t.files.length}`, text: `관련 파일:\n${filesText(model, t.files)}` });
    }
  } else if (target.kind === 'menu') {
    const m = model.menuById.get(target.id);
    if (m) {
      title = m.name;
      const path = menuPath(model, m.id).map((x) => x.name).join(' > ');
      const screens = menuScreens(model, m.id);
      chips.push({ kind: 'menu', label: m.name, text: [`메뉴: ${path || m.name}`, m.url && `URL: ${m.url}`, `하위 화면: ${screens.map((s) => s.name).slice(0, 40).join(', ') || '없음'}`].filter(Boolean).join('\n') });
      if (m.tables.length) chips.push({ kind: 'table', label: `테이블 ${m.tables.length}`, text: `하위 화면이 쓰는 테이블:\n${tablesText(model, m.tables)}` });
      const files = [...new Set(screens.flatMap((s) => s.files.map((f) => f.file)))];
      if (files.length) chips.push({ kind: 'file', label: `파일 ${files.length}`, text: `관련 파일:\n${filesText(model, files)}` });
    }
  } else if (target.kind === 'batch') {
    const b = model.batchById.get(target.id);
    if (b) {
      title = b.name;
      chips.push({
        kind: 'batch',
        label: b.name,
        text: [`배치: ${b.name}`, b.schedule ? `실행 주기: ${b.schedule.text} (${b.schedule.expr})` : '실행 주기: 찾지 못함', `역할: ${b.role}`, `실행 흐름: ${b.flow.map((f) => f.symbol).join(' → ')}`].join('\n'),
      });
      if (b.tables.length) chips.push({ kind: 'table', label: `테이블 ${b.tables.length}`, text: `사용 테이블(CRUD):\n${tablesText(model, b.tables)}` });
      if (b.files.length) chips.push({ kind: 'file', label: `파일 ${b.files.length}`, text: `관련 파일:\n${filesText(model, b.files)}` });
    }
  }
  chips.push({ kind: 'summary', label: '시스템 요약', text: summaryText(r) });
  return { title, chips };
}
