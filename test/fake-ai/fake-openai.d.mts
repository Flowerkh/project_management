// fake-openai.mjs의 타입 (시험에서 씀)
export const FAKE_OPENAI_KEY: string;

export interface FakeOpenAIStep {
  say?: string;
  calls?: { name: string; args?: Record<string, unknown> }[];
  chunks?: number;
  delayMs?: number;
  cut?: boolean;
  error?: { status: number; message?: string; type?: string; code?: string | null; times?: number };
}

export interface FakeOpenAIScenario {
  turns?: { match?: string; steps: FakeOpenAIStep[] }[];
  default?: FakeOpenAIStep[];
}

export interface FakeOpenAIRequest {
  method: string;
  path: string;
  body: any;
  keyOk: boolean;
  headers: Record<string, string | null>;
}

export interface FakeOpenAI {
  url: string;
  state: {
    apiKey: string;
    scenario: FakeOpenAIScenario;
    delayMs: number;
    requests: FakeOpenAIRequest[];
    handler: ((body: any, pos: { text: string; step: number; results: string[] }) => FakeOpenAIStep | null) | null;
    errorCounts: Map<string, number>;
    gate: Promise<void> | null;
  };
  readonly requests: FakeOpenAIRequest[];
  setScenario(s: FakeOpenAIScenario | string): void;
  close(): Promise<void>;
}

export function position(input: any[]): { text: string; step: number; results: string[] };
export function startFakeOpenAI(opts?: { port?: number; apiKey?: string; scenario?: FakeOpenAIScenario | string; delayMs?: number }): Promise<FakeOpenAI>;
