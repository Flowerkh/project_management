// DB 메뉴 테이블에서 읽은 메뉴(데스크톱 앱이 분석 전에 조회 계정으로 SELECT)를 메뉴 사실로 넣는다.
// DB 메뉴가 있으면 메뉴 트리는 DB를 기준으로 그리고(link.ts SOURCE_RANK), 소스에서 찾은 메뉴와 다른 곳은 '확인 필요'에 넣는다(MSG-46).
import { normUrl } from './link';
import type { DbMenuInput, Facts, MenuFact } from './types';

const ROOT_KEYS = new Set(['', '0', '-1', 'root', 'top', 'null', 'none']);

export function addDbMenus(facts: Facts, input: DbMenuInput): number {
  const table = input.table || '메뉴 테이블';
  const seen = new Set<string>();
  const rows = input.rows.filter((r) => {
    const k = String(r.key ?? '').trim();
    if (!k || seen.has(k) || !String(r.name ?? '').trim()) return false;
    seen.add(k);
    return true;
  });
  const sourceMenus = facts.menus.filter((m) => m.source !== 'db' && m.source !== 'url-guess');
  for (const r of rows) {
    const key = String(r.key).trim();
    const pk = r.parentKey === undefined || r.parentKey === null ? '' : String(r.parentKey).trim();
    const parent = !ROOT_KEYS.has(pk.toLowerCase()) && pk !== key && seen.has(pk) ? `db:${pk}` : undefined;
    const url = r.url && String(r.url).trim() && !/^(#|javascript:|null$)/i.test(String(r.url).trim()) ? String(r.url).trim() : undefined;
    const f: MenuFact = {
      key: `db:${key}`,
      ...(parent ? { parentKey: parent } : {}),
      name: String(r.name).trim(),
      ...(url ? { url } : {}),
      ...(typeof r.order === 'number' && Number.isFinite(r.order) ? { order: r.order } : {}),
      source: 'db',
      evidence: { file: '', line: 0, text: table },
    };
    facts.menus.push(f);
  }
  // 소스 메뉴와 비교: URL 기준 (URL이 없는 상위 메뉴는 이름으로)
  if (sourceMenus.length && rows.length) {
    const keyOf = (name: string, url?: string) => (url ? `u:${normUrl(url)}` : `n:${name.replace(/\s+/g, '')}`);
    const dbKeys = new Map<string, string>();
    for (const r of rows) dbKeys.set(keyOf(String(r.name).trim(), r.url ? String(r.url) : undefined), String(r.name).trim());
    const srcKeys = new Map<string, string>();
    for (const m of sourceMenus) srcKeys.set(keyOf(m.name, m.url), m.name);
    const items: { ref: string; note?: string }[] = [];
    for (const [k, name] of dbKeys) if (!srcKeys.has(k)) items.push({ ref: name, note: `DB에만 있음${k.startsWith('u:') ? ` (${k.slice(2)})` : ''}` });
    for (const [k, name] of srcKeys) if (!dbKeys.has(k)) items.push({ ref: name, note: `소스에만 있음${k.startsWith('u:') ? ` (${k.slice(2)})` : ''}` });
    if (items.length)
      facts.notes.push({
        kind: 'menu-mismatch',
        title: 'DB 메뉴와 소스 메뉴가 다른 곳',
        detail: `DB 메뉴(${table})를 기준으로 표시했습니다`,
        items: items.slice(0, 300),
      });
  }
  return rows.length;
}
