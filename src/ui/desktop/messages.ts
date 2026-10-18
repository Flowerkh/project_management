// 화면설계서 v0.6 메시지 정의 (MSG-01~46). 문구는 화면에 그대로 쓴다. { } 안은 실제 값으로 바꾼다.
// 생성: 화면설계서 생성기(pages_d.py MSGS)에서 옮김. 문구를 고치면 화면설계서도 같이 고친다.

export type MsgKind = 'err' | 'warn' | 'confirm' | 'info';
export type MsgShow = '인라인' | '배너' | '대화상자';

export interface MsgDef {
  kind: MsgKind;
  /** 쓰는 화면 */
  screens: string;
  situation: string;
  text: string;
  show: MsgShow;
  /** 버튼: '*' 주 버튼, '!' 위험 버튼, 없으면 보조 버튼 */
  buttons: string[];
}

export const MSG: Record<string, MsgDef> = {
  'MSG-01': { kind: 'err', screens: "SCR-01", situation: "빈 폴더", text: "분석할 소스 파일이 없습니다. 다른 폴더를 선택해 주세요.", show: '인라인', buttons: [] },
  'MSG-02': { kind: 'err', screens: "SCR-01", situation: "폴더·ZIP이 아님", text: "폴더 또는 ZIP 파일만 불러올 수 있습니다.", show: '인라인', buttons: [] },
  'MSG-03': { kind: 'err', screens: "SCR-01", situation: "ZIP 최대 크기 초과", text: "ZIP 파일이 최대 크기({한도})를 넘습니다. 필요 없는 폴더를 빼고 다시 압축하거나 설정에서 한도를 바꿔 주세요.", show: '인라인', buttons: [] },
  'MSG-04': { kind: 'warn', screens: "SCR-02", situation: "대상 20,000개 초과", text: "분석할 파일이 20,000개를 넘어 시간이 오래 걸릴 수 있습니다. 제외할 폴더가 있는지 확인해 주세요.", show: '배너', buttons: ["제외 폴더 확인"] },
  'MSG-05': { kind: 'confirm', screens: "SCR-03", situation: "분석 중지", text: "분석을 중지할까요? 지금까지의 결과는 저장되지 않습니다.", show: '대화상자', buttons: ["계속 분석", "!중지"] },
  'MSG-06': { kind: 'err', screens: "SCR-03", situation: "분석 실패", text: "분석 중 문제가 생겨 중단했습니다. 다시 실행해 주세요.", show: '인라인', buttons: ["오류 내용 복사", "*다시 실행"] },
  'MSG-07': { kind: 'confirm', screens: "COM", situation: "결과 있을 때 Run", text: "다시 분석하면 자동 저장된 현재 결과가 새 결과로 바뀝니다. 계속할까요?", show: '대화상자', buttons: ["취소", "결과 파일 저장 후 분석", "*다시 분석"] },
  'MSG-08': { kind: 'confirm', screens: "SCR-10", situation: "변경 적용", text: "선택한 파일 {n}개를 프로젝트 폴더에 적용합니다. 적용 전 파일은 작업 이력에 보관되어 되돌릴 수 있습니다(선택: 적용 후 커밋 · 커밋 후 푸시). 적용할까요?", show: '대화상자', buttons: ["취소", "*적용"] },
  'MSG-09': { kind: 'err', screens: "COM", situation: "자동 저장 실패", text: "분석 결과를 저장하지 못했습니다. 디스크 공간과 폴더 권한을 확인해 주세요.", show: '배너', buttons: ["다시 시도"] },
  'MSG-10': { kind: 'info', screens: "SCR-07", situation: "메뉴 데이터 없음", text: "메뉴 데이터를 찾지 못해 URL 경로로 메뉴를 추정했습니다.", show: '배너', buttons: ["메뉴 파일 지정"] },
  'MSG-11': { kind: 'info', screens: "SCR-06", situation: "미연결 테이블", text: "연결된 화면·배치가 없습니다. 외부 연동에서 쓰거나 사용하지 않는 테이블일 수 있습니다.", show: '인라인', buttons: [] },
  'MSG-12': { kind: 'info', screens: "SCR-08", situation: "1MB 넘는 파일", text: "파일이 커서 앞부분 2,000줄만 표시합니다.", show: '배너', buttons: ["전체 보기"] },
  'MSG-13': { kind: 'err', screens: "SCR-08", situation: "바이너리 파일", text: "텍스트 파일만 볼 수 있습니다.", show: '인라인', buttons: [] },
  'MSG-14': { kind: 'confirm', screens: "POP-03", situation: "Claude 연동 켜기", text: "연동을 켜면 질문과 맥락으로 붙인 분석 결과, Claude가 읽은 소스 일부, SELECT 조회 결과(개인정보 가림)가 Claude(Anthropic 또는 고른 회사 클라우드)로 전송됩니다. 접속 정보 파일은 읽지 않습니다.", show: '인라인', buttons: ["*연동 켜기"] },
  'MSG-15': { kind: 'confirm', screens: "POP-01", situation: "설정 저장 후", text: "설정이 바뀌었습니다. 바뀐 설정으로 다시 분석할까요?", show: '대화상자', buttons: ["나중에", "*다시 분석"] },
  'MSG-16': { kind: 'info', screens: "POP-02", situation: "DB 감지 안 됨", text: "DB를 찾지 못했습니다. 확인한 설정 파일 목록을 참고해 주세요.", show: '인라인', buttons: [] },
  'MSG-17': { kind: 'info', screens: "SCR-08", situation: "원본 없이 연 결과", text: "받은 결과 파일에는 소스 코드가 없습니다. 원본 폴더를 연결하면 코드를 볼 수 있습니다.", show: '인라인', buttons: ["원본 폴더 연결"] },
  'MSG-18': { kind: 'err', screens: "SCR-01", situation: "결과 파일 오류", text: "결과 파일을 열 수 없습니다. 이 프로그램에서 저장한 JSON 파일인지 확인해 주세요.", show: '인라인', buttons: [] },
  'MSG-19': { kind: 'err', screens: "SCR-01", situation: "ZIP 열기 실패", text: "ZIP 파일을 열 수 없습니다. 파일이 손상되었거나 암호가 걸려 있습니다.", show: '인라인', buttons: [] },
  'MSG-20': { kind: 'err', screens: "POP-03", situation: "Claude CLI 없음", text: "PC에서 Claude CLI를 찾지 못했습니다. 설치한 뒤 다시 확인하거나 [경로 지정]으로 직접 지정해 주세요.", show: '인라인', buttons: ["경로 지정", "*다시 확인"] },
  'MSG-21': { kind: 'err', screens: "POP-03, SCR-09·11", situation: "인증 필요", text: "Claude 인증에 실패했습니다. Claude Code에 로그인하거나 API 키·회사 클라우드 인증 정보를 확인한 뒤 다시 시도해 주세요.", show: '인라인', buttons: ["터미널에서 로그인", "*다시 확인"] },
  'MSG-22': { kind: 'info', screens: "POP-03, SCR-09·11", situation: "오프라인", text: "인터넷에 연결되어 있지 않아 Claude를 쓸 수 없습니다. 분석·탐색 기능은 그대로 쓸 수 있습니다.", show: '인라인', buttons: ["다시 확인"] },
  'MSG-23': { kind: 'err', screens: "SCR-09·11", situation: "사용 한도", text: "Claude 사용 한도에 도달했습니다. 잠시 후 다시 시도하거나 다른 인증 방식(API 키)으로 바꿔 주세요.", show: '배너', buttons: ["인증 방식 변경"] },
  'MSG-24': { kind: 'confirm', screens: "SCR-09·11", situation: "명령 실행 요청", text: "Claude가 허용 목록에 있는 명령을 실행하려고 합니다: {명령}. 실행할까요?", show: '인라인', buttons: ["거부", "*실행"] },
  'MSG-25': { kind: 'err', screens: "SCR-10·12", situation: "커밋·푸시 실패", text: "{도구} {커밋/푸시}에 실패했습니다: {사유}. 파일은 적용된 상태로 남아 있습니다. PC의 Git·SVN 로그인과 원격 상태를 확인한 뒤 작업 이력에서 다시 시도해 주세요.", show: '배너', buttons: ["*다시 시도"] },
  'MSG-26': { kind: 'err', screens: "SCR-11", situation: "빈 폴더 아님", text: "선택한 폴더가 비어 있지 않습니다. 새 프로젝트는 빈 폴더에서 시작해 주세요.", show: '인라인', buttons: ["다른 폴더 선택"] },
  'MSG-27': { kind: 'confirm', screens: "SCR-12", situation: "변경 되돌리기", text: "적용한 변경(파일 {n}개)을 적용 전 내용으로 되돌립니다. 커밋한 변경이면 되돌린 내용을 커밋할지 고를 수 있습니다. 되돌릴까요?", show: '대화상자', buttons: ["취소", "!되돌리기"] },
  'MSG-28': { kind: 'confirm', screens: "SCR-10", situation: "변경 버리기", text: "작업 사본의 변경(파일 {n}개)을 모두 버립니다. 버릴까요?", show: '대화상자', buttons: ["취소", "!버리기"] },
  'MSG-29': { kind: 'confirm', screens: "SCR-11", situation: "생성 중지", text: "생성을 중지할까요? 지금까지 만든 파일은 그대로 남습니다.", show: '대화상자', buttons: ["계속 진행", "!중지"] },
  'MSG-30': { kind: 'err', screens: "POP-03, SCR-09·11", situation: "결제 문제", text: "Claude 사용 권한이나 결제 문제로 요청이 거절되었습니다. 로그인한 Claude 계정, API 키를 발급한 Console 계정 또는 회사 클라우드의 상태를 확인해 주세요.", show: '배너', buttons: ["다시 확인"] },
  'MSG-31': { kind: 'warn', screens: "SCR-10", situation: "원본이 바뀜", text: "작업 사본을 만든 뒤 원본 파일 {n}개가 바뀌어 그대로 적용할 수 없습니다. 차이를 확인한 뒤 Claude에게 다시 맞춰 달라고 해 주세요.", show: '배너', buttons: ["차이 보기", "*다시 맞추기"] },
  'MSG-32': { kind: 'confirm', screens: "SCR-09·11, SCR-12", situation: "쿼리 실행 확인", text: "{환경} DB {DB}에서 {종류} 쿼리를 실행합니다. 예상 영향 {n}행이며, 트랜잭션 안에서 실행해 행 수가 다르면 롤백합니다. 실행할까요?", show: '대화상자', buttons: ["취소", "*실행"] },
  'MSG-33': { kind: 'confirm', screens: "SCR-09", situation: "운영 DB 변경", text: "운영 DB {DB}를 변경합니다(예상 {n}행). 계속하려면 DB 이름을 입력해 주세요.", show: '대화상자', buttons: ["취소", "!실행"] },
  'MSG-34': { kind: 'err', screens: "SCR-09·12", situation: "행 수 불일치", text: "영향 행 수({실제}행)가 예상({n}행)과 달라 롤백했습니다. 데이터는 바뀌지 않았고 작업 이력에 '롤백됨'으로 남겼습니다.", show: '배너', buttons: ["대화 열기"] },
  'MSG-35': { kind: 'err', screens: "POP-04, SCR-10·12", situation: "형상관리 연결 실패", text: "{도구} 원격 저장소에 연결하지 못했습니다. PC의 Git·SVN 로그인과 서버 주소를 확인해 주세요. 적용은 그대로 할 수 있습니다.", show: '인라인', buttons: ["*연결 확인"] },
  'MSG-36': { kind: 'err', screens: "POP-04, SCR-09", situation: "DB 연결 실패", text: "DB {DB}에 연결하지 못했습니다. 프로젝트 연결의 주소와 계정을 확인해 주세요. 분석과 대화는 그대로 쓸 수 있습니다.", show: '인라인', buttons: ["*연결 확인"] },
  'MSG-37': { kind: 'info', screens: "SCR-09", situation: "개인정보 가림", text: "조회 결과에서 개인정보 컬럼 {n}개를 가리고 Claude에 보냈습니다.", show: '인라인', buttons: [] },
  'MSG-38': { kind: 'info', screens: "SCR-13, POP-01", situation: "실행 주기 없음", text: "이 배치를 실행하는 스케줄 설정을 찾지 못했습니다. 서버의 crontab이나 작업 스케줄러에서 내보낸 파일을 지정하면 실행 주기를 붙입니다.", show: '인라인', buttons: ["스케줄 파일 지정"] },
  'MSG-39': { kind: 'err', screens: "SCR-09, POP-04", situation: "실행 계정 없음", text: "{DB} 연결은 조회 전용이라 {종류} 쿼리를 실행할 수 없습니다. SQL을 복사해 직접 실행하거나 프로젝트 연결에서 변경할 수 있는 계정을 넣어 주세요.", show: '인라인', buttons: ["SQL 복사", "*프로젝트 연결 열기"] },
  'MSG-40': { kind: 'err', screens: "SCR-12", situation: "되돌리기 불가", text: "적용한 뒤 같은 파일이 다시 바뀌어 자동으로 되돌릴 수 없습니다. 차이를 확인한 뒤 Claude에게 되돌리기를 요청해 주세요.", show: '배너', buttons: ["차이 보기", "*Claude에게 요청"] },
  'MSG-41': { kind: 'confirm', screens: "SCR-09", situation: "되돌릴 수 없는 쿼리", text: "{DB}에서 {종류}를 실행하면 바로 확정되어 롤백할 수 없습니다. Claude가 만든 되돌리는 SQL을 작업 이력에 함께 보관합니다. 실행할까요?", show: '대화상자', buttons: ["취소", "!실행"] },
  'MSG-42': { kind: 'confirm', screens: "SCR-09", situation: "운영 DB 조회", text: "Claude가 운영 DB {DB}를 조회하려고 합니다(최대 {n}행, 개인정보 가림). 운영 조회는 항상 확인합니다. 실행할까요?", show: '인라인', buttons: ["SQL 보기", "거부", "*실행"] },
  'MSG-43': { kind: 'warn', screens: "SCR-03, POP-01", situation: "DB 메뉴 읽기 실패", text: "메뉴 테이블 {테이블}을 읽지 못해 소스에서 찾은 메뉴로 대신했습니다. 프로젝트 연결의 DB 설정을 확인해 주세요.", show: '배너', buttons: ["프로젝트 연결 열기"] },
  'MSG-44': { kind: 'info', screens: "POP-05", situation: "내보내기 완료", text: "파일 {n}개를 저장했습니다: {위치}", show: '배너', buttons: ["*폴더 열기"] },
  'MSG-45': { kind: 'err', screens: "POP-05", situation: "내보내기 실패", text: "파일을 저장하지 못했습니다. 같은 파일이 열려 있거나 폴더에 쓰기 권한이 없는지 확인해 주세요.", show: '인라인', buttons: ["*다시 시도"] },
  'MSG-46': { kind: 'info', screens: "SCR-07", situation: "메뉴 출처 차이", text: "DB 메뉴와 소스의 메뉴가 {n}곳 다릅니다. DB 메뉴를 기준으로 표시하고 차이는 확인 필요에 넣었습니다.", show: '배너', buttons: ["차이 보기"] },
};

/** 문구의 {이름}을 값으로 바꾼다. 없는 값은 그대로 둔다 */
export function msg(id: string, vars: Record<string, string | number> = {}): string {
  const d = MSG[id];
  if (!d) return id;
  return d.text.replace(/\{([^{}]+)\}/g, (m, k: string) => {
    const v = vars[k];
    if (v === undefined) return m;
    return typeof v === 'number' ? v.toLocaleString('ko-KR') : v;
  });
}

/** 버튼 이름 (표시용, '*'·'!' 표시를 뗀다) */
export function msgButtons(id: string): { label: string; primary: boolean; danger: boolean }[] {
  return (MSG[id]?.buttons ?? []).map((b) => ({ label: b.replace(/^[*!]/, ''), primary: b.startsWith('*'), danger: b.startsWith('!') }));
}
