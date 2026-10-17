// 시스템 유형·언어·DB·기술 구성·한 줄 요약
import type { AnalysisResult, Confidence, Evidence, Facts, Lang, SystemType } from './types';
import type { Linked } from './link';
import { guessDomain } from './roles';

const PROGRAM_LANGS: Lang[] = ['Java', 'JSP', 'JavaScript', 'TypeScript', 'Vue', 'PHP', 'Go', 'Python', 'Kotlin', 'Dart', 'SQL', 'XML', 'HTML', 'CSS', 'Shell', 'Batch', 'PowerShell', 'Template', 'Groovy', 'C#', 'Swift'];

export function languages(facts: Facts): AnalysisResult['languages'] {
  const acc = new Map<Lang, { files: number; lines: number }>();
  for (const f of facts.files) {
    if (f.excluded || f.layer === 'TEST') continue;
    // DDL·데이터 스크립트는 프로그램 언어 비율에서 뺀다 (덤프 파일이 비율을 왜곡함)
    if (f.lang === 'SQL' && f.layer !== 'BATCH') continue;
    const lang: Lang = PROGRAM_LANGS.includes(f.lang) ? f.lang : 'Other';
    const a = acc.get(lang) ?? { files: 0, lines: 0 };
    a.files++;
    a.lines += f.lines;
    acc.set(lang, a);
  }
  const total = [...acc.values()].reduce((s, a) => s + a.lines, 0) || 1;
  return [...acc.entries()]
    .map(([name, a]) => ({ name, files: a.files, lines: a.lines, ratio: a.lines / total }))
    .sort((a, b) => b.lines - a.lines);
}

function confidence(w: number): Confidence {
  return w >= 5 ? '높음' : w >= 2 ? '보통' : '낮음';
}

