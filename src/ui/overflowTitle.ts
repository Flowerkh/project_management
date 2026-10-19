// 말줄임(…)으로 잘린 글자는 마우스를 올리면 전체 글자를 툴팁(title)으로 보여 준다.
// 화면마다 title을 달지 않아도 되게 문서에 한 번만 설치한다. 직접 단 title(설명)이 있으면 그것을 먼저 쓴다.

const AUTO = 'data-ovt';
/** 마우스가 올라간 요소에서 몇 단계 위까지 잘린 요소를 찾을지 */
const DEPTH = 6;

/** 말줄임으로 잘려 보이는지 (한 줄 말줄임·여러 줄 말줄임) */
export function isClipped(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  const clamp = cs.getPropertyValue('-webkit-line-clamp');
  if (clamp && clamp !== 'none') return el.scrollHeight > el.clientHeight + 1;
  if (cs.textOverflow !== 'ellipsis') return false;
  return el.scrollWidth > el.clientWidth + 1;
}

function fullText(el: HTMLElement): string {
  const raw = el instanceof HTMLInputElement ? el.value : el.innerText;
  const s = raw.replace(/\s+/g, ' ').trim();
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}

function clearAuto(el: Element): void {
  if (!el.hasAttribute(AUTO)) return;
  el.removeAttribute('title');
  el.removeAttribute(AUTO);
}

function onOver(e: MouseEvent): void {
  let el: Element | null = e.target instanceof Element ? e.target : null;
  let hit: HTMLElement | null = null;
  for (let i = 0; el && i < DEPTH; i++, el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    if (isClipped(el)) {
      hit = el;
      break;
    }
    clearAuto(el); // 창을 넓혀 더는 잘리지 않으면 자동 툴팁을 뗀다
  }
  if (!hit || (hit.hasAttribute('title') && !hit.hasAttribute(AUTO))) return;
  const text = fullText(hit);
  // 위쪽 요소에 단 설명이 이미 전체 글자를 담고 있으면 그 설명이 보이게 둔다
  const explicit = hit.parentElement?.closest(`[title]:not([${AUTO}])`)?.getAttribute('title') ?? '';
  if (!text || explicit.includes(text)) {
    clearAuto(hit);
    return;
  }
  hit.setAttribute('title', text);
  hit.setAttribute(AUTO, '');
}

let installed = false;

export function installOverflowTitles(doc: Document = document): void {
  if (installed) return;
  installed = true;
  doc.addEventListener('mouseover', onOver, { passive: true });
}
