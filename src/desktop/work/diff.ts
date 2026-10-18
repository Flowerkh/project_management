// 변경 비교: 원본 ↔ 작업 사본(또는 적용 전 ↔ 적용 후)을 줄 번호가 붙은 묶음(hunk)으로. 묶음마다 감싼 함수 이름을 찾는다.
import { diffLines, structuredPatch } from 'diff';
import type { DiffHunk, DiffLine } from '../../shared/desktop-api';

const KW = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw', 'else', 'do', 'try', 'synchronized', 'foreach', 'elseif', 'elif',
  'super', 'this', 'sizeof', 'typeof', 'await', 'when', 'with', 'using', 'lock', 'select', 'from', 'where', 'and', 'or', 'not', 'in',
  'function', 'fn', 'func', 'def', 'print', 'echo', 'assert', 'yield', 'delete', 'case', 'import', 'require', 'include',
]);
const STMT_START = /^\s*(return|new|throw|else|case|await|yield|delete|typeof|echo|print|import|package|if|for|while|switch|catch|do|try)\b/;

/** 한 줄이 함수·메서드·매퍼 SQL의 시작이면 그 이름 */
export function fnOfLine(line: string): string | undefined {
  // MyBatis·iBatis: <select id="selectOrder" …>
  let m = /^\s*<(select|insert|update|delete|sql|statement|procedure)\b[^>]*\bid\s*=\s*["']([\w.$-]+)["']/i.exec(line);
  if (m) return m[2];
  // SQL 프로시저·함수
  m = /^\s*(?:create\s+(?:or\s+replace\s+)?)?(?:procedure|function)\s+([\w.$"]+)/i.exec(line);
  if (m && /^\s*create|^\s*(procedure|function)\s+[\w.$"]+\s*(\(|is\b|as\b|$)/i.test(line)) return `${m[1].replace(/"/g, '')}()`;
  // Go
  m = /^\s*func\s+(?:\([^)]*\)\s*)?([\w]+)\s*[([]/.exec(line);
  if (m) return `${m[1]}()`;
  // Python
  m = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(line);
  if (m) return `${m[1]}()`;
  // PHP·JS function
  m = /^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|protected|private|static|final|abstract|async)\s+)*function\s*\*?\s*&?\s*([\w$]+)\s*\(/.exec(line);
  if (m) return `${m[1]}()`;
  // JS: const name = (…) => / name = function
  m = /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.exec(line);
  if (m) return `${m[1]}()`;
  m = /^\s*([\w$]+)\s*:\s*(?:async\s*)?function\b/.exec(line);
  if (m) return `${m[1]}()`;
  // Java·Kotlin·C#·JS 클래스 메서드: [수식어] [반환형] 이름(인자) [throws …] {
  if (STMT_START.test(line) || /^\s*[}).@*/#<]/.test(line)) return undefined;
  m = /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|override|virtual|async|internal|open|suspend|inline|operator|strictfp|transient)\s+)*(?:fun\s+)?(?:[\w$][\w$.?]*(?:<[^()]*>)?(?:\[\])*\??\s+)?([\w$]+)\s*\(([^;=]*)$/.exec(line);
  if (m && !KW.has(m[1]) && !/=/.test(line.slice(0, line.indexOf('(')))) {
    // 호출문(foo(bar);)·조건문은 위에서 걸렀다. 인자 괄호가 닫히고 '{'나 throws로 끝나거나 줄이 이어지는 경우만
    const tail = m[2];
    if (/\)\s*(throws\s+[\w.,\s]+)?\s*(\{.*)?$/.test(tail) || !tail.includes(')') || /\)\s*:\s*[\w<>[\]?,.\s]+\s*\{?\s*$/.test(tail)) return `${m[1]}()`;
  }
  return undefined;
}

/** text의 lineIdx(0부터) 줄에서 위로 올라가며 감싼 함수 이름 */
export function enclosingFn(lines: string[], lineIdx: number, max = 400): string | undefined {
  for (let i = Math.min(lineIdx, lines.length - 1), k = 0; i >= 0 && k < max; i--, k++) {
    const f = fnOfLine(lines[i]);
    if (f) return f;
  }
  return undefined;
}

export interface Hunks {
  hunks: DiffHunk[];
  plus: number;
  minus: number;
  /** 변경이 너무 커서 묶음을 만들지 않음 (plus·minus는 줄 수) */
  tooBig?: boolean;
}

function lineCount(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.endsWith('\n') ? n - 1 : n;
}

/** 원본 텍스트 → 새 텍스트 묶음. 앞뒤 3줄, 줄 끝 \r 무시 */
export function buildHunks(oldText: string, newText: string, context = 3): Hunks {
  const p = structuredPatch('a', 'b', oldText, newText, undefined, undefined, { context, stripTrailingCr: true, maxEditLength: 40000, timeout: 5000 });
  if (!p) return { hunks: [], plus: lineCount(newText), minus: lineCount(oldText), tooBig: true };
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let plus = 0;
  let minus = 0;
  const hunks: DiffHunk[] = [];
  for (const h of p.hunks) {
    // jsdiff: 빈 범위(새 파일·지운 파일)도 oldStart·newStart는 다음 줄 번호(1부터)
    let o = h.oldStart;
    let n = h.newStart;
    const lines: DiffLine[] = [];
    for (const raw of h.lines) {
      const t = raw[0];
      const s = raw.slice(1);
      if (t === ' ') lines.push({ t: ' ', s, o: o++, n: n++ });
      else if (t === '-') {
        lines.push({ t: '-', s, o: o++ });
        minus++;
      } else if (t === '+') {
        lines.push({ t: '+', s, n: n++ });
        plus++;
      }
    }
    // 감싼 함수: 바뀐 첫 줄(더한 줄이 함수 머리면 그것) → 원본에서 위로 → 새 텍스트에서 위로
    const first = lines.findIndex((l) => l.t !== ' ');
    const before = lines.slice(0, Math.max(0, first)).reverse();
    const firstAdd = lines.find((l) => l.t === '+');
    let fn: string | undefined = firstAdd && first >= 0 && lines[first] === firstAdd ? fnOfLine(firstAdd.s) : undefined;
    if (!fn && oldText && first >= 0) {
      const fl = lines[first];
      const at = fl.t === '-' ? fl.o! - 1 : (before.find((l) => l.o)?.o ?? 1) - 1;
      fn = enclosingFn(oldLines, Math.max(0, at));
    }
    if (!fn && first >= 0) {
      const at = (firstAdd?.n ?? before.find((l) => l.n)?.n ?? 1) - 1;
      fn = enclosingFn(newLines, Math.max(0, at));
    }
    hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines, ...(fn ? { fn } : {}) });
  }
  return { hunks, plus, minus };
}

/**
 * 값을 가린 파일 적용: 가린 원본(red) → 작업 사본(copy)의 줄 변경을 실제 원본(real)에 옮긴다.
 * 바뀌지 않은 줄은 실제 원본 줄을 그대로 써서 가린 값(****)이 원래 값으로 돌아간다.
 */
export function mergeRedacted(real: string, red: string, copy: string): string {
  const split = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const realLines = split(real);
  const redLines = split(red);
  if (realLines.length !== redLines.length) throw new Error('값을 가린 파일의 줄이 원본과 맞지 않아 적용할 수 없습니다');
  const parts = diffLines(red, copy);
  let i = 0;
  let out = '';
  for (const part of parts) {
    const n = part.count ?? split(part.value).length;
    if (part.added) out += part.value;
    else if (part.removed) i += n;
    else {
      out += realLines.slice(i, i + n).join('');
      i += n;
    }
  }
  return out;
}
