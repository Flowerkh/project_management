// JSP 분석기 (작성 예정)
import type { Analyzer } from '../context';

export const jspAnalyzer: Analyzer = {
  name: 'jsp',
  order: 30,
  accepts: () => false,
  analyze: () => {},
};
