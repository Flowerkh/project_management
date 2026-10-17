// 분석기 목록. 순서는 order 값으로 정렬해 실행한다.
import type { Analyzer } from '../context';
import { batchAnalyzer } from './batch';
import { detectAnalyzer } from './detect';
import { goAnalyzer } from './go';
import { javaAnalyzer } from './java';
import { jspAnalyzer } from './jsp';
import { menuAnalyzer } from './menu';
import { mybatisAnalyzer } from './mybatis';
import { phpAnalyzer } from './php';
import { scriptAnalyzer } from './script';
import { sqlFilesAnalyzer } from './sqlfiles';

export const ANALYZERS: Analyzer[] = [
  detectAnalyzer,
  sqlFilesAnalyzer,
  mybatisAnalyzer,
  javaAnalyzer,
  phpAnalyzer,
  goAnalyzer,
  jspAnalyzer,
  scriptAnalyzer,
  menuAnalyzer,
  batchAnalyzer,
].sort((a, b) => a.order - b.order);
