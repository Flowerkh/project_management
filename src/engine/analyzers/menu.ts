// Menu 분석기 (작성 예정)
import type { Analyzer } from '../context';

export const menuAnalyzer: Analyzer = {
  name: 'menu',
  order: 60,
  accepts: () => false,
  analyze: () => {},
};
