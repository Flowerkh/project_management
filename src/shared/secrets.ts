// DB 접속 정보(주소·계정·비밀번호)와 비밀 값 가리기.
// - 작업 사본을 만들 때 설정 파일의 값을 가려 Claude가 읽거나 검색해도 비밀 값이 나가지 않게 한다.
// - 접속 정보 파일(globals.properties·.env 등)은 Claude가 아예 읽지 못하게 거부한다 (isSecretFile).
// 메인 프로세스와 화면(소스 뷰어) 모두에서 쓴다. Node·DOM 기능을 쓰지 않는다.

const MASK = '****';

function baseName(p: string): string {
  const s = p.replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

/** Claude가 읽지 못하게 막는 접속 정보 파일 */
export function isSecretFile(p: string): boolean {
  const name = baseName(p).toLowerCase();
  if (/^\.env(\..+)?$/.test(name)) return !/\.(example|sample|dist|template|tpl)$/.test(name);
  if (/^(globals|jdbc|db|database|datasource|dbconfig|db-config|db_config|dbinfo|connection)\.(properties|conf|ini|cfg)$/.test(name)) return true;
  if (/^(wp-config|dbconn|db_conn|dbconnect|db_connect|dbinfo|db_info)\.php$/.test(name)) return true;
  if (/^(credentials|secrets?)\.(json|ya?ml|properties|xml|ini|toml)$/.test(name)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/.test(name) || /\.(pem|key|p12|pfx|jks|keystore)$/.test(name)) return true;
  return false;
}

/** 값을 가릴 텍스트 파일 (설정·코드) */
export function isRedactable(p: string): boolean {
  return /\.(properties|ya?ml|xml|json|env|conf|cfg|ini|toml|php|py|go|java|kt|js|ts|mjs|cjs|sh|bat|cmd|ps1|txt|config|jsp|inc|tf|gradle)$|(^|\/)\.env[^/]*$/i.test(p.replace(/\\/g, '/'));
}

const SECRET_KEY = /(pass(word|wd|phrase)?|pwd|secret|token|api[-_.]?key|access[-_.]?key|private[-_.]?key|credential|auth[-_.]?key|client[-_.]?secret|salt)$/i;
const SECRET_KEY_ANY = /(password|passwd|secret|api[-_.]?key|access[-_.]?key|private[-_.]?key|client[-_.]?secret)/i;
const USER_KEY = /(^|[._-])(user(name)?|uid|user[-_.]?id|login)$/i;
const DB_CONTEXT = /(db|datasource|data-source|jdbc|database|globals|mysql|maria|oracle|conn|sql|dsn|ds)/i;
const URL_KEY = /(url|uri|dsn|host|server|addr(ess)?|connection[-_.]?string)$/i;

/** 값이 실제 값이 아니라 다른 곳을 가리키는 자리표시면 그대로 둔다 (${..}, env(), getenv …) */
function isPlaceholder(v: string): boolean {
  const s = v.trim().replace(/^['"]|['"]$/g, '');
  if (!s) return true;
  if (/^\$\{[^}]*\}$|^#\{[^}]*\}$|^%[\w.]+%$|^\$\w+$|^\$\{?env:/i.test(s)) return true;
  if (/\b(env|getenv|os\.environ|os\.getenv|System\.getenv|process\.env|config)\s*[([.]/i.test(s)) return true;
  if (/^(null|none|nil|true|false|\*+|x+|changeme|your[_-].*|<.*>)$/i.test(s)) return true;
  return false;
}

/** 연결 문자열 안의 계정·비밀번호·주소를 가린다 */
export function maskConnString(s: string): string {
  let out = s;
  // jdbc:oracle:thin:@host:1521:SID, jdbc:oracle:thin:@//host:1521/svc
  out = out.replace(/(jdbc:oracle:[a-z]+:)([^@\s"'<>]*@)?(\/\/)?[^\s"'<>;,)]+/gi, (_m, p1: string, cred: string | undefined) => `${p1}${cred && cred !== '@' ? `${MASK}@` : '@'}${MASK}`);
  // jdbc:mysql://host:3306/db?..., jdbc:mariadb://, jdbc:log4jdbc:mysql://
  out = out.replace(/(jdbc:(?:log4jdbc:)?[a-z0-9]+:\/\/)[^\s"'<>;,)]+/gi, (_m, p1: string) => `${p1}${MASK}`);
  // mysql://user:pass@host/db, postgres://, mongodb://, redis://
  out = out.replace(/\b((?:mysql|mariadb|postgres(?:ql)?|mongodb(?:\+srv)?|redis|oracle|sqlserver|mssql|amqp)s?:\/\/)[^\s"'<>]+/gi, (_m, p1: string) => `${p1}${MASK}`);
  // Go DSN: user:pass@tcp(host:3306)/db
  out = out.replace(/\b[\w.-]+:[^@\s"'`]*@(tcp|unix)\([^)]*\)/g, `${MASK}:${MASK}@$1(${MASK})`);
  // Oracle EZ connect / TNS: user/pass@host:1521/svc
  out = out.replace(/\b[\w.$#-]+\/[^@\s"'`/]+@(\/\/)?[\w.-]+(:\d+)?(\/[\w.$#-]+)?/g, `${MASK}/${MASK}@${MASK}`);
  // (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=...)(PORT=...))...)
  out = out.replace(/\(\s*HOST\s*=\s*[^)]+\)/gi, `(HOST=${MASK})`);
  return out;
}

export interface RedactResult {
  text: string;
  /** 가린 값 수 */
  count: number;
}

/**
 * 설정·코드 텍스트에서 비밀 값을 가린다.
 * key=value / key: value / "key": "value" / 'key' => 'value' / <key>value</key> / name="password" value="…" 형태와 연결 문자열.
 */
export function redactSecrets(text: string, filePath = ''): RedactResult {
  let count = 0;
  const lowerPath = filePath.toLowerCase();
  // DB 설정이 들어 있는 파일이면 계정(user)·주소(host) 키도 가린다
  const dbFile = DB_CONTEXT.test(baseName(lowerPath)) || isSecretFile(filePath) || /jdbc:|datasource|\bDATABASES?\b|\bDB_(HOST|USER|PASS)/i.test(text);
  // key=value 줄 단위 규칙은 설정·스크립트 파일에만 (코드의 `a := "b"` 같은 줄을 잘못 자르지 않게)
  const configLike = !lowerPath || /\.(properties|env|ya?ml|ini|conf|cfg|toml|txt|sh|bash|ksh|bat|cmd|config)$|(^|\/)\.env[^/]*$/.test(lowerPath);
  const mask = (v: string): string => {
    count++;
    const q = /^(['"`])/.exec(v)?.[1] ?? '';
    return q ? `${q}${MASK}${q}` : MASK;
  };
  const shouldMaskKey = (key: string, value: string): boolean => {
    if (isPlaceholder(value)) return false;
    const k = key.replace(/['"]/g, '');
    if (SECRET_KEY.test(k) || SECRET_KEY_ANY.test(k)) return true;
    if (USER_KEY.test(k) && (dbFile || DB_CONTEXT.test(k))) return true;
    return false;
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const before = line;
    // 1) properties·env·yaml·ini:  key = value / key: value / export KEY=value / set KEY=value
    if (configLike) line = line.replace(/^(\s*(?:export\s+|set\s+|-\s+)?)([A-Za-z_][\w.\-[\]]*)(\s*[:=]\s*)(.+?)(\s*)$/, (m, pre: string, key: string, sep: string, val: string, post: string) => {
      if (val.startsWith('{') || val.startsWith('[') || val.startsWith('=') || /^(function|fn|new)\b/.test(val)) return m;
      const urlish = URL_KEY.test(key) || /jdbc:|:\/\/|@tcp\(/.test(val);
      if (shouldMaskKey(key, val)) return `${pre}${key}${sep}${mask(val.replace(/[;,]\s*$/, ''))}${/[;,]\s*$/.test(val) ? val.match(/[;,]\s*$/)![0] : ''}${post}`;
      if (urlish && (dbFile || DB_CONTEXT.test(key) || /jdbc:/.test(val))) {
        const masked = maskConnString(val);
        if (masked !== val) {
          count++;
          return `${pre}${key}${sep}${masked}${post}`;
        }
        if (URL_KEY.test(key) && /host|server|addr/i.test(key) && DB_CONTEXT.test(key) && !isPlaceholder(val)) return `${pre}${key}${sep}${mask(val)}${post}`;
      }
      return m;
    });
    // 2) JSON·PHP·Python 사전:  "password": "x" / 'password' => 'x' / PASSWORD = 'x'
    line = line.replace(/(["'])([\w.\-]+)\1(\s*(?:=>|:|=)\s*)(["'`])([^"'`\n]*)\4/g, (m, q: string, key: string, sep: string, vq: string, val: string) => {
      if (shouldMaskKey(key, val)) {
        count++;
        return `${q}${key}${q}${sep}${vq}${MASK}${vq}`;
      }
      if ((URL_KEY.test(key) || /host/i.test(key)) && (DB_CONTEXT.test(key) || dbFile) && !isPlaceholder(val)) {
        const masked = /:\/\/|jdbc:|@/.test(val) ? maskConnString(val) : MASK;
        if (masked !== val) {
          count++;
          return `${q}${key}${q}${sep}${vq}${masked}${vq}`;
        }
      }
      return m;
    });
    // 3) define('DB_PASSWORD', 'x')
    line = line.replace(/(define\s*\(\s*['"])([\w]+)(['"]\s*,\s*)(['"])([^'"]*)\4/gi, (m, a: string, key: string, b: string, q: string, val: string) => {
      if (shouldMaskKey(key, val) || (/HOST|SERVER/i.test(key) && DB_CONTEXT.test(key) && !isPlaceholder(val))) {
        count++;
        return `${a}${key}${b}${q}${MASK}${q}`;
      }
      return m;
    });
    // 4) $db['default']['password'] = 'x';
    line = line.replace(/(\[\s*['"](\w+)['"]\s*\]\s*=\s*)(['"])([^'"]*)\3/g, (m, a: string, key: string, q: string, val: string) => {
      if (shouldMaskKey(key, val) || (/^(hostname|host)$/i.test(key) && !isPlaceholder(val) && /db/i.test(line))) {
        count++;
        return `${a}${q}${MASK}${q}`;
      }
      return m;
    });
    // 5) XML: <property name="password" value="x"/>, <password>x</password>, p:password="x", password="x"
    line = line.replace(/(name\s*=\s*["']([\w.\-]+)["']\s+value\s*=\s*)(["'])([^"']*)\3/gi, (m, a: string, key: string, q: string, val: string) => {
      if (shouldMaskKey(key, val)) {
        count++;
        return `${a}${q}${MASK}${q}`;
      }
      if (/url|host/i.test(key) && !isPlaceholder(val)) {
        const masked = maskConnString(val);
        if (masked !== val) {
          count++;
          return `${a}${q}${masked}${q}`;
        }
      }
      return m;
    });
    line = line.replace(/(<([\w:.\-]*(?:password|passwd|pwd|secret|username|user|url))>)([^<]+)(<\/\2>)/gi, (m, open: string, tag: string, val: string, close: string) => {
      if (isPlaceholder(val)) return m;
      if (/url$/i.test(tag)) {
        const masked = maskConnString(val);
        if (masked === val) return m;
        count++;
        return `${open}${masked}${close}`;
      }
      if (/user(name)?$/i.test(tag) && !(dbFile || DB_CONTEXT.test(line))) return m;
      count++;
      return `${open}${MASK}${close}`;
    });
    line = line.replace(/(\b(?:p:|c:)?([\w.\-]*(?:password|passwd|pwd|secret))\s*=\s*)(["'])([^"']*)\3/gi, (m, a: string, _key: string, q: string, val: string) => {
      if (isPlaceholder(val)) return m;
      count++;
      return `${a}${q}${MASK}${q}`;
    });
    // 6) 코드 안의 연결 문자열 (sql.Open("mysql", "user:pass@tcp(...)/db"), DriverManager.getConnection("jdbc:...", "user", "pw"))
    if (/jdbc:|:\/\/|@tcp\(|@unix\(/.test(line) && /["'`]/.test(line)) {
      const masked = line.replace(/(["'`])([^"'`\n]*(?:jdbc:|mysql:\/\/|mariadb:\/\/|postgres(?:ql)?:\/\/|oracle:\/\/|@tcp\(|@unix\()[^"'`\n]*)\1/gi, (m, q: string, val: string) => {
        const mm = maskConnString(val);
        if (mm === val) return m;
        count++;
        return `${q}${mm}${q}`;
      });
      line = masked;
    }
    // 7) 코드 대입: String dbPassword = "x"; password := "x"; $password = 'x'; self.secret = 'x'
    line = line.replace(/([$\w.]*?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token)\w*)(\s*(?::=|=|:)\s*)(["'`])([^"'`\n]*)\3/gi, (m, key: string, sep: string, q: string, val: string) => {
      if (!val || val === MASK || isPlaceholder(val)) return m;
      if (/^(password|pwd|passwd)$/i.test(val)) return m; // 라벨 문자열 ("password")
      count++;
      return `${key}${sep}${q}${MASK}${q}`;
    });
    // 8) 문자열 안의 key=value 연결 문자열: "user=foo password=bar host=db" / "Server=db;User Id=sa;Password=x;"
    if (/(password|pwd)\s*=/i.test(line) && /["'`]/.test(line)) {
      line = line.replace(/(["'`])([^"'`\n]*\b(?:password|pwd)\s*=[^"'`\n]*)\1/gi, (m, q: string, val: string) => {
        const mm = val.replace(/\b(password|pwd|user(?:\s+id)?|uid|username|host|server|data\s+source|hostaddr)(\s*=\s*)([^;\s]+)/gi, (_x, k: string, eq: string, v: string) => (v === MASK ? `${k}${eq}${v}` : `${k}${eq}${MASK}`));
        if (mm === val) return m;
        count++;
        return `${q}${mm}${q}`;
      });
    }
    if (/getConnection\s*\(/.test(line)) {
      // DriverManager.getConnection(url, "user", "password") → 두 번째·세 번째 문자열 인자
      line = line.replace(/(getConnection\s*\(\s*[^,]+,\s*)(["'])([^"']*)\2(\s*,\s*)(["'])([^"']*)\5/, (m, a: string, q1: string, u: string, b: string, q2: string, pw: string) => {
        if (isPlaceholder(u) && isPlaceholder(pw)) return m;
        count += 2;
        return `${a}${q1}${MASK}${q1}${b}${q2}${MASK}${q2}`;
      });
    }
    if (line !== before) lines[i] = line;
  }
  return { text: count ? lines.join('\n') : text, count };
}
