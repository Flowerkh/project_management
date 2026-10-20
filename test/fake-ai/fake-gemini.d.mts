// fake-gemini.mjs의 타입 (시험에서 씀)
export const FAKE_GEMINI_KEY: string;
export const FAKE_VERTEX_TOKEN: string;

export interface FakeStep {
  say?: string;
  calls?: { name: string; args?: Record<string, unknown> }[];
  finish?: string;
  chunks?: number;
  delayMs?: number;
  /** 첫 조각을 보낸 뒤 연결을 끊음 */
  cut?: boolean;
  blocked?: string;
  error?: { status: number; message?: string; statusText?: string; times?: number; details?: unknown[] };
}

export interface FakeScenario {
  turns?: { match?: string; steps: FakeStep[] }[];
  default?: FakeStep[];
}

export interface FakeRequest {
  method: string;
  path: string;
  vertex: boolean;
  body: any;
  apiKeyOk: boolean;
  bearerOk: boolean;
}

export interface FakeGeminiState {
  apiKey: string;
  token: string;
  scenario: FakeScenario;
  delayMs: number;
  requests: FakeRequest[];
  handler: ((body: any, info: { model: string; vertex: boolean; text: string; step: number; results: any[] }) => FakeStep | null) | null;
  errorCounts: Map<string, number>;
  gate: Promise<void> | null;
}

export interface FakeGemini {
  url: string;
  state: FakeGeminiState;
  readonly requests: FakeRequest[];
  setScenario(s: FakeScenario | string): void;
  close(): Promise<void>;
}

export function position(contents: any[]): { text: string; step: number; results: any[] };
export function startFakeGemini(opts?: { port?: number; apiKey?: string; token?: string; scenario?: FakeScenario | string; delayMs?: number }): Promise<FakeGemini>;
