// 화면과 실행 환경(브라우저·Electron) 사이의 약속.
// Electron은 preload에서 window.__PLATFORM__ 에 같은 모양의 객체를 넣는다.

export interface FolderFile {
  /** 불러온 폴더 기준 상대 경로 (구분자 '/', 최상위 폴더 이름 제외) */
  path: string;
  size: number;
  read(): Promise<Uint8Array>;
}

export interface LoadedFolder {
  /** 최상위 폴더 이름 */
  name: string;
  /** PC의 절대 경로 (데스크톱 앱에서 폴더로 연 경우만. ZIP·브라우저는 없음) */
  root?: string;
  files: FolderFile[];
  /** 읽지 못한 항목 수 (권한 등) */
  skipped?: number;
}

export interface Platform {
  kind: 'browser' | 'electron';
  /** 폴더 선택 창 */
  pickFolder(): Promise<LoadedFolder | null>;
  /** 끌어다 놓은 항목에서 폴더 읽기 */
  fromDrop(dt: DataTransfer): Promise<LoadedFolder | null>;
  /** 텍스트 파일 저장 (브라우저는 내려받기) */
  saveFile(name: string, text: string): Promise<void>;
  /** 텍스트 파일 열기 */
  openTextFile(accept: string): Promise<{ name: string; text: string } | null>;
}

declare global {
  interface Window {
    __PLATFORM__?: Platform;
  }
}