export function databases(facts: Facts): AnalysisResult['databases'] {
  const dbHits = facts.tech.filter((t) => t.layer === 'DB' && t.name);
  const access = facts.tech.filter((t) => t.layer === '데이터 접근' && t.weight >= 1).sort((a, b) => b.weight - a.weight).map((t) => t.name);
  // SQL 문법 근거
  let ora = 0;
  let my = 0;
  for (const s of facts.sql) {
    const t = s.text;
    if (/\b(NVL|DECODE|ROWNUM|SYSDATE|NVL2|TO_CHAR|TO_DATE|CONNECT\s+BY|NEXTVAL|LISTAGG)\b|\(\+\)/i.test(t)) ora++;
    if (/\b(LIMIT\s+\d|LIMIT\s+:p|IFNULL|NOW\(\)|DATE_FORMAT|AUTO_INCREMENT|GROUP_CONCAT|STR_TO_DATE)\b|`/i.test(t)) my++;
  }
  const out: AnalysisResult['databases'] = [];
  const names = new Map<string, { weight: number; evidence: Evidence[] }>();
  for (const h of dbHits) {
    const n = names.get(h.name) ?? { weight: 0, evidence: [] };
    n.weight += h.weight;
    n.evidence.push(...h.evidence);
    names.set(h.name, n);
  }
  if (ora >= 3 && !names.has('Oracle')) names.set('Oracle', { weight: 2, evidence: [] });
  if (ora >= 1 && names.has('Oracle')) names.get('Oracle')!.weight += 1;
  if (my >= 3 && !names.has('MySQL') && !names.has('MariaDB')) names.set('MySQL 계열', { weight: 2, evidence: [] });
  // MySQL 드라이버만 있고 MariaDB도 같이 보이면 둘 다 표시, 구분 안 되면 MySQL 계열
  for (const [name, n] of [...names.entries()].sort((a, b) => b[1].weight - a[1].weight)) {
    if (name.startsWith('HSQLDB') && names.size > 1) continue;
    out.push({ type: name, access, evidence: n.evidence.slice(0, 6), confidence: confidence(n.weight) });
  }
  return out;
}

const TECH_LAYER_ORDER = ['화면', '컨트롤러', '서비스', '데이터 접근', 'DB', '배치', '앱', '설정', '빌드', '기타'];

export function techTable(facts: Facts, linked: Linked): AnalysisResult['tech'] {
  const rows: AnalysisResult['tech'] = [];
  const count = (pred: (l: string) => boolean) => facts.files.filter((f) => !f.excluded && pred(f.layer)).length;
  const names = (layer: string) =>
    facts.tech.filter((t) => t.layer === layer && t.name && t.weight >= 1).sort((a, b) => b.weight - a.weight).map((t) => t.name);
  for (const layer of TECH_LAYER_ORDER) {
    const n = names(layer);
    let files = 0;
    if (layer === '화면') files = count((l) => l === 'VIEW' || l === 'SCRIPT');
    else if (layer === '컨트롤러') files = count((l) => l === 'CONTROLLER' || l === 'ROUTE');
    else if (layer === '서비스') files = count((l) => l === 'SERVICE');
    else if (layer === '데이터 접근') files = count((l) => l === 'DAO' || l === 'MAPPER' || l === 'MODEL');
    else if (layer === 'DB') files = linked.tables.length;
    else if (layer === '배치') files = linked.batches.length;
    else if (layer === '설정') files = count((l) => l === 'CONFIG');
    if (layer === '서비스' && !n.length && files) n.push('서비스 계층');
    if (!n.length && !files) continue;
    if (!n.length && layer !== '화면' && layer !== '서비스') continue;
    rows.push({ layer, items: n.join(' · ') || '-', files });
  }
  return rows;
}

export function systemTypes(facts: Facts, linked: Linked): SystemType[] {
  const types: SystemType[] = [];
  const pages = linked.screens.filter((s) => s.kind !== 'api').length;
  const apis = linked.screens.filter((s) => s.kind === 'api').length;
  const has = (name: string) => facts.tech.some((t) => t.name === name && t.weight >= 2);
  if (has('Android') || has('Flutter') || has('React Native')) types.push('모바일 앱');
  if (pages > 0) types.push('웹');
  else if ((has('React') || has('Vue') || has('Angular')) && !apis) types.push('웹 프론트엔드');
  if (apis > 0 && pages === 0) types.push('API 서버');
  if (linked.batches.length > 0) types.push('배치');
  if (!types.length) types.push('라이브러리');
  return types;
}

export function describe(facts: Facts, linked: Linked, types: SystemType[], projectName: string): { title: string; summary: string; domainEstimated: boolean; confidence: Confidence; evidence: Evidence[] } {
  const fw = facts.tech.filter((t) => t.layer === '컨트롤러' && t.weight >= 2).sort((a, b) => b.weight - a.weight).map((t) => t.name);
  const egov = fw.includes('전자정부 표준프레임워크');
  const main = egov ? `전자정부 표준프레임워크(${fw.find((x) => x !== '전자정부 표준프레임워크') ?? 'Spring MVC'})` : fw[0];
  // 소스에 실제로 적힌 한글만 쓴다: 메뉴 데이터의 메뉴명, 화면 제목, DDL 주석 (영문 이름을 번역한 말은 빼서 오판을 줄임)
  const words = [
    ...linked.menus.filter((m) => !m.estimated && m.source !== 'url-guess').map((m) => m.name),
    ...linked.screens.filter((s) => s.evidence.some((e) => e.text && e.text.trim() === s.name)).map((s) => s.name),
    ...linked.tables.filter((t) => t.comment).map((t) => t.comment ?? ''),
  ].filter((w) => /[가-힣]/.test(w));
  const domain = guessDomain(words);
  const admin = /admin|관리자|mng|manage/i.test(projectName) || linked.screens.filter((s) => /관리/.test(s.name)).length > linked.screens.length * 0.3;
  const typeWord = types.includes('웹') ? (admin ? '관리자 웹' : '웹') : types.includes('API 서버') ? 'API 서버' : types.includes('모바일 앱') ? '모바일 앱' : types.includes('배치') ? '배치 시스템' : '시스템';
  const title = `${main ? `${main} 기반 ` : ''}${domain ? `${domain} ` : ''}${typeWord}`;
  const pages = linked.screens.filter((s) => s.kind !== 'api');
  const parts: string[] = [];
  if (pages.length) parts.push(`화면 ${pages.length}개`);
  const apis = linked.screens.length - pages.length;
  if (apis) parts.push(`API ${apis}개`);
  parts.push(`테이블 ${linked.tables.length}개`);
  if (linked.batches.length) parts.push(`배치 ${linked.batches.length}개`);
  // 가장 큰 그룹
  const groups = new Map<string, number>();
  for (const s of pages) groups.set(s.group, (groups.get(s.group) ?? 0) + 1);
  const big = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
  const domainText = domain ? `${domain} 업무를 다루는 ` : '';
  let summary = `${domainText}${typeWord}입니다. ${parts.join(', ')}로 이루어져 있습니다.`;
  if (big && big[1] >= 3 && pages.length >= 6) summary += ` ${big[0]} 아래 화면(${big[1]}개)이 가장 많습니다.`;
  const ev: Evidence[] = [];
  for (const t of facts.tech.filter((x) => x.weight >= 2).sort((a, b) => b.weight - a.weight).slice(0, 4)) ev.push(...t.evidence.slice(0, 1));
  const conf: Confidence = main && (pages.length || apis) ? '높음' : main || pages.length ? '보통' : '낮음';
  return { title, summary, domainEstimated: !!domain, confidence: conf, evidence: ev };
}
