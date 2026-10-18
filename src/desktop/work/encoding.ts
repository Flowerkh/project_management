// 작업 사본의 문자 인코딩: 원본이 EUC-KR(CP949)·UTF-16이면 사본에는 UTF-8로 쓰고(Claude가 한글을 안전하게 고치게),
// 적용할 때 원래 인코딩으로 되돌려 저장한다. 원래 인코딩으로 저장할 수 없는 글자가 있으면 그 파일은 적용하지 않는다.
import crypto from 'node:crypto';
import iconv from 'iconv-lite';

/** utf8 / utf8bom / euckr(CP949) / utf16le·be(BOM) / raw(판별 불가, 그대로 복사) / binary */
export type Enc = 'utf8' | 'utf8bom' | 'euckr' | 'utf16le' | 'utf16be' | 'raw' | 'binary';

const BINARY_EXT =
  /\.(png|jpe?g|gif|bmp|ico|webp|tiff?|psd|ai|zip|jar|war|ear|gz|tgz|bz2|7z|rar|xz|tar|class|exe|dll|so|dylib|o|a|lib|pyc|pyo|apk|aab|ipa|dex|pdf|docx?|xlsx?|pptx?|hwpx?|odt|woff2?|ttf|otf|eot|mp3|mp4|avi|mov|wav|flv|swf|keystore|jks|p12|pfx|der|sqlite|mdb|bin)$/i;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const BOM8 = Buffer.from([0xef, 0xbb, 0xbf]);

export function sha1(buf: Uint8Array): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

export function looksBinary(buf: Uint8Array): boolean {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface Decoded {
  enc: Enc;
  /** 텍스트 (binary면 null) */
  text: string | null;
}

/** 원본 바이트 → 인코딩과 텍스트 */
export function decodeBytes(buf: Buffer, rel = ''): Decoded {
  if ((rel && BINARY_EXT.test(rel)) || looksBinary(buf)) return { enc: 'binary', text: null };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    try {
      return { enc: 'utf8bom', text: strictUtf8.decode(buf.subarray(3)) };
    } catch {
      return { enc: 'raw', text: iconv.decode(buf.subarray(3), 'utf8') };
    }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { enc: 'utf16le', text: iconv.decode(buf.subarray(2), 'utf16le') };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { enc: 'utf16be', text: iconv.decode(buf.subarray(2), 'utf16-be') };
  try {
    return { enc: 'utf8', text: strictUtf8.decode(buf) };
  } catch {
    const text = iconv.decode(buf, 'cp949');
    // 되돌려 저장했을 때 원본과 같아야 EUC-KR로 본다 (아니면 손대지 않고 그대로 복사)
    if (iconv.encode(text, 'cp949').equals(buf)) return { enc: 'euckr', text };
    return { enc: 'raw', text };
  }
}

/** 작업 사본에 쓸 바이트. text를 주면(값 가림) 그 텍스트로 */
export function toCopyBytes(buf: Buffer, dec: Decoded, text?: string): Buffer {
  switch (dec.enc) {
    case 'binary':
    case 'raw':
      return buf;
    case 'utf8':
      return text === undefined ? buf : Buffer.from(text, 'utf8');
    case 'utf8bom':
      return text === undefined ? buf : Buffer.concat([BOM8, Buffer.from(text, 'utf8')]);
    default:
      return Buffer.from(text ?? dec.text ?? '', 'utf8');
  }
}

/** 작업 사본 바이트 → 텍스트 (사본은 UTF-8. Claude가 다른 인코딩으로 썼으면 CP949로 읽어 봄) */
export function copyText(buf: Buffer, enc: Enc): string | null {
  if (enc === 'binary' || looksBinary(buf)) return null;
  if (enc === 'raw') return iconv.decode(buf, 'cp949');
  const b = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return strictUtf8.decode(b);
  } catch {
    return iconv.decode(b, 'cp949');
  }
}

/** 원본 바이트 → 화면 비교용 텍스트 */
export function origText(buf: Buffer, rel = ''): { enc: Enc; text: string | null } {
  return decodeBytes(buf, rel);
}

function lineCol(text: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** 텍스트 → 원본 인코딩 바이트. 저장할 수 없는 글자가 있으면 error */
export function encodeBack(text: string, enc: Enc): { bytes: Buffer; error?: undefined } | { bytes?: undefined; error: string } {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  switch (enc) {
    case 'utf8':
      return { bytes: Buffer.from(t, 'utf8') };
    case 'utf8bom':
      return { bytes: Buffer.concat([BOM8, Buffer.from(t, 'utf8')]) };
    case 'utf16le':
      return { bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(t, 'utf16le')]) };
    case 'utf16be':
      return { bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(t, 'utf16-be')]) };
    case 'euckr': {
      const bytes = iconv.encode(t, 'cp949');
      if (iconv.decode(bytes, 'cp949') === t) return { bytes };
      // 어느 글자가 문제인지 찾아 알린다
      for (let i = 0; i < t.length; i++) {
        const cp = t.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        if (iconv.decode(iconv.encode(ch, 'cp949'), 'cp949') !== ch) {
          return { error: `EUC-KR로 저장할 수 없는 글자 '${ch}'(${lineCol(t, i)}번째 줄)가 있어 적용할 수 없습니다` };
        }
        if (cp > 0xffff) i++;
      }
      return { error: 'EUC-KR로 저장할 수 없는 글자가 있어 적용할 수 없습니다' };
    }
    default:
      return { error: '인코딩을 알 수 없는 파일이라 적용할 수 없습니다' };
  }
}

/** 새로 만든 파일: 내용에 EUC-KR 선언(pageEncoding·charset·encoding)이 있으면 EUC-KR로 저장 */
export function encForNewFile(text: string): Enc {
  const head = text.slice(0, 4000);
  return /(pageEncoding|charset|encoding)\s*=\s*["']?\s*(euc-kr|euckr|ks_c_5601-1987|cp949|ms949|x-windows-949)\b/i.test(head) ? 'euckr' : 'utf8';
}
