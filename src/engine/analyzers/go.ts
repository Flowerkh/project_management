// Go 분석기 (작성 예정)
import type { Analyzer } from '../context';

export const goAnalyzer: Analyzer = {
  name: 'go',
  order: 26,
  accepts: () => false,
  analyze: () => {},
};
