// 메인 프로세스의 바깥 환경(Electron)을 감싼다.
// 서비스 모듈(work·vcs·db·claude)은 electron을 직접 부르지 않고 이것만 쓴다 → tsx 테스트에서는 가짜 host를 넣는다.

export interface Host {
  /** 앱 데이터 폴더 (Windows: %APPDATA%\ProjectAnalyzer) */
  dataDir: string;
  appVersion: string;
  platform: NodeJS.Platform;
  /** 폴더를 탐색기로 연다. 실패하면 오류 문구, 성공하면 '' */
  openPath(p: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  /** 저장 대화상자 → 저장한 경로, 취소하면 false */
  saveFile(defaultName: string, content: string | Uint8Array, filters?: { name: string; extensions: string[] }[]): Promise<string | false>;
  /** 폴더 선택 대화상자 → 절대 경로, 취소하면 null */
  pickFolder(title?: string): Promise<string | null>;
  /** 파일 선택 대화상자 → 절대 경로, 취소하면 null */
  pickFile(title?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  /** 문자열 암호화 (Windows: DPAPI, 사용자 계정 기준). 쓸 수 없으면 null */
  encrypt(text: string): Buffer | null;
  decrypt(data: Buffer): string | null;
  /**
   * 인터넷 연결 확인: url에 요청해 HTTP 응답이 오면 ok (상태 코드와 상관없이 — 401·404도 연결은 된 것).
   * Electron은 PC의 프록시 설정(시스템·PAC)을 따르고, proxy를 주면 그 프록시로 확인한다.
   */
  netCheck?(url: string, opts?: { timeoutMs?: number; proxy?: string }): Promise<NetCheckResult>;
}

export interface NetCheckResult {
  ok: boolean;
  status?: number;
  ms: number;
  /** 실패 원인 (net::ERR_INTERNET_DISCONNECTED, 시간 초과 …) */
  error?: string;
}

let current: Host | null = null;

export function setHost(h: Host): void {
  current = h;
}

export function host(): Host {
  if (!current) throw new Error('host가 아직 준비되지 않았습니다');
  return current;
}

/** 테스트용 host: 대화상자는 미리 정한 값을 돌려주고 암호화는 base64 */
export function testHost(
  dataDir: string,
  answers: { folder?: string | null; file?: string | null; save?: string | false; net?: NetCheckResult | ((url: string, opts?: { proxy?: string }) => NetCheckResult) } = {},
): Host {
  return {
    dataDir,
    appVersion: '0.0.0-test',
    platform: process.platform,
    async openPath() {
      return '';
    },
    async openExternal() {},
    async saveFile(_name, content) {
      if (answers.save === false || answers.save === undefined) return false;
      const fs = await import('node:fs/promises');
      await fs.writeFile(answers.save, content);
      return answers.save;
    },
    async pickFolder() {
      return answers.folder ?? null;
    },
    async pickFile() {
      return answers.file ?? null;
    },
    encrypt(text) {
      return Buffer.from(`test:${text}`, 'utf8');
    },
    decrypt(data) {
      const s = data.toString('utf8');
      return s.startsWith('test:') ? s.slice(5) : null;
    },
    // 시험에서는 실제로 인터넷에 나가지 않는다 (기본: 연결됨)
    async netCheck(url, opts) {
      const a = answers.net;
      if (typeof a === 'function') return a(url, opts);
      return a ?? { ok: true, status: 200, ms: 1 };
    },
  };
}
