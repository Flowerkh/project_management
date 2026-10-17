// Java 분석기 (작성 예정)
import type { Analyzer } from '../context';

export const javaAnalyzer: Analyzer = {
  name: 'java',
  order: 20,
  accepts: () => false,
  analyze: () => {},
};
