// MyBatis 분석기 (작성 예정)
import type { Analyzer } from '../context';

export const mybatisAnalyzer: Analyzer = {
  name: 'mybatis',
  order: 10,
  accepts: () => false,
  analyze: () => {},
};
