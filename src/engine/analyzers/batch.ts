// Batch 분석기 (작성 예정)
import type { Analyzer } from '../context';

export const batchAnalyzer: Analyzer = {
  name: 'batch',
  order: 70,
  accepts: () => false,
  analyze: () => {},
};
