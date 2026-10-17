// 분석 작업자(Web Worker). 화면이 멈추지 않도록 엔진을 여기서 돌린다.
// 받는 메시지: { type: 'analyze', files: { path, size, bytes? }[], opts }
// 보내는 메시지: progress / result / error
import { analyze } from './engine/index';
import type { AnalyzeOptions, Progress, SourceFile } from './engine/types';

interface AnalyzeMsg {
  type: 'analyze';
  files: SourceFile[];
  opts: Omit<AnalyzeOptions, 'onProgress'>;
}

const post = (m: unknown) => (self as unknown as { postMessage: (m: unknown) => void }).postMessage(m);

self.onmessage = async (e: MessageEvent<AnalyzeMsg>) => {
  const msg = e.data;
  if (!msg || msg.type !== 'analyze') return;
  let last = 0;
  let lastKey = '';
  try {
    const result = await analyze(msg.files, {
      ...msg.opts,
      onProgress: (p: Progress) => {
        const now = Date.now();
        const key = `${p.step}|${p.message ?? ''}`;
        // 단계·메시지가 바뀌었거나 50ms 지났을 때만 보낸다
        if (key !== lastKey || now - last > 50 || p.done >= p.total) {
          last = now;
          lastKey = key;
          post({ type: 'progress', p });
        }
      },
    });
    post({ type: 'result', result });
  } catch (err) {
    const error = err as Error;
    post({ type: 'error', message: error?.message ?? String(err), stack: error?.stack });
  }
};
