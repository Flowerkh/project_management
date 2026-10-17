// 배치: crontab·Windows 작업 스케줄러(내보낸 XML) 실행 주기, 셸·배치·PowerShell 스크립트,
// Spring @Scheduled·<task:scheduled>, Quartz 작업
import type { Analyzer, Ctx } from '../context';
import type { BatchFact, FileInfo } from '../types';
import { baseName, makeLineIndex } from '../files';
import { compactSql, parseSql, splitStatements } from '../sql';
import { findByTail } from './jutil';
import { cronText } from '../link';

const CRON_FIELD = /^[\d*\/,\-A-Za-z?LW#]+$/;
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

function isCrontabName(f: FileInfo): boolean {
  const n = baseName(f.path).toLowerCase();
  return n === 'crontab' || n.endsWith('.crontab') || n.endsWith('.cron') || /^crontab[._-]/.test(n) || /(^|\/)cron\.d\//.test(f.path);
}

function looksLikeCrontab(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !/^[A-Z_]+=/.test(l));
  if (!lines.length) return false;
  const ok = lines.filter((l) => {
    const p = l.split(/\s+/);
    return (p.length >= 6 && p.slice(0, 5).every((x) => CRON_FIELD.test(x))) || /^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)\s/.test(l);
  });
  return ok.length >= Math.max(1, lines.length * 0.6);
}

function parseCrontab(f: FileInfo, text: string, ctx: Ctx): void {
  text.split('\n').forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith('#') || /^[A-Za-z_][\w]*\s*=/.test(l)) return;
    const mac = /^(@\w+)\s+(.+)$/.exec(l);
    if (mac) {
      if (mac[1] === '@reboot') return;
      const expr = MACROS[mac[1]];
      if (expr) ctx.facts.schedules.push({ expr, command: mac[2], evidence: { file: f.id, line: i + 1 } });
      return;
    }
    const p = l.split(/\s+/);
    if (p.length < 6 || !p.slice(0, 5).every((x) => CRON_FIELD.test(x))) return;
    let cmd = p.slice(5);
    // /etc/crontab 형식: 사용자 이름 열
    if (cmd.length > 1 && /^[a-z_][\w-]*$/.test(cmd[0]) && /[/\\]|\.sh\b/.test(cmd[1]) && !/\.(sh|py|bat|jar)$/.test(cmd[0])) cmd = cmd.slice(1);
    ctx.facts.schedules.push({ expr: p.slice(0, 5).join(' '), command: cmd.join(' '), evidence: { file: f.id, line: i + 1 } });
  });
}

/** Windows 작업 스케줄러 XML → cron 비슷한 식 */
function parseTaskXml(f: FileInfo, text: string, ctx: Ctx): void {
  const lineOf = makeLineIndex(text);
  const cmd = /<Command>([^<]*)<\/Command>/i.exec(text)?.[1]?.trim();
  if (!cmd) return;
  const args = /<Arguments>([^<]*)<\/Arguments>/i.exec(text)?.[1]?.trim() ?? '';
  const command = `${cmd} ${args}`.trim();
  const trigRe = /<(CalendarTrigger|TimeTrigger|DailyTrigger)\b[\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = trigRe.exec(text))) {
    const t = m[0];
    const sb = /<StartBoundary>[^T<]*T(\d{2}):(\d{2})/.exec(t);
    const hh = sb ? String(Number(sb[1])) : '0';
    const mm = sb ? String(Number(sb[2])) : '0';
    let expr = `${mm} ${hh} * * *`;
    const rep = /<Repetition>[\s\S]*?<Interval>PT(\d+)([MH])<\/Interval>/i.exec(t);
    if (/<ScheduleByMonth\b/i.test(t)) {
      const days = [...t.matchAll(/<Day>(\d+)<\/Day>/g)].map((x) => x[1]).join(',') || '1';
      expr = `${mm} ${hh} ${days} * *`;
    } else if (/<ScheduleByWeek\b/i.test(t)) {
      const map: Record<string, string> = { Sunday: '0', Monday: '1', Tuesday: '2', Wednesday: '3', Thursday: '4', Friday: '5', Saturday: '6' };
      const dows = Object.keys(map).filter((d) => new RegExp(`<${d}\\s*/>`).test(t)).map((d) => map[d]).join(',') || '*';
      expr = `${mm} ${hh} * * ${dows}`;
    } else if (rep) {
      expr = rep[2] === 'M' ? `*/${rep[1]} * * * *` : `${mm} */${rep[1]} * * *`;
    }
    ctx.facts.schedules.push({ expr, command, evidence: { file: f.id, line: lineOf(m.index) } });
    found = true;
  }
  if (found) f.layer = 'BATCH';
}

