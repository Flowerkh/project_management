// 미리보기: AI 공통·Gemini·ChatGPT 연결 (?mock&desk). 실제 Gemini·OpenAI를 부르지 않는다.
// URL 인자
//   &ai=gemini|openai              기본 AI (미리 채운 대화도 그 AI의 대화로)
//   &gstate=on|off|login|offline   Gemini 연결 상태 (기본 off = 연동 꺼짐)
//   &ostate=on|off|login|missing|offline   ChatGPT 연결 상태 (기본 on)
import type {
  AiProvider, AiSettings, ClaudeModel, ClaudeModelList, ClaudeStatus, GeminiConfig, GeminiConfigInput, OpenAiConfig, OpenAiConfigInput,
} from '../../../shared/desktop-api';
import { AI_PROVIDERS } from '../../../shared/desktop-api';
import type { MockHandler, MockKit } from './index';

const P = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const AI = P.get('ai');
/** 미리보기의 기본 AI */
export const MOCK_DEFAULT_AI: AiProvider = AI && (AI_PROVIDERS as string[]).includes(AI) ? (AI as AiProvider) : 'claude';

/** 미리보기용 모델 목록 (실제 목록은 Google·PC의 Codex가 알려 줌) */
export const MOCK_GEMINI_MODELS: ClaudeModel[] = [
  { value: 'gemini-4-argon', name: 'Gemini 4 Argon', description: '2026년 10월 정식 출시 · 가장 최신' },
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', description: '빠르고 저렴' },
  { value: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', description: '가장 가벼움' },
];
export const MOCK_OPENAI_MODELS: ClaudeModel[] = [
  { value: 'gpt-6-astra', name: 'GPT-6 Astra', description: '가장 성능 높음' },
  { value: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', description: 'Astra보다 저렴' },
  { value: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', description: '코딩 특화' },
];

const CODEX = 'C:\\Users\\hong\\AppData\\Roaming\\npm\\codex.cmd';
const CODEX_VERSION = '0.163.0';

function at(h: number, m: number): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const now = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);

/** claude: 이미 있는 Claude 미리보기 채널 (claude.status·claude.models) */
export function aiMocks(kit: MockKit, claude: Record<string, MockHandler>): Record<string, MockHandler> {
  let gstate = P.get('gstate') ?? 'off';
  let ostate = P.get('ostate') ?? 'on';
  const settings: AiSettings = { defaultProvider: MOCK_DEFAULT_AI, shellAllow: ['mvn -q compile', 'mvn -q test'] };
  kit.state.aiSettings = settings;
  const gemini: GeminiConfig = { enabled: gstate !== 'off', authMode: 'apikey', hasApiKey: gstate !== 'off', ...(gstate !== 'off' ? { consentAt: at(9, 20) } : {}) };
  const openai: OpenAiConfig = { enabled: ostate !== 'off', authMode: 'chatgpt', hasApiKey: false, ...(ostate !== 'off' ? { consentAt: at(17, 30) } : {}) };

  const net = (host: string, ms: number) => ({ ok: true, message: `${host} 연결됨 (${ms}ms)`, ms });
  const skip = { ok: null };

  const geminiStatus = (recheck = false): ClaudeStatus => {
    const checkedAt = now();
    const authLabel = gemini.authMode === 'vertex' ? `회사 Google Cloud (${gemini.vertex?.project ?? ''} · ${gemini.vertex?.location ?? 'global'})` : 'Gemini API 키 (앱에 저장)';
    const ready = gemini.authMode === 'apikey' ? gemini.hasApiKey : !!gemini.vertex?.project;
    const full = { network: net('generativelanguage.googleapis.com', 140), auth: { ok: true, ms: 900, message: `${authLabel} · 시험 요청 0.9초` }, model: { ok: true, message: `${MOCK_GEMINI_MODELS.length}개 받음` } };
    if (gstate === 'offline') return { state: 'offline', code: 'offline', checkedAt, authLabel, message: 'generativelanguage.googleapis.com에 연결하지 못했습니다', checks: { network: { ok: false, code: 'offline', message: 'ENOTFOUND' }, auth: skip, model: skip } };
    if (gstate === 'login' || (recheck && !ready))
      return { state: 'login', code: 'auth', checkedAt, authLabel, message: ready ? 'API 키가 올바르지 않습니다 (400 API_KEY_INVALID)' : 'API 키를 넣어 주세요', checks: { network: full.network, auth: { ok: false, code: 'auth', message: ready ? 'API_KEY_INVALID' : 'API 키를 넣어 주세요' }, model: skip } };
    if (!gemini.enabled) return { state: recheck ? 'on' : 'off', checkedAt, authLabel, ...(recheck ? { authMs: 900, checks: full } : { checks: { network: skip, auth: skip } }) };
    return { state: 'on', checkedAt, authLabel, authMs: 900, checks: full };
  };

  const openaiStatus = (recheck = false): ClaudeStatus => {
    const checkedAt = now();
    const authLabel = openai.authMode === 'apikey' ? 'OpenAI API 키 (앱에 저장)' : openai.authMode === 'azure' ? 'Azure OpenAI' : 'ChatGPT 계정 로그인 (PC의 Codex)';
    const cliPath = openai.cliPath || CODEX;
    if (ostate === 'missing') {
      const m = 'PATH와 npm 전역 설치 위치에서 codex를 찾지 못했습니다';
      return { state: 'missing', code: 'missing', checkedAt, message: m, checks: { cli: { ok: false, code: 'missing', message: m }, network: skip, auth: skip } };
    }
    const base = { cliPath, version: CODEX_VERSION, checkedAt, authLabel };
    const cli = { ok: true, message: `${CODEX_VERSION} · ${cliPath}` };
    const host = openai.authMode === 'apikey' ? 'api.openai.com' : openai.authMode === 'azure' ? (openai.azure?.endpoint ?? 'azure').replace(/^https:\/\//, '') : 'chatgpt.com';
    if (ostate === 'offline') return { state: 'offline', code: 'offline', ...base, message: `${host}에 연결하지 못했습니다`, checks: { cli, network: { ok: false, code: 'offline', message: 'ENOTFOUND' }, auth: skip } };
    const full = { cli, network: net(host, 160), auth: { ok: true, ms: 1100, message: `${authLabel} · 시험 요청 1.1초` } };
    if (ostate === 'login')
      return { state: 'login', code: 'auth', ...base, message: 'Codex에 ChatGPT 계정으로 로그인되어 있지 않습니다. [터미널에서 로그인]으로 로그인해 주세요', checks: { cli, network: full.network, auth: { ok: false, code: 'auth', message: 'Codex에 ChatGPT 계정으로 로그인되어 있지 않습니다' } } };
    if (!openai.enabled) return { state: recheck ? 'on' : 'off', ...base, ...(recheck ? { authMs: 1100, checks: full } : { checks: { cli, network: skip, auth: skip } }) };
    return { state: 'on', ...base, authMs: 1100, checks: full };
  };

  const emit = (p: 'gemini' | 'openai') => kit.emit({ type: 'ai.status', provider: p, status: p === 'gemini' ? geminiStatus() : openaiStatus() });

  return {
    'ai.settings.get': () => clone(settings),
    'ai.settings.set': (patch: Partial<AiSettings>) => {
      if (patch.defaultProvider) settings.defaultProvider = patch.defaultProvider;
      if (patch.shellAllow) settings.shellAllow = [...patch.shellAllow];
      return clone(settings);
    },
    'ai.status': (p: AiProvider, recheck?: boolean) => (p === 'claude' ? claude['claude.status'](recheck) : p === 'gemini' ? geminiStatus(!!recheck) : openaiStatus(!!recheck)),
    'ai.models': async (p: AiProvider, refresh?: boolean): Promise<ClaudeModelList> => {
      if (p === 'claude') return claude['claude.models'](refresh) as ClaudeModelList;
      await kit.sleep(refresh ? 600 : 250);
      if (p === 'gemini') return { models: clone(MOCK_GEMINI_MODELS), defaultName: 'Gemini 4 Argon', defaultDescription: '연결 설정에서 기본 모델을 고르지 않으면 Gemini 4 Argon', at: now() };
      if (ostate === 'missing') return { models: [], error: 'Codex CLI를 찾지 못했습니다', at: now() };
      if (openai.authMode === 'azure') {
        const d = openai.azure?.deployment;
        return d ? { models: [{ value: d, name: d, description: 'Azure OpenAI 배포' }], defaultName: d, account: { provider: 'Azure OpenAI' }, at: now() } : { models: [], error: 'Azure OpenAI 배포 이름을 넣어 주세요', at: now() };
      }
      return {
        models: clone(MOCK_OPENAI_MODELS),
        defaultName: 'GPT-6.1 Sol',
        defaultDescription: 'Codex 설정의 기본 모델 (gpt-6.1-sol)',
        // 미리보기용 가상 계정 (실제 계정 아님)
        ...(openai.authMode === 'chatgpt' && ostate !== 'login' ? { account: { email: 'dev.kim@example.com', subscription: 'plus', provider: 'chatgpt' } } : openai.authMode === 'apikey' ? { account: { provider: 'OpenAI API 키' } } : {}),
        at: now(),
      };
    },
    'gemini.config.get': () => clone(gemini),
    'gemini.config.set': (input: GeminiConfigInput) => {
      const { apiKey, ...rest } = input;
      const was = gemini.enabled;
      Object.assign(gemini, { model: undefined, vertex: undefined, proxy: undefined }, rest);
      if (apiKey !== undefined) gemini.hasApiKey = !!apiKey;
      if (gemini.enabled && !was) {
        gemini.consentAt = now();
        if (gstate === 'off') gstate = 'on';
      }
      emit('gemini');
      return clone(gemini);
    },
    'openai.config.get': () => clone(openai),
    'openai.config.set': (input: OpenAiConfigInput) => {
      const { apiKey, azure, ...rest } = input;
      const was = openai.enabled;
      Object.assign(openai, { model: undefined, proxy: undefined }, rest);
      if (apiKey !== undefined) openai.hasApiKey = !!apiKey;
      openai.azure = azure && (azure.endpoint || azure.deployment) ? { endpoint: azure.endpoint, deployment: azure.deployment, hasKey: azure.key !== undefined ? !!azure.key : !!openai.azure?.hasKey } : undefined;
      if (openai.enabled && !was) {
        openai.consentAt = now();
        if (ostate === 'off') ostate = 'on';
      }
      emit('openai');
      return clone(openai);
    },
    'openai.openLogin': () => {
      if (ostate === 'login')
        setTimeout(() => {
          ostate = openai.enabled ? 'on' : 'off';
          emit('openai');
        }, 1500);
      return true;
    },
    'openai.pickCli': () => {
      if (ostate === 'missing') ostate = openai.enabled ? 'on' : 'off';
      openai.cliPath = CODEX;
      return CODEX;
    },
  };
}
