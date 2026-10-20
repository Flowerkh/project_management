// 앱이 AI에게 알려 주는 도구 (Gemini·ChatGPT 공통 — 둘 다 앱 도구로 일한다)와 Claude 도구 모양으로 바꾸기.
// 바꾼 이름·입력으로 권한 확인(guards.ts)·작업 내역 요약(activity.ts)을 Claude와 같이 쓴다.
//   정의는 JSON Schema(소문자 type). Gemini는 OpenAPI Schema(대문자 type, enum에 format)로 바꿔 보낸다.

type Schema = Record<string, unknown>;

const S = (description: string): Schema => ({ type: 'string', description });
const I = (description: string): Schema => ({ type: 'integer', description });
const B = (description: string): Schema => ({ type: 'boolean', description });
const ENV: Schema = { type: 'string', enum: ['dev', 'qa', 'prod'], description: 'dev(기본) · qa · prod' };
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Schema;
}

export interface ToolSetOptions {
  readOnly: boolean;
  shell: boolean;
}

/** 앱 도구 목록. shell이면 run_command도 (readOnly면 수정·명령·계획 승인 도구는 없음) */
export function agentTools(o: ToolSetOptions): ToolDecl[] {
  const t: ToolDecl[] = [
    { name: 'list_dir', description: '폴더의 하위 폴더·파일 이름을 본다. path는 작업 폴더 기준 상대 경로 (비우면 작업 폴더).', parameters: obj({ path: S('작업 폴더 기준 상대 경로') }) },
    {
      name: 'glob',
      description: "glob 패턴에 맞는 파일 경로를 찾는다 (최근에 바뀐 파일부터). 예: '**/*.java', 'src/**/Order*.xml', '*Mapper.xml'('/'가 없으면 모든 폴더에서 파일 이름으로).",
      parameters: obj({ pattern: S('glob 패턴'), path: S('찾을 폴더 (비우면 작업 폴더)') }, ['pattern']),
    },
    {
      name: 'grep',
      description: "파일 내용에서 정규식(JavaScript 문법)을 찾는다. 결과는 '경로:줄 번호: 내용'. glob으로 파일을 거르고(예: '*.java'), output='files'면 파일 목록만.",
      parameters: obj(
        {
          pattern: S('찾을 정규식'),
          path: S('찾을 폴더나 파일 (비우면 작업 폴더)'),
          glob: S("파일 이름 거르기 (예: '*.xml', 'src/**/*.jsp')"),
          ignore_case: B('대소문자 무시'),
          output: { type: 'string', enum: ['lines', 'files'], description: 'lines(기본, 맞는 줄) · files(파일 목록만)' },
        },
        ['pattern'],
      ),
    },
    {
      name: 'read_file',
      description: '파일을 읽는다. 각 줄 앞에 줄 번호가 붙는다. 긴 파일은 offset(시작 줄)·limit(줄 수, 최대 2000)로 나눠 읽는다.',
      parameters: obj({ path: S('작업 폴더 기준 상대 경로'), offset: I('시작 줄 번호 (1부터)'), limit: I('읽을 줄 수') }, ['path']),
    },
    { name: 'db_list', description: '이 프로젝트에 연결된 DB 목록(환경·DB 이름·종류)을 본다. 접속 주소·계정은 주지 않는다.', parameters: obj({}) },
    {
      name: 'db_select',
      description: 'SELECT 문 하나를 실행해 결과를 본다. 기본은 개발(dev) DB. QA(qa)·운영(prod)은 사용자가 그 환경을 말했을 때만 env로 지정한다. 운영 조회는 사용자가 매번 확인하고, 개인정보 컬럼은 가려진다. SELECT가 아닌 쿼리는 실행되지 않는다.',
      parameters: obj({ sql: S('실행할 SELECT 문 하나 (세미콜론 없이)'), env: ENV, max_rows: I('최대 행 수 (환경 규칙의 한도를 넘지 않음)') }, ['sql']),
    },
    {
      name: 'db_propose_change',
      description: 'INSERT·UPDATE·DELETE·MERGE·DDL·프로시저 호출 등 SELECT가 아닌 쿼리를 제안한다. 실행하지 않고 사용자 화면에 쿼리 카드로 보여 주며, 사용자가 확인한 뒤 실행한다.',
      parameters: obj({ sql: S('제안할 SQL 문 하나'), env: ENV, description: S('이 쿼리가 하는 일과 이유 (한국어 한두 문장)'), revert_sql: S('되돌리는 SQL (가능하면)') }, ['sql', 'description']),
    },
  ];
  if (!o.readOnly) {
    t.push(
      {
        name: 'edit_file',
        description: '파일에서 old_string(들여쓰기·공백까지 정확히 일치)을 new_string으로 바꾼다. 먼저 read_file로 읽고 쓴다. 같은 글이 여러 곳이면 앞뒤 줄을 더 넣어 한 곳만 맞게 하거나 replace_all=true. 수정 허용 모드에서만 된다.',
        parameters: obj({ path: S('작업 폴더 기준 상대 경로'), old_string: S('바꿀 원래 글'), new_string: S('새 글'), replace_all: B('맞는 곳을 모두 바꿈') }, ['path', 'old_string', 'new_string']),
      },
      {
        name: 'write_file',
        description: '파일을 새로 만들거나 전체 내용을 다시 쓴다 (부분 수정은 edit_file). 수정 허용 모드에서만 된다.',
        parameters: obj({ path: S('작업 폴더 기준 상대 경로'), content: S('파일 전체 내용') }, ['path', 'content']),
      },
      {
        name: 'exit_plan_mode',
        description: '계획 모드에서 수정 계획을 사용자에게 제시하고 승인([수정 진행]·[계획 확정])을 받는다. 승인되면 수정 허용 모드가 되어 파일을 고칠 수 있다. 거절되면 계획 모드를 유지한다.',
        parameters: obj({ plan: S('사용자에게 보일 계획 (Markdown: 원인·고칠 파일·바꿀 내용·영향)') }, ['plan']),
      },
    );
  }
  if (o.shell && !o.readOnly) {
    t.push({
      name: 'run_command',
      description: '작업 폴더에서 셸 명령 하나를 실행한다. 허용 목록에 있는 명령만 되고, 실행할 때마다 사용자가 확인한다. 끝날 때까지 기다리는 명령만 쓴다.',
      parameters: obj({ command: S('실행할 명령') }, ['command']),
    });
  }
  return t;
}

