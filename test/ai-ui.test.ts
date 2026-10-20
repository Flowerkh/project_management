// 화면의 AI 고르기 계산 (모델 줄·고른 줄·이름), AI별 문구, 다른 AI로 옮기는 대화 글
//   npx tsx --test test/ai-ui.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeModelList, Conversation } from '../src/shared/desktop-api';
import { carryTranscript, stripContextBlocks } from '../src/desktop/claude/conversations';
import { aiDefaultLabel, listDefault, modelOptions, pickedName, pickedValue, pickRows } from '../src/ui/desktop/ai/models';
import { providerMsg } from '../src/ui/desktop/ai/text';
import { composeWithContext, splitContextBlock } from '../src/ui/desktop/claude/util';

const at = '2026-10-20T00:00:00.000Z';
const CLAUDE: ClaudeModelList = {
  models: [
    { value: 'opus', name: 'Opus', description: '어려운 문제에 알맞은 큰 모델' },
    { value: 'sonnet', name: 'Sonnet', description: '일상 작업' },
  ],
  defaultName: 'Default (recommended)',
  defaultDescription: 'Sonnet · 일상 작업',
  at,
};
const GEMINI: ClaudeModelList = {
  models: [
    { value: 'gemini-4-argon', name: 'Gemini 4 Argon', description: '가장 최신' },
    { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', description: '빠르고 저렴' },
  ],
  defaultName: 'Gemini 4 Argon',
  at,
};
const CODEX: ClaudeModelList = {
  models: [
    { value: 'gpt-6-astra', name: 'GPT-6 Astra', description: '가장 성능 높음' },
    { value: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', description: 'Astra보다 저렴' },
  ],
  defaultName: 'GPT-6.1 Sol',
  at,
};

test('모델 줄: Claude는 기본값 줄을 맨 위에, 연결 설정의 기본 모델에 기본 표시', () => {
  const rows = pickRows('claude', CLAUDE, undefined, undefined);
  assert.deepEqual(rows.map((r) => [r.value, r.isDefault]), [['', true], ['opus', false], ['sonnet', false]]);
  assert.equal(rows[0].name, 'Claude Code 기본값');
  assert.match(rows[0].description ?? '', /Default \(recommended\) · Sonnet/);
  const withConn = pickRows('claude', CLAUDE, 'opus', undefined);
  assert.deepEqual(withConn.map((r) => [r.value, r.isDefault]), [['', false], ['opus', true], ['sonnet', false]]);
  assert.equal(pickedValue('claude', withConn, CLAUDE, '', 'opus'), '', "대화에 ''를 골랐으면 Claude Code 기본값");
  assert.equal(pickedName('claude', CLAUDE, '', undefined), 'Claude Code 기본값');
  assert.equal(pickedName('claude', CLAUDE, 'opus', undefined), 'Opus');
});

test('모델 줄: Gemini·Codex는 목록 안의 기본 모델에 기본 표시 (기본값 줄 없음)', () => {
  const g = pickRows('gemini', GEMINI, undefined, undefined);
  assert.deepEqual(g.map((r) => [r.value, r.isDefault]), [['gemini-4-argon', true], ['gemini-3.8-flash', false]]);
  assert.equal(pickedValue('gemini', g, GEMINI, '', undefined), 'gemini-4-argon');
  // Gemini의 ''는 연결 설정의 기본 모델
  const g2 = pickRows('gemini', GEMINI, 'gemini-3.8-flash', undefined);
  assert.deepEqual(g2.map((r) => [r.value, r.isDefault]), [['gemini-4-argon', false], ['gemini-3.8-flash', true]]);
  assert.equal(pickedValue('gemini', g2, GEMINI, '', 'gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(pickedName('gemini', GEMINI, '', 'gemini-3.8-flash'), 'Gemini 3.8 Flash');
  const c = pickRows('openai', CODEX, undefined, undefined);
  assert.deepEqual(c.map((r) => [r.value, r.isDefault]), [['gpt-6-astra', false], ['gpt-6.1-sol', true]]);
  // Codex의 ''는 Codex 기본값 (연결 설정과 다를 수 있음)
  assert.equal(pickedValue('openai', pickRows('openai', CODEX, 'gpt-6-astra', undefined), CODEX, '', 'gpt-6-astra'), 'gpt-6.1-sol');
  assert.equal(pickedName('openai', CODEX, '', undefined), 'GPT-6.1 Sol');
  assert.equal(listDefault(CODEX)?.value, 'gpt-6.1-sol');
});

test('모델 줄: 목록을 못 받았거나 직접 입력한 모델', () => {
  const empty: ClaudeModelList = { models: [], error: 'Codex CLI를 찾지 못했습니다', at };
  const rows = pickRows('openai', empty, undefined, undefined);
  assert.deepEqual(rows.map((r) => [r.value, r.name, r.isDefault]), [['', 'Codex 기본값', true]]);
  const custom = pickRows('gemini', GEMINI, undefined, 'gemini-9-test');
  assert.deepEqual(custom.at(-1), { value: 'gemini-9-test', name: 'gemini-9-test', description: '직접 입력한 모델', isDefault: false });
  assert.equal(pickRows('gemini', null, undefined, undefined)[0].name, 'Gemini 기본 모델');
  assert.equal(aiDefaultLabel('openai', CODEX), 'Codex 기본값 (GPT-6.1 Sol)');
  assert.deepEqual(modelOptions(GEMINI, 'x-model', 'Gemini 기본값').map((o) => o.value), ['', 'gemini-4-argon', 'gemini-3.8-flash', 'x-model']);
});

test('AI별 문구: 따로 정한 문구 → 없으면 Claude를 그 AI 이름으로', () => {
  assert.match(providerMsg('MSG-21', 'claude'), /^Claude 인증에 실패했습니다/);
  assert.match(providerMsg('MSG-21', 'openai'), /Codex에 ChatGPT 계정으로 로그인/);
  assert.match(providerMsg('MSG-14', 'gemini'), /Google\(Gemini API 또는 회사 Google Cloud\)로 전송/);
  assert.equal(providerMsg('MSG-24', 'gemini', { 명령: 'mvn -q test' }), 'Gemini가 허용 목록에 있는 명령을 실행하려고 합니다: mvn -q test. 실행할까요?');
  assert.match(providerMsg('MSG-37', 'openai', { n: 2 }), /개인정보 컬럼 2개를 가리고 ChatGPT에 보냈습니다/);
  assert.doesNotMatch(providerMsg('MSG-22', 'openai'), /Claude/);
});

test('다른 AI로 옮기는 대화 글: 질문과 함께 보낸 맥락 변경은 빼고 질문·답변만', () => {
  const asked = composeWithContext('이 화면도 봐 주세요', [{ kind: 'screen', label: '주문목록', text: '화면 · 주문목록 …긴 맥락…' }], [{ kind: 'table', label: 'TB_ORDER', text: '' }]);
  assert.match(asked, /<맥락-추가/);
  assert.equal(stripContextBlocks(asked), '이 화면도 봐 주세요');
  const conv = {
    id: 'cabc123',
    provider: 'openai',
    root: null,
    kind: 'issue',
    title: 't',
    createdAt: at,
    updatedAt: at,
    mode: 'plan',
    running: false,
    items: [
      { id: 'u1', type: 'user', text: asked, at },
      { id: 'a1', type: 'activity', summary: '파일 2개 읽음', items: [], at },
      { id: 'm1', type: 'assistant', text: '두 곳에서 저장합니다.', at },
    ],
  } as Conversation;
  assert.equal(carryTranscript(conv, 10000), '[사용자] 이 화면도 봐 주세요\n\n[ChatGPT] 두 곳에서 저장합니다.');
  // 이전 대화 칩은 말풍선의 맥락 변경으로도 알아본다
  const b = splitContextBlock(composeWithContext('질문', [], [{ kind: 'conversation', label: '이전 대화 (Claude)', text: '' }]));
  assert.deepEqual(b.removed, [{ kind: 'conversation', label: '이전 대화 (Claude)' }]);
  assert.equal(b.text, '질문');
});
