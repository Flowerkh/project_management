// JavaScript 분석기 (작성 예정)
import type { Analyzer } from '../context';

export const scriptAnalyzer: Analyzer = {
  name: 'script',
  order: 35,
  accepts: () => false,
  analyze: () => {},
};
