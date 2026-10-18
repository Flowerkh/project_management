// 화면설계서와 같은 선 아이콘 (24×24, stroke)
const PATHS: Record<string, string> = {
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z',
  folder_plus: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z M12 10.5v5 M9.5 13h5',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5',
  table: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M3 10h18 M3 14.5h18 M9 10v9',
  db: 'M4 6c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3z M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6 M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3',
  menu: 'M9 6h12 M9 12h12 M9 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  screen: 'M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M8 20h8 M12 16v4',
  search: 'M11 4a7 7 0 1 1 0 14a7 7 0 1 1 0-14z M20 20l-4.2-4.2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
  play: 'M8 5.5v13l10.5-6.5z',
  stop: 'M7 7h10v10H7z',
  upload: 'M12 15V4 M7.5 8.5L12 4l4.5 4.5 M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15',
  chev_down: 'M6 9l6 6 6-6',
  chev_right: 'M9 6l6 6-6 6',
  chev_up: 'M6 15l6-6 6 6',
  chev_up_down: 'M7 9l5-5 5 5 M7 15l5 5 5-5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12 M18 6L6 18',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  download: 'M12 4v11 M7.5 10.5L12 15l4.5-4.5 M4 19.5h16',
  warn: 'M12 3.5l9 16H3z M12 10v4.5 M12 17.2v.01',
  lock: 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z M8 11V8a4 4 0 0 1 8 0v3',
  info: 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z M12 11v5.5 M12 7.6v.01',
  arrow_r: 'M5 12h14 M13.5 6.5L19 12l-5.5 5.5',
  clock: 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z M12 7.5V12l3 2',
  code: 'M8.5 7L3.5 12l5 5 M15.5 7l5 5-5 5',
  layers: 'M12 3.5l8.5 4.5L12 12.5 3.5 8z M3.5 12.5L12 17l8.5-4.5 M3.5 16.5L12 21l8.5-4.5',
  spinner: 'M12 3a9 9 0 1 0 9 9',
  zip: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M10 6h1.5 M10 9h1.5 M10 12h1.5 M10 15h3v2.5h-3z',
  json: 'M8 4c-2 0-2.5 1-2.5 3v2c0 1.5-.8 2.5-2 3 1.2.5 2 1.5 2 3v2c0 2 .5 3 2.5 3 M16 4c2 0 2.5 1 2.5 3v2c0 1.5.8 2.5 2 3-1.2.5-2 1.5-2 3v2c0 2-.5 3-2.5 3',
  plus: 'M12 5v14 M5 12h14',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.5-1.5',
  arrow_up: 'M12 19V5 M6.5 10.5L12 5l5.5 5.5',
  arrow_down: 'M12 5v14 M6.5 13.5L12 19l5.5-5.5',
  terminal: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 9.5l3 2.5-3 2.5 M12 15h5',
  refresh: 'M20 11a8 8 0 0 0-14.9-3.5 M4 4.5V8h3.5 M4 13a8 8 0 0 0 14.9 3.5 M20 19.5V16h-3.5',
  shield: 'M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z',
  sliders: 'M4 7h9 M17 7h3 M15 5v4 M4 12h3 M11 12h9 M9 10v4 M4 17h11 M19 17h1 M17 15v4',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z M12 9.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z',
  batch: 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z M12 7.5V12l3 2',
  filter: 'M4 5h16l-6.2 7.5V18l-3.6 2v-7.5z',
  external: 'M14 4h6v6 M20 4l-8.5 8.5 M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5',
  chat: 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-4.5 3.5V17H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  send: 'M4.5 12L20 4.5l-4.5 15.5-3.5-6.5z M12 13.5L20 4.5',
  undo: 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  branch: 'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
  user: 'M12 12a4 4 0 1 0 0-8a4 4 0 1 0 0 8z M4.5 20a7.5 7.5 0 0 1 15 0',
  sparkle: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  stamp: 'M12 3.5a3.5 3.5 0 0 1 2.2 6.2c-.6.5-.9 1.2-.9 2V13h4.7a2 2 0 0 1 2 2v2H4v-2a2 2 0 0 1 2-2h4.7v-1.3c0-.8-.3-1.5-.9-2A3.5 3.5 0 0 1 12 3.5z M5 20.5h14',
  key: 'M14.5 4a5.5 5.5 0 1 1-4.9 8l-6.1 6.1V21h3v-2h2v-2h2l1.6-1.6A5.5 5.5 0 0 1 14.5 4z M16.5 7.5v.01',
  git: 'M6 4.5v15 M6 11.5c0-3 2.5-4.5 6-4.5h3 M18 7a2 2 0 1 1 0-4a2 2 0 1 1 0 4z M6 21.5a2 2 0 1 1 0-4a2 2 0 1 1 0 4z',
};

export type IconName = keyof typeof PATHS | string;

export function Icon(props: { name: IconName; size?: number; color?: string; sw?: number; class?: string; filled?: boolean; title?: string }) {
  const { name, size = 16, color = 'currentColor', sw = 1.8, filled } = props;
  const d = PATHS[name] ?? PATHS.file;
  if (filled) {
    return (
      <svg class={`ic ${props.class ?? ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ fill: color, stroke: 'none' }}>
        <path d={d} />
      </svg>
    );
  }
  return (
    <svg class={`ic ${props.class ?? ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ stroke: color, strokeWidth: sw }}>
      <path d={d} />
    </svg>
  );
}

export function Logo() {
  return (
    <span class="brand-logo" aria-hidden="true">
      <Icon name="layers" size={18} color="#FFFFFF" sw={2} />
    </span>
  );
}

export function Spinner(props: { size?: number; color?: string }) {
  return <Icon name="spinner" size={props.size ?? 14} color={props.color ?? 'var(--acc)'} sw={2.2} class="spin" />;
}