/** JSON Schema → Gemini OpenAPI Schema (type 대문자, 글자 enum에 format: enum) */
export function toGeminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toUpperCase();
    else if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === 'items') out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  if (Array.isArray(out.enum) && out.type === 'STRING') out.format = 'enum';
  return out;
}

/** Gemini functionDeclarations */
export function geminiTools(o: ToolSetOptions): { name: string; description: string; parameters: unknown }[] {
  return agentTools(o).map((d) => ({ name: d.name, description: d.description, parameters: toGeminiSchema(d.parameters) }));
}

/** Codex 동적 도구 (thread/start dynamicTools) */
export function codexTools(o: ToolSetOptions): { type: 'function'; name: string; description: string; inputSchema: Schema }[] {
  return agentTools(o).map((d) => ({ type: 'function', name: d.name, description: d.description, inputSchema: d.parameters }));
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
const env = (v: unknown) => (v === 'dev' || v === 'qa' || v === 'prod' ? v : undefined);
const def = <T extends Record<string, unknown>>(o: T): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));

/** 앱 도구 호출 → Claude 도구 이름·입력 (모르는 도구는 null) */
export function toClaudeTool(name: string, args: Record<string, unknown> | undefined): { name: string; input: Record<string, unknown> } | null {
  const a = args ?? {};
  switch (name) {
    case 'list_dir':
      return { name: 'LS', input: { path: str(a.path) || '.' } };
    case 'glob':
      return { name: 'Glob', input: def({ pattern: str(a.pattern) ?? '', path: str(a.path) }) };
    case 'grep':
      return { name: 'Grep', input: def({ pattern: str(a.pattern) ?? '', path: str(a.path), glob: str(a.glob), '-i': a.ignore_case === true ? true : undefined, output_mode: a.output === 'files' ? 'files_with_matches' : 'content' }) };
    case 'read_file':
      return { name: 'Read', input: def({ file_path: str(a.path) ?? '', offset: num(a.offset), limit: num(a.limit) }) };
    case 'edit_file':
      return { name: 'Edit', input: def({ file_path: str(a.path) ?? '', old_string: str(a.old_string) ?? '', new_string: str(a.new_string) ?? '', replace_all: a.replace_all === true ? true : undefined }) };
    case 'write_file':
      return { name: 'Write', input: { file_path: str(a.path) ?? '', content: str(a.content) ?? '' } };
    case 'run_command':
      return { name: 'Bash', input: { command: str(a.command) ?? '' } };
    case 'exit_plan_mode':
      return { name: 'ExitPlanMode', input: { plan: str(a.plan) ?? '' } };
    case 'db_list':
      return { name: 'mcp__projdb__db_list', input: {} };
    case 'db_select':
      return { name: 'mcp__projdb__db_select', input: def({ sql: str(a.sql) ?? '', env: env(a.env), max_rows: num(a.max_rows) }) };
    case 'db_propose_change':
      return { name: 'mcp__projdb__db_propose_change', input: def({ sql: str(a.sql) ?? '', env: env(a.env), description: str(a.description) ?? '', revert_sql: str(a.revert_sql) }) };
    default:
      return null;
  }
}
