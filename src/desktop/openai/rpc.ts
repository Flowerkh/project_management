// `codex app-server` 연결: 표준 입출력으로 한 줄에 JSON 하나 (JSON-RPC 모양, "jsonrpc" 필드 없음)
//   앱 → Codex   { id, method, params } 요청 / { method, params } 알림 / { id, result | error } (Codex 요청에 대한 답)
//   Codex → 앱   { id, result | error } / { method, params } 알림 / { id, method, params } 요청(승인·동적 도구 호출)
// 프로토콜 확인: codex-cli 0.163.0 `codex app-server generate-ts --experimental` (v2 타입)
import { type ChildProcess, spawn } from 'node:child_process';
import readline from 'node:readline';
import { EngineError } from '../ai/engine';
import type { CliTarget } from '../claude/cli';

export interface AppServerOptions {
  target: CliTarget;
  /** app-server 앞에 붙이는 인수 (-c key=value …) */
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  appVersion?: string;
  onNotification?(method: string, params: Record<string, any>): void;
  /** Codex가 보낸 요청 → 결과 (throw하면 오류로 답함) */
  onRequest?(method: string, params: Record<string, any>): Promise<unknown>;
  onExit?(info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): void;
  stderr?(s: string): void;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  method: string;
  timer?: NodeJS.Timeout;
}

export class RpcError extends Error {
  constructor(
    message: string,
    public rpcCode: number,
    public method: string,
  ) {
    super(message);
  }
}

export class AppServer {
  private child: ChildProcess;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private exited = false;
  stderrTail = '';

  private constructor(private o: AppServerOptions) {
    const cmd = o.target.node ?? o.target.exec;
    const args = o.target.node ? [o.target.exec, ...o.args, 'app-server'] : [...o.args, 'app-server'];
    this.child = spawn(cmd, args, { env: o.env, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const rl = readline.createInterface({ input: this.child.stdout! });
    rl.on('line', (line) => this.onLine(line));
    this.child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      this.stderrTail = (this.stderrTail + s).slice(-4000);
      o.stderr?.(s);
    });
    this.child.stdin!.on('error', () => undefined);
    this.child.on('error', (e: NodeJS.ErrnoException) => this.onGone(e.code === 'ENOENT' ? new EngineError(`Codex를 실행하지 못했습니다: ${e.message}`, 'missing') : e));
    this.child.on('exit', (code, signal) => {
      this.onGone(new EngineError(`Codex가 끝났습니다 (종료 코드 ${code ?? signal})${this.stderrTail.trim() ? `: ${lastLines(this.stderrTail)}` : ''}`, 'other'));
      o.onExit?.({ code, signal, stderr: this.stderrTail });
    });
  }

  /** 띄우고 initialize까지 */
  static async start(o: AppServerOptions, timeoutMs = 30000): Promise<AppServer> {
    const s = new AppServer(o);
    try {
      await s.request('initialize', { clientInfo: { name: 'project-analyzer', title: '프로젝트 분석 시스템', version: o.appVersion ?? '0' }, capabilities: { experimentalApi: true } }, timeoutMs);
      s.notify('initialized', {});
    } catch (e) {
      s.close();
      throw e;
    }
    return s;
  }

  get alive(): boolean {
    return !this.exited;
  }

  private onGone(err: Error): void {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private write(m: unknown): void {
    if (this.exited) return;
    try {
      this.child.stdin!.write(`${JSON.stringify(m)}\n`);
    } catch {
      // 이미 끝남
    }
  }

  private onLine(line: string): void {
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(new RpcError(String(m.error.message ?? '오류'), Number(m.error.code ?? -1), p.method));
      else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined && typeof m.method === 'string') {
      const id = m.id;
      const handler = this.o.onRequest;
      if (!handler) {
        this.write({ id, error: { code: -32601, message: '지원하지 않는 요청입니다' } });
        return;
      }
      handler(m.method, m.params ?? {}).then(
        (result) => this.write({ id, result: result ?? {} }),
        (e) => this.write({ id, error: { code: -32000, message: (e as Error)?.message ?? String(e) } }),
      );
      return;
    }
    if (typeof m.method === 'string') this.o.onNotification?.(m.method, m.params ?? {});
  }

  request<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.exited) return Promise.reject(new EngineError('Codex가 이미 끝났습니다', 'other'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject, method };
      if (timeoutMs) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new EngineError(`Codex가 ${Math.round(timeoutMs / 1000)}초 동안 응답하지 않았습니다 (${method})`, 'other'));
        }, timeoutMs);
        p.timer.unref?.();
      }
      this.pending.set(id, p);
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  /** 끝내기: 입력을 닫고(app-server는 입력이 끝나면 스스로 끝남) 잠시 뒤에도 살아 있으면 프로세스 묶음을 끝낸다 */
  close(): void {
    if (this.exited) return;
    try {
      this.child.stdin!.end();
    } catch {
      // 무시
    }
    const pid = this.child.pid;
    const t = setTimeout(() => {
      if (this.exited) return;
      if (process.platform === 'win32' && pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
      else this.child.kill('SIGTERM');
    }, 1500);
    t.unref?.();
  }
}

function lastLines(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim()
    .split('\n')
    .filter((l) => !/bubblewrap|PATH aliases|featured plugin/i.test(l))
    .slice(-3)
    .join(' / ')
    .slice(0, 600);
}
