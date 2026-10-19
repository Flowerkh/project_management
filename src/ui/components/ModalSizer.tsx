// 대화상자 크기 조절: 오른쪽 아래 모서리(가로·세로)나 아래 가장자리(세로)를 마우스로 끈다.
// 양옆 가장자리(가로)는 sides일 때만 둔다 (오른쪽 손잡이는 본문 스크롤 막대와 겹치지 않게 얇게).
// 크기는 대화상자마다 이 PC(브라우저 저장소)에 기억하고, 모서리를 두 번 누르면 원래 크기로 돌아간다.
// 대화상자(.modal)의 마지막 자식으로 넣는다. 화면보다 커지지 않게 최대 크기는 창 크기를 따른다.
import { useLayoutEffect, useRef } from 'preact/hooks';

interface Size {
  w?: number;
  h?: number;
}

const KEY = 'pa.modalSize.';
/** 창 가장자리와 띄울 거리 */
const GAP = 12;

function load(id: string): Size | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY + id) ?? 'null') as Size | null;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function store(id: string, s: Size | null): void {
  try {
    if (s && (s.w || s.h)) localStorage.setItem(KEY + id, JSON.stringify(s));
    else localStorage.removeItem(KEY + id);
  } catch {
    // 저장소를 못 쓰면 이번에만 적용
  }
}

/** top: 위가 고정된 창의 윗변 위치 (세로 가운데 정렬이면 null) */
function apply(modal: HTMLElement, s: Size, top: number | null): void {
  if (s.w) {
    modal.style.width = `${s.w}px`;
    modal.style.maxWidth = `calc(100vw - ${GAP * 2}px)`;
  }
  if (s.h) {
    modal.style.height = `${s.h}px`;
    modal.style.maxHeight = top === null ? `calc(100vh - ${GAP * 2}px)` : `calc(100vh - ${Math.round(top) + GAP}px)`;
  }
  modal.classList.toggle('rz-sized', !!(s.w || s.h));
}

function reset(modal: HTMLElement): void {
  for (const p of ['width', 'maxWidth', 'height', 'maxHeight'] as const) modal.style[p] = '';
  modal.classList.remove('rz-sized');
}

/**
 * id: 크기를 기억할 이름 · minWidth: 이보다 좁게는 못 줄임 (기본 420, 처음 크기가 더 작으면 처음 크기)
 * center: 창이 가로·세로 모두 가운데 정렬 (부모가 가운데로 놓지 않고 창 스스로 margin:auto로 가운데에 있을 때)
 * sides: 왼쪽·오른쪽 가장자리로도 너비 조절
 */
export function ModalSizer(props: { id: string; minWidth?: number; center?: boolean; sides?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const modal = () => ref.current?.parentElement ?? null;

  useLayoutEffect(() => {
    const m = modal();
    const s = load(props.id);
    if (m && s) apply(m, s, props.center ? null : m.getBoundingClientRect().top);
    // 손잡이가 없어지면(크게 보기를 닫음 등) 직접 정한 크기를 뗀다
    return () => {
      if (m) reset(m);
    };
  }, [props.id]);

  /** dx: 너비를 바꾸는 쪽 (1 오른쪽 가장자리 · -1 왼쪽 가장자리 · 0 바꾸지 않음) */
  const start = (e: PointerEvent, dx: -1 | 0 | 1, ay: boolean) => {
    const m = modal();
    if (!m || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = m.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 가운데 정렬된 쪽은 양쪽으로 늘어나므로 두 배로 바꿔야 끄는 가장자리가 마우스를 따라온다
    const ps = m.parentElement ? getComputedStyle(m.parentElement) : null;
    const kx = props.center || ps?.justifyContent === 'center' ? 2 : 1;
    const ky = props.center || ps?.alignItems === 'center' ? 2 : 1;
    const minW = Math.min(r.width, props.minWidth ?? 420);
    const minH = Math.min(r.height, 220);
    const maxW = vw - GAP * 2;
    const maxH = ky === 2 ? vh - GAP * 2 : vh - r.top - GAP;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const size: Size = { ...(load(props.id) ?? {}) };
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const dragCls = dx && ay ? 'rz-drag-xy' : dx ? 'rz-drag-x' : 'rz-drag-y';
    document.body.classList.add(dragCls);
    const move = (ev: PointerEvent) => {
      if (dx) size.w = Math.round(Math.max(minW, Math.min(maxW, r.width + dx * kx * (ev.clientX - x0))));
      if (ay) size.h = Math.round(Math.max(minH, Math.min(maxH, r.height + ky * (ev.clientY - y0))));
      apply(m, size, ky === 2 ? null : r.top);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove(dragCls);
      store(props.id, size);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const restore = () => {
    const m = modal();
    if (m) reset(m);
    store(props.id, null);
  };

  return (
    <div ref={ref} class="rz">
      <div class="rz-s" aria-hidden="true" onPointerDown={(e) => start(e, 0, true)} />
      {props.sides && (
        <>
          <div class="rz-w" aria-hidden="true" title="끌어서 너비 조절 · 두 번 누르면 원래 크기" onPointerDown={(e) => start(e, -1, false)} onDblClick={restore} />
          <div class="rz-e" aria-hidden="true" title="끌어서 너비 조절 · 두 번 누르면 원래 크기" onPointerDown={(e) => start(e, 1, false)} onDblClick={restore} />
        </>
      )}
      <div class="rz-se" title="끌어서 크기 조절 · 두 번 누르면 원래 크기" onPointerDown={(e) => start(e, 1, true)} onDblClick={restore}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M9 3 3 9M9 6.5 6.5 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </div>
    </div>
  );
}
