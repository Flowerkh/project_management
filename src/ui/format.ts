import type { Confidence, Crud, Layer } from '../engine/types';

export const fmtNum = (n: number) => n.toLocaleString('ko-KR');

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(s, ms > 0 ? 1 : 0)}초`;
  const m = Math.floor(s / 60);
  return `${m}분 ${s % 60}초`;
}

export function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function timeOfDay(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const CONF_TONE: Record<Confidence, string> = { 높음: 'ok', 보통: 'warn', 낮음: 'err' };

export const LAYER_LABEL: Record<Layer | 'TABLE' | 'SCHEDULE', string> = {
  VIEW: 'View',
  SCRIPT: 'Script',
  CONTROLLER: 'Controller',
  SERVICE: 'Service',
  DAO: 'DAO',
  MAPPER: 'Mapper',
  MODEL: 'Model',
  ROUTE: 'Route',
  CONFIG: '설정',
  DDL: 'DDL',
  MENU_DATA: '메뉴 데이터',
  BATCH: '배치',
  TEST: '테스트',
  STYLE: 'CSS',
  OTHER: '기타',
  TABLE: '테이블',
  SCHEDULE: '스케줄',
};

/** 흐름 상자 제목 */
export const FLOW_LABEL: Record<string, string> = {
  VIEW: '화면',
  SCRIPT: '스크립트',
  CONTROLLER: '컨트롤러',
  SERVICE: '서비스',
  DAO: 'DAO',
  MAPPER: '매퍼',
  MODEL: '모델',
  ROUTE: '라우트',
  TABLE: '테이블',
  SCHEDULE: '스케줄',
  BATCH: '스크립트',
  DDL: 'SQL',
  CONFIG: '설정',
  OTHER: '기타',
};

export const CRUD_ORDER: Crud[] = ['C', 'R', 'U', 'D'];

export const LANG_COLORS: Record<string, string> = {
  Java: '#2457D6',
  JSP: '#14918A',
  JavaScript: '#D9A21B',
  TypeScript: '#3178C6',
  PHP: '#7A5CC4',
  Go: '#00A3C4',
  Python: '#3B7DBF',
  XML: '#8C59D9',
  SQL: '#D9465F',
  HTML: '#E06C3B',
  CSS: '#5B8DEF',
  Shell: '#4E8F3A',
  Batch: '#6F7F3A',
  PowerShell: '#2F5C9E',
  Kotlin: '#A97BFF',
  Dart: '#0E8FA8',
  Vue: '#3FA36B',
  Template: '#B07A2E',
  Properties: '#8A97A6',
  YAML: '#A0717F',
  JSON: '#6B7785',
};
export const langColor = (name: string) => LANG_COLORS[name] ?? '#9AA5B1';

export function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  } catch {
    /* 아래로 */
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function safeStorage<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장소를 쓸 수 없는 환경 */
  }
}