const SQL_CLIENT = /\b(sqlplus|mysql|mariadb|psql|sqlcmd|tbsql|isql|db2|clpplus|osql)\b/i;

function scriptKind(f: FileInfo): BatchFact['kind'] | null {
  if (f.lang === 'Shell') return 'shell';
  if (f.lang === 'Batch') return 'batch';
  if (f.lang === 'PowerShell') return 'powershell';
  if (f.lang === 'Python') return 'python';
  if (f.lang === 'JavaScript') return 'node';
  return null;
}

/**
 * 설명 문장을 짧은 이름으로 다듬기.
 * "X를 실행하는 Quartz Job 클래스를 정의한다" → "X 실행", "Y를 조회하는 Shell" → "Y 조회"
 */
export function tidyTitle(s: string): string {
  const orig = s.replace(/\s+/g, ' ').replace(/[.。]+$/, '').trim();
  let t = orig.replace(/\s*[을를]?\s*(?:정의|구현|선언)(?:한다|합니다|함|하는 클래스|한 클래스)$/, '');
  t = t.replace(/\s+(?:(?:Quartz|Spring)\s+)?(?:(?:Job|잡|배치)\s+)?(?:클래스|프로그램|모듈|구현체)$/i, '').replace(/\s+[Cc]lass$/, '');
  t = t.replace(/\s*(?:Shell|shell|쉘|셸|스크립트|[Ss]cript|배치|[Bb]atch)$/, '');
  t = t.replace(/\s*[을를]\s*위한$/, '');
  t = t.replace(/^(.+?)\s*[을를]\s*([^을를]+?)(?:하는|한다|합니다|함)$/, '$1 $2').replace(/(\S)(?:하는|한다|합니다)$/, '$1');
  if (t.length > 30) t = t.replace(/\s*\([^)]*\)/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t || orig;
}

const DESC_KEY = /^(desc|description|summary|purpose|설명|기능|목적|내용|개요|용도|처리\s*내용)$/i;
const NAME_KEY = /^((shell|script|batch|job|program|file)\s*(name|title)?|name|title|제목|명칭|이름|(프로그램|배치|작업|스크립트|쉘|셸|파일)\s*(명|이름))$/i;
const META_KEY = /^(author|date|since|version|see|copyright|history|created|modified|update[ds]?|작성자|작성일|수정자|수정일|변경일|버전|이력|생성일)$/i;
const FILE_LIKE = /^[\w.\-/\\]+\.(sh|ksh|bash|bat|cmd|ps1|py|js|sql|java)$/i;

/** 첫 설명 주석 (셸 #, 배치 REM ::, PowerShell #). "Description : …" 머리말이 있으면 그 값 */
function titleOf(text: string, kind: BatchFact['kind']): string | undefined {
  let named: string | undefined;
  for (const raw of text.split('\n').slice(0, 25)) {
    const l = raw.trim();
    if (!l || l.startsWith('#!') || /^@?echo\s+off/i.test(l)) continue;
    let c: string | undefined;
    if (kind === 'batch') c = /^@?(?:rem\b|::)\s*(.*)$/i.exec(l)?.[1];
    else if (kind === 'python') c = /^#\s*(.*)$/.exec(l)?.[1] ?? /^("""|''')\s*(.*?)\s*\1?$/.exec(l)?.[2];
    else if (kind === 'node') c = /^\/\/\s*(.*)$/.exec(l)?.[1] ?? /^\/\*+\s*(.*?)\s*\*?\/?$/.exec(l)?.[1];
    else c = /^#\s*(.*)$/.exec(l)?.[1];
    if (c === undefined) {
      if (kind === 'python' || kind === 'node') continue;
      break; // 첫 명령 줄을 만나면 멈춤
    }
    c = c.replace(/^[-=*#@\s]+|[-=*#\s]+$/g, '').trim();
    if (!c || /^(coding|-\*-|encoding|vim:|shellcheck|author|date|version|copyright|modification|history|change\s*log|수정일|변경\s*이력)/i.test(c) || FILE_LIKE.test(c)) continue;
    const kv = /^([A-Za-z가-힣][\w가-힣 ]{0,24}?)\s*[:：]\s*(.*)$/.exec(c);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (DESC_KEY.test(key)) {
        if (val) return tidyTitle(val);
        continue;
      }
      if (NAME_KEY.test(key)) {
        if (val && !FILE_LIKE.test(val) && !/^[\w.-]+$/.test(val)) named ??= tidyTitle(val);
        continue;
      }
      if (META_KEY.test(key)) continue;
    }
    if (named) return named;
    const head = c.split(/\s*[:：]\s+|\s+[-–]\s+/)[0].trim();
    return head ? tidyTitle(head) : undefined;
  }
  return named;
}

function isHelperOnly(text: string, kind: BatchFact['kind']): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^@?rem\b|^::/i.test(l) && !/^@echo/i.test(l));
  if (!lines.length) return true;
  const assign = kind === 'batch' ? /^set\s+\w+=|^setlocal|^endlocal/i : kind === 'powershell' ? /^\$[\w:]+\s*=/ : /^(export\s+)?[A-Za-z_]\w*=|^export\s|^umask\b|^ulimit\b/;
  return lines.every((l) => assign.test(l));
}

