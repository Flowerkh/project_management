// PHP 분석기 (작성 예정)
import type { Analyzer } from '../context';

export const phpAnalyzer: Analyzer = {
  name: 'php',
  order: 25,
  accepts: () => false,
  analyze: () => {},
};
