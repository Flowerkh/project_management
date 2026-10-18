// Claude 오류 구분 (errors.ts) — Claude Code·SDK가 실제로 내는 문구로 표 시험
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeErrorCode } from '../src/shared/desktop-api';
import { classifyError, cleanDetail, statusMessage, type ClassifyInput } from '../src/desktop/claude/errors';

const T = (text: string): ClassifyInput => ({ text });

const CASES: [ClassifyInput, ClaudeErrorCode][] = [
  // 인증 (MSG-21)
  [T('Not logged in · Please run /login'), 'auth'],
  [T('Invalid API key · Please run /login'), 'auth'],
  [T('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), 'auth'],
  [T('OAuth token has expired. Please obtain a new token or refresh your existing token.'), 'auth'],
  [T('Failed to authenticate: OAuth token revoked'), 'auth'],
  [T('Login expired · Please run /login'), 'auth'],
  [T('Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.'), 'auth'],
  [T('Your account does not have access to Claude. Please login again or contact your administrator.'), 'auth'],
  [T('AWS credentials expired or invalid'), 'auth'],
  [T('Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.'), 'auth'],
  [T('Failed to get token from azureADTokenProvider: ChainedTokenCredential authentication failed'), 'auth'],
  [{ assistantError: 'authentication_failed' }, 'auth'],
  [{ assistantError: 'oauth_org_not_allowed', text: '' }, 'auth'],
  [{ startupReason: 'org_pin_mismatch', text: '' }, 'auth'],
  [{ status: 401 }, 'auth'],
  // 사용 한도 (MSG-23)
  [T("You've hit your session limit · resets 3pm (Asia/Seoul)"), 'limit'],
  [T("You've hit your weekly limit · resets Oct 20, 9am"), 'limit'],
  [T("You've hit your monthly spend limit"), 'limit'],
  [T('Claude AI usage limit reached|1760000000'), 'limit'],
  [T('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'), 'limit'],
  [{ assistantError: 'rate_limit' }, 'limit'],
  [{ status: 429 }, 'limit'],
  // 결제·권한 (MSG-30)
  [T('Credit balance is too low'), 'billing'],
  [T('Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'), 'billing'],
  [T('Your org is out of usage · add funds to continue'), 'billing'],
  [T("You're out of usage credits"), 'billing'],
  [T('This organization has been disabled.'), 'billing'],
  [{ assistantError: 'billing_error' }, 'billing'],
  [{ assistantError: 'rate_limit', text: 'Credit balance is too low' }, 'billing'],
  // 인터넷 (MSG-22)
  [T('API Error: Connection error.'), 'offline'],
  [T('Unable to connect to API (ECONNREFUSED)'), 'offline'],
  [T('getaddrinfo ENOTFOUND api.anthropic.com'), 'offline'],
  [T('connect ETIMEDOUT 160.79.104.10:443'), 'offline'],
  [T('Request timed out.'), 'offline'],
  [T("Couldn't connect through your proxy (ECONNRESET)"), 'offline'],
  [T('unable to get local issuer certificate'), 'offline'],
  [T('net::ERR_INTERNET_DISCONNECTED'), 'offline'],
  [{ errno: 'ENOTFOUND' }, 'offline'],
  [{ errno: 'ECONNREFUSED' }, 'offline'],
  [{ startupReason: 'org_config_required_unavailable' }, 'offline'],
  // CLI 실행 불가 (MSG-20)
  [T('Claude Code native binary not found at C:\\Users\\hong\\.local\\bin\\claude.exe. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.'), 'missing'],
  [T('Claude Code executable not found at /x/cli.js. Is options.pathToClaudeCodeExecutable set?'), 'missing'],
  [T("'claude' is not recognized as an internal or external command,\r\noperable program or batch file."), 'missing'],
  [T('Failed to spawn Claude Code process: spawn node ENOENT'), 'missing'],
  [{ errno: 'ENOENT' }, 'missing'],
  [{ startupReason: 'shell_tool_missing', text: '' }, 'missing'],
  [{ startupReason: 'cli_version_too_old' }, 'missing'],
  // 그 밖
  [T('API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.'), 'other'],
  [T('Request rejected (429) · this may be a temporary capacity issue. If it persists, check https://status.claude.com.'), 'other'],
  [T('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'), 'other'],
  [{ assistantError: 'model_not_found', text: "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it." }, 'other'],
  [T('Claude Code process exited with code 1'), 'other'],
  [{}, 'other'],
];

test('오류 구분 표', () => {
  for (const [input, code] of CASES) {
    const c = classifyError(input);
    assert.equal(c.code, code, `${JSON.stringify(input)} → ${c.code} (${c.message})`);
  }
});

test('짧은 한국어 설명 + 원문, 서버 혼잡은 따로 표시', () => {
  assert.equal(classifyError(T('Not logged in · Please run /login')).message, '인증 실패: Not logged in · Please run /login');
  assert.equal(classifyError({ errno: 'ENOTFOUND' }).message, '연결 실패: ENOTFOUND');
  assert.match(classifyError(T('API Error: Repeated 529 Overloaded errors.')).message, /^서버 혼잡/);
  assert.match(classifyError({ assistantError: 'overloaded' }).message, /^서버 혼잡/);
});

test('원문의 비밀 값은 가리고 줄인다', () => {
  assert.equal(cleanDetail('Invalid API key sk-ant-api03-AbCdEf123456789 for org'), 'Invalid API key sk-ant-**** for org');
  assert.equal(cleanDetail("Couldn't connect through your proxy http://hong:pa55@proxy:8080"), "Couldn't connect through your proxy http://****@proxy:8080");
  assert.equal(cleanDetail('token=abcdefghijklmnopqrstuvwxyz0123'), 'token=****');
  assert.equal(cleanDetail('x'.repeat(600)).length, 500);
  assert.equal(cleanDetail('a\n\n  b'), 'a b');
});

test('연결 상태 문구 (MSG-20·21·22·23·30)', () => {
  assert.match(statusMessage('missing'), /^PC에서 Claude CLI를 찾지 못했습니다/);
  assert.match(statusMessage('auth', 'Not logged in'), /^Claude 인증에 실패했습니다.*\(Not logged in\)$/);
  assert.match(statusMessage('offline'), /인터넷에 연결되어 있지 않아/);
  assert.match(statusMessage('limit'), /사용 한도에 도달했습니다/);
  assert.match(statusMessage('billing'), /결제 문제로 요청이 거절되었습니다/);
});