function analyzeScript(f: FileInfo, text: string, ctx: Ctx, kind: BatchFact['kind']): void {
  if (isHelperOnly(text, kind)) return;
  const lineOf = makeLineIndex(text);
  const b: BatchFact = { key: f.path, name: '', kind, entry: f.id, calls: [], sql: [], logs: [] };
  const t = titleOf(text, kind);
  if (t) b.title = t;
  const addCall = (kindC: BatchFact['calls'][number]['kind'], target: string, index: number) => {
    const tgt = target.replace(/^["']|["']$/g, '').replace(/[;,)]+$/, '');
    if (!tgt || b.calls.some((c) => c.kind === kindC && c.target === tgt)) return;
    const hit = kindC === 'class' ? undefined : findByTail(ctx, tgt.replace(/%[\w]+%|\$\{?\w+\}?/g, '').replace(/^\/+/, ''));
    b.calls.push({ kind: kindC, target: tgt, line: lineOf(index), ...(hit ? { file: hit.id } : {}) });
  };
  // heredoc SQL: sqlplus … <<EOF … EOF
  const heredoc = /\b(sqlplus|mysql|mariadb|psql|sqlcmd|tbsql|isql|db2)\b[^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:\n|$)/gi;
  let m: RegExpExecArray | null;
  const heredocRanges: [number, number][] = [];
  while ((m = heredoc.exec(text))) {
    const bodyStart = m.index + m[0].indexOf('\n') + 1;
    heredocRanges.push([m.index, m.index + m[0].length]);
    for (const st of splitStatements(m[3])) {
      const p = parseSql(st.sql);
      if (p.kind === 'ddl' || p.kind === 'other' || (!p.tables.length && p.kind !== 'call')) continue;
      const s = ctx.addSql({ file: f.id, line: lineOf(bodyStart + st.offset), origin: 'script', kind: p.kind, tables: p.tables, ...(p.dynamic ? { dynamic: true } : {}), text: compactSql(st.sql, 1200) });
      b.sql.push(s.id);
    }
  }
  const inHeredoc = (i: number) => heredocRanges.some(([a, z]) => i >= a && i < z);
  // 인라인 SQL: mysql -e "…", psql -c "…", sqlcmd -Q "…", Invoke-Sqlcmd -Query "…"
  const inline = /\b(?:mysql|mariadb|psql|sqlcmd|Invoke-Sqlcmd)\b[^\n]*?\s-(?:e|c|Q|q|Query)\s+(["'])([\s\S]*?)\1/gi;
  while ((m = inline.exec(text))) {
    const p = parseSql(m[2]);
    if (!p.tables.length) continue;
    b.sql.push(ctx.addSql({ file: f.id, line: lineOf(m.index), origin: 'script', kind: p.kind, tables: p.tables, text: compactSql(m[2], 1200) }).id);
  }
  // SQL 파일 실행
  const lines = text.split('\n');
  let off = 0;
  for (const line of lines) {
    const idx = off;
    off += line.length + 1;
    const l = line.trim();
    if (!l || l.startsWith('#') || /^(rem|::)\b/i.test(l) || inHeredoc(idx)) continue;
    if (SQL_CLIENT.test(l)) {
      const at = /(?:^|\s)@\s*([^\s;'"]+)/.exec(l.replace(/\S+@\S+/g, (w) => (w.startsWith('@') ? w : ' ')));
      const lt = /<\s*([^\s<|]+\.sql)\b/i.exec(l);
      const fl = /\s-(?:f|i)\s+([^\s]+\.sql)\b/i.exec(l) ?? /\b(?:source|\\\.)\s+([^\s;]+\.sql)/i.exec(l);
      const target = lt?.[1] ?? fl?.[1] ?? at?.[1];
      if (target && (/\.(sql|pls|prc|pkb)$/i.test(target) || /[\\/]/.test(target))) addCall('sql-file', target, idx);
    }
    // 다른 스크립트 호출 (source/. 환경 파일은 제외)
    if (/^(\.|source)\s+\S+/.test(l)) continue;
    const sh = /(?:^|[;&|]\s*)(?:(?:sh|bash|ksh|csh|zsh|nohup|exec|call|cmd(?:\.exe)?\s+\/c|start(?:\s+\/\w+)*|powershell(?:\.exe)?(?:\s+-\w+)*\s+-File)\s+)*["']?((?:[A-Za-z]:)?[^\s"';|&>]*?[\w-]+\.(?:sh|ksh|bash|bat|cmd|ps1))\b/i.exec(l);
    if (sh && baseName(sh[1].replace(/\\/g, '/')) !== baseName(f.path) && !/env|common|config|setenv|profile/i.test(baseName(sh[1].replace(/\\/g, '/')))) addCall('script', sh[1], idx);
    const java = /\bjava\b[^\n]*?\s-jar\s+([^\s]+\.jar)/.exec(l);
    if (java) addCall('program', java[1], idx);
    else {
      const jc = /\bjava\b(?:\s+-[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+((?:[a-z_][\w]*\.)+[A-Z][\w$]*)\b/.exec(l);
      if (jc) addCall('class', jc[1], idx);
    }
    const py = /\bpython\d?(?:\.exe)?\s+(?:-\w+\s+)*([^\s]+\.py)\b/.exec(l);
    if (py) addCall('program', py[1], idx);
    const nd = /\bnode(?:\.exe)?\s+([^\s]+\.js)\b/.exec(l);
    if (nd) addCall('program', nd[1], idx);
    // 로그 위치
    const lv = /\b(?:LOG|LOG_FILE|LOGFILE|LOG_PATH|log_file|logfile)\s*=\s*(.+)$/.exec(l);
    const raw = lv ? lv[1].replace(/^["']|["']\s*$/g, '') : />>?\s*([^\s|&;]+\.log)\b/.exec(l)?.[1] ?? /\btee\s+(?:-a\s+)?([^\s|&;]+)/.exec(l)?.[1];
    if (raw) {
      const p2 = raw
        .replace(/\$\(date\s+\+?['"]?%Y%m%d['"]?\)|`date \+%Y%m%d`|%date[^%]*%/gi, 'YYYYMMDD')
        .replace(/\$\{?LOG_DIR\}?|\$\{?LOGDIR\}?/g, 'logs')
        .split(/\s+/)[0];
      if (p2 && !b.logs.includes(p2) && p2 !== '/dev/null' && /\.log$|\/logs?\//.test(p2)) b.logs.push(p2);
    }
  }
  // 배치 폴더 밖의 실행만 하는 짧은 셸은 배치로 보지 않음 (빌드·배포 스크립트 등)
  const batchy = /(^|\/)(batch|batches|job|jobs|cron|crontab|scheduler|schedule|etl|daemon)(\/|$)/i.test(f.path) || /batch|job|cron|daily|monthly|weekly|sync|settle|stat(?!us|e)|clean|backup|migrate|dormant|purge|archive/i.test(baseName(f.path));
  const deployish = /(^|\/)(deploy|build|ci|docker|scripts?\/(build|deploy|release|install|setup))\b|(build|deploy|release|install|setup|start|stop|restart|run|gradlew|mvnw)\.(sh|bat|cmd|ps1)$/i.test(f.path);
  // 앱 패키지 안(src/main/resources, WEB-INF) 스크립트는 앱이 인자를 주고 실행하는 도구인 경우가 많음
  const inApp = /(^|\/)(src\/main\/(resources|webapp)|WEB-INF|WebContent)\//i.test(f.path);
  if (!b.sql.length && !batchy && (inApp || !b.calls.length)) return;
  if (deployish && !b.sql.length && !b.calls.some((c) => c.kind === 'sql-file')) return;
  b.name = b.title ?? baseName(f.path).replace(/\.\w+$/, '');
  ctx.facts.batches.push(b);
  if (f.layer !== 'TEST') f.layer = 'BATCH';
}

export const batchAnalyzer: Analyzer = {
  name: 'batch',
  order: 70,
  accepts(f, text) {
    if (f.layer === 'TEST') return false;
    if (isCrontabName(f)) return true;
    if (f.lang === 'XML') return /schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task/.test(text) || /<task:scheduled\b|CronTrigger(Factory)?Bean|JobDetail(Factory)?Bean/.test(text);
    if (f.lang === 'Shell' || f.lang === 'Batch' || f.lang === 'PowerShell') return true;
    if ((f.lang === 'Python' || f.lang === 'JavaScript') && /(^|\/)(batch|batches|job|jobs|cron|scheduler|etl)\//i.test(f.path) && !/(^|\/)(static|public|webapp|resources|assets|js)\//i.test(f.path)) return true;
    return false;
  },
  analyze(f, text, ctx) {
    if (f.lang === 'XML') {
      if (/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task/.test(text)) parseTaskXml(f, text, ctx);
      else springXml(f, text, ctx);
      return;
    }
    if (isCrontabName(f) || (f.lang === 'Shell' && !/\.(sh|ksh|bash|csh|zsh)$/i.test(f.path) && looksLikeCrontab(text))) {
      parseCrontab(f, text, ctx);
      f.layer = 'BATCH';
      return;
    }
    const kind = scriptKind(f);
    if (kind) analyzeScript(f, text, ctx, kind);
  },
  finish(ctx) {
    // Spring @Scheduled 메서드
    const have = new Set(ctx.facts.batches.map((b) => `${b.unit}#${b.method}`));
    for (const u of ctx.facts.units) {
      for (const m of u.methods) {
        if (!m.schedule || have.has(`${u.name}#${m.name}`)) continue;
        const title = titleFromDoc(m.doc) ?? titleFromDoc(u.doc);
        ctx.facts.batches.push({
          key: `${u.fqn ?? u.name}#${m.name}`,
          name: title ?? `${u.name}.${m.name}`,
          ...(title ? { title } : {}),
          kind: 'spring-scheduled',
          entry: u.file,
          unit: u.name,
          method: m.name,
          schedule: { expr: m.schedule, text: scheduleText(m.schedule), evidence: { file: u.file, line: m.line } },
          calls: [],
          sql: [],
          logs: [],
        });
        have.add(`${u.name}#${m.name}`);
      }
    }
    // XML로 등록한 스케줄(<task:scheduled>, Quartz CronTrigger)
    const st = pending.get(ctx) ?? [];
    for (const p of st) {
      const units = ctx.facts.units.filter((u) => (p.bean && (u.beanName === p.bean || u.name.toLowerCase() === p.bean.toLowerCase())) || (p.cls && (u.fqn === p.cls || u.name === p.cls.split('.').pop())));
      for (const u of units) {
        const method = p.method ?? u.methods.find((m) => /^(execute|executeInternal|run|process)$/.test(m.name))?.name;
        if (have.has(`${u.name}#${method}`)) continue;
        const title = titleFromDoc(u.methods.find((m) => m.name === method)?.doc) ?? titleFromDoc(u.doc);
        ctx.facts.batches.push({
          key: `${u.fqn ?? u.name}#${method}`,
          name: title ?? `${u.name}${method ? `.${method}` : ''}`,
          ...(title ? { title } : {}),
          kind: p.quartz ? 'quartz' : 'spring-scheduled',
          entry: u.file,
          unit: u.name,
          ...(method ? { method } : {}),
          ...(p.expr ? { schedule: { expr: p.expr, text: scheduleText(p.expr), evidence: p.evidence } } : {}),
          calls: [],
          sql: [],
          logs: [],
        });
        have.add(`${u.name}#${method}`);
      }
    }
    // 스케줄 없는 Quartz 작업 클래스
    for (const u of ctx.facts.units) {
      if (u.kind !== 'job') continue;
      const method = u.methods.find((m) => /^(execute|executeInternal|run|process)$/.test(m.name))?.name;
      if (have.has(`${u.name}#${method}`) || ctx.facts.batches.some((b) => b.unit === u.name)) continue;
      const title = titleFromDoc(u.doc);
      ctx.facts.batches.push({ key: `${u.fqn ?? u.name}#${method}`, name: title ?? u.name, ...(title ? { title } : {}), kind: 'quartz', entry: u.file, unit: u.name, ...(method ? { method } : {}), calls: [], sql: [], logs: [] });
    }
  },
};

interface PendingSched {
  bean?: string;
  cls?: string;
  method?: string;
  expr?: string;
  quartz: boolean;
  evidence: { file: string; line: number };
}
const pending = new WeakMap<Ctx, PendingSched[]>();

function springXml(f: FileInfo, text: string, ctx: Ctx): void {
  const lineOf = makeLineIndex(text);
  const list = pending.get(ctx) ?? [];
  pending.set(ctx, list);
  for (const m of text.matchAll(/<task:scheduled\b([^>]*)\/?>/g)) {
    const a = m[1];
    const ref = /\bref\s*=\s*"([^"]+)"/.exec(a)?.[1];
    const method = /\bmethod\s*=\s*"([^"]+)"/.exec(a)?.[1];
    const cron = /\bcron\s*=\s*"([^"]+)"/.exec(a)?.[1];
    const fixed = /\bfixed-(?:delay|rate)\s*=\s*"([^"]+)"/.exec(a)?.[1];
    if (ref) list.push({ bean: ref, method, expr: cron ?? (fixed ? `fixedDelay=${fixed}` : undefined), quartz: false, evidence: { file: f.id, line: lineOf(m.index ?? 0) } });
  }
  // Quartz: JobDetail(jobClass) ← CronTrigger(jobDetail, cronExpression)
  const jobs = new Map<string, string>();
  for (const m of text.matchAll(/<bean\b[^>]*\bid\s*=\s*"([^"]+)"[^>]*class\s*=\s*"[^"]*JobDetail[^"]*"[^>]*>([\s\S]*?)<\/bean>/g)) {
    const cls = /<property\s+name\s*=\s*"jobClass"\s+value\s*=\s*"([^"]+)"/.exec(m[2])?.[1];
    const target = /<property\s+name\s*=\s*"targetObject"\s+ref\s*=\s*"([^"]+)"/.exec(m[2])?.[1];
    const tm = /<property\s+name\s*=\s*"targetMethod"\s+value\s*=\s*"([^"]+)"/.exec(m[2])?.[1];
    if (cls) jobs.set(m[1], `class:${cls}`);
    else if (target) jobs.set(m[1], `bean:${target}#${tm ?? ''}`);
  }
  for (const m of text.matchAll(/<bean\b[^>]*class\s*=\s*"[^"]*CronTrigger[^"]*"[^>]*>([\s\S]*?)<\/bean>/g)) {
    const jd = /<property\s+name\s*=\s*"jobDetail"\s+ref\s*=\s*"([^"]+)"/.exec(m[1])?.[1];
    const cron = /<property\s+name\s*=\s*"cronExpression"\s+value\s*=\s*"([^"]+)"/.exec(m[1])?.[1];
    const j = jd ? jobs.get(jd) : undefined;
    if (!j) continue;
    const ev = { file: f.id, line: lineOf(m.index ?? 0) };
    if (j.startsWith('class:')) list.push({ cls: j.slice(6), expr: cron, quartz: true, evidence: ev });
    else {
      const [bean, method] = j.slice(5).split('#');
      list.push({ bean, method: method || undefined, expr: cron, quartz: true, evidence: ev });
    }
  }
}

function titleFromDoc(doc?: string): string | undefined {
  if (!doc) return undefined;
  const head = tidyTitle(doc.split(/\s*[:：]\s+|\s+[-–]\s+/)[0]);
  if (!head || head.length > 40 || /^[\w\s.,()]+$/.test(head) && !/[가-힣]/.test(head) && head.split(/\s+/).length > 6) return undefined;
  return head;
}

function scheduleText(expr: string): string {
  const fx = /^fixed(Delay|Rate)=(\d+)$/.exec(expr);
  if (fx) {
    const ms = Number(fx[2]);
    const t = ms % 3600000 === 0 ? `${ms / 3600000}시간` : ms % 60000 === 0 ? `${ms / 60000}분` : `${ms / 1000}초`;
    return `${t}마다`;
  }
  return cronText(expr);
}
