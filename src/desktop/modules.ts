// 메인 프로세스 모듈 등록 순서: project → history → vcs → work → db → claude (뒤 모듈이 앞 모듈의 services를 쓴다)
import { register as claude } from './claude/index';
import { register as db } from './db/index';
import { register as history } from './history';
import { register as project } from './project';
import { register as vcs } from './vcs/index';
import { register as work } from './work/index';

export function registerAll(): void {
  project();
  history();
  vcs();
  work();
  db();
  claude();
}
