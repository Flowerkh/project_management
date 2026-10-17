// 화면용 JS: ajax·이동 URL을 모아, 이 파일을 불러오는 화면에 붙도록 조각 ViewFact로 남긴다
import type { Analyzer } from '../context';
import { makeLineIndex } from '../files';
import { stripCComments } from './jutil';
import { dedupeUrls, jsUrls } from './urls';

export const scriptAnalyzer: Analyzer = {
  name: 'script',
  order: 35,
  accepts: (f) => (f.lang === 'JavaScript' || f.lang === 'TypeScript') && (f.layer === 'SCRIPT' || f.layer === 'VIEW'),
  analyze(f, text, ctx) {
    if (text.length > 600_000) return;
    const code = stripCComments(text);
    const lineOf = makeLineIndex(text);
    const urls = dedupeUrls(jsUrls(code));
    if (!urls.length) return;
    ctx.facts.views.push({
      file: f.id,
      kind: 'other',
      fragment: true,
      urls: urls.map((u) => ({ url: u.url, kind: u.kind, file: f.id, line: lineOf(u.index), ...(u.method ? { method: u.method } : {}) })),
      includes: [],
      scripts: [],
    });
  },
};
