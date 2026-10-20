// AI별 문구: 화면설계서 메시지(MSG-14·20·21·23·30 등)를 그 대화의 AI에 맞게. Claude는 그대로 쓴다.
import type { AiProvider } from '../../../shared/desktop-api';
import { AI_LABEL } from '../../../shared/desktop-api';
import { msg } from '../messages';

const AI_MSG: Record<Exclude<AiProvider, 'claude'>, Record<string, string>> = {
  gemini: {
    'MSG-14': '연동을 켜면 질문과 맥락으로 붙인 분석 결과, AI가 읽은 소스 일부, SELECT 조회 결과(개인정보 가림)가 Google(Gemini API 또는 회사 Google Cloud)로 전송됩니다. 접속 정보 파일은 읽지 않습니다.',
    'MSG-20': '회사 Google Cloud로 연결하려면 PC에 Google Cloud CLI(gcloud)가 있어야 합니다. 설치하고 로그인(gcloud auth login)한 뒤 다시 확인해 주세요.',
    'MSG-21': 'Gemini 인증에 실패했습니다. API 키 또는 회사 Google Cloud(gcloud 로그인·프로젝트·리전) 설정을 확인한 뒤 다시 시도해 주세요.',
    'MSG-23': 'Gemini 사용 한도에 도달했습니다. 잠시 후 다시 시도하거나 결제를 연결한 API 키·회사 Google Cloud로 바꿔 주세요.',
    'MSG-30': 'Gemini 사용 권한이나 결제 문제로 요청이 거절되었습니다. API 키를 만든 Google AI Studio 프로젝트의 결제 또는 회사 Google Cloud 프로젝트의 Vertex AI 사용 설정을 확인해 주세요.',
  },
  openai: {
    'MSG-14': '연동을 켜면 질문과 맥락으로 붙인 분석 결과, AI가 읽은 소스 일부, SELECT 조회 결과(개인정보 가림)가 OpenAI(ChatGPT·OpenAI API) 또는 회사 Azure OpenAI로 전송됩니다. 접속 정보 파일은 읽지 않습니다.',
    'MSG-20': 'PC에서 Codex CLI를 찾지 못했습니다. 설치(npm install -g @openai/codex)한 뒤 다시 확인하거나 [경로 지정]으로 직접 지정해 주세요.',
    'MSG-21': 'ChatGPT 인증에 실패했습니다. Codex에 ChatGPT 계정으로 로그인하거나 OpenAI API 키·Azure OpenAI 설정을 확인한 뒤 다시 시도해 주세요.',
    'MSG-23': 'ChatGPT 사용 한도에 도달했습니다. 잠시 후 다시 시도하거나 다른 인증 방식(API 키)으로 바꿔 주세요.',
    'MSG-30': 'ChatGPT 사용 권한이나 결제 문제로 요청이 거절되었습니다. 로그인한 ChatGPT 요금제, OpenAI API 결제 또는 Azure OpenAI 리소스 상태를 확인해 주세요.',
  },
};

/** 화면설계서 메시지를 그 AI에 맞게 (Claude는 그대로) */
export function providerMsg(id: string, p: AiProvider | undefined, vars: Record<string, string | number> = {}): string {
  const text = msg(id, vars);
  if (!p || p === 'claude') return text;
  const own = AI_MSG[p][id];
  if (own) return own;
  return text.replace(/Claude Code/g, AI_LABEL[p]).replace(/Claude/g, AI_LABEL[p]);
}
