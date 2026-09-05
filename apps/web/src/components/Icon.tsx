/** Иконки утверждённого макета. Перенесены один в один из макета,
 *  меняются только атрибуты под JSX. */
export const ICONS: Record<string, string> = {
  "watch": "<circle cx=\"12\" cy=\"12\" r=\"6.5\"/><path d=\"M12 9v3l2 1.6M8.5 5.6L9 2h6l.5 3.6M8.5 18.4L9 22h6l.5-3.6\"/>",
  "watch2": "<rect x=\"6\" y=\"4\" width=\"12\" height=\"16\" rx=\"4\"/><path d=\"M12 9v3.5l2.5 1.5\"/>",
  "ring": "<circle cx=\"12\" cy=\"14\" r=\"5\"/><path d=\"M8.5 9.6L10 3h4l1.5 6.6\"/>",
  "clock": "<circle cx=\"12\" cy=\"12\" r=\"7\"/><path d=\"M12 8v4l3 2\"/>",
  "tv": "<rect x=\"2.5\" y=\"4\" width=\"19\" height=\"13\" rx=\"2\"/><path d=\"M8 21h8\"/>",
  "vacuum": "<circle cx=\"12\" cy=\"14\" r=\"6\"/><path d=\"M12 8V4h6\"/>",
  "lens": "<circle cx=\"12\" cy=\"12\" r=\"7\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2v3M12 19v3\"/>",
  "amp": "<rect x=\"3\" y=\"6\" width=\"18\" height=\"12\" rx=\"2\"/><circle cx=\"8\" cy=\"12\" r=\"2.5\"/><path d=\"M14 10h4M14 14h4\"/>",
  "coffee": "<rect x=\"4\" y=\"5\" width=\"13\" height=\"10\" rx=\"2\"/><path d=\"M17 8h2.5a2 2 0 0 1 0 4H17M6 19h11\"/>",
  "turntable": "<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2\"/><circle cx=\"10\" cy=\"12\" r=\"4\"/><path d=\"M16 8l2 6\"/>",
  "rug": "<rect x=\"3\" y=\"6\" width=\"18\" height=\"12\" rx=\"1.5\"/><path d=\"M6 6v12M18 6v12M3 10h18M3 14h18\"/>",
  "book": "<path d=\"M4 4h9a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z\"/><path d=\"M16 7h4v13h-4\"/>",
  "laptop": "<rect x=\"4\" y=\"5\" width=\"16\" height=\"11\" rx=\"2\"/><path d=\"M2 19h20\"/>",
  "bike": "<circle cx=\"6\" cy=\"17\" r=\"3.5\"/><circle cx=\"18\" cy=\"17\" r=\"3.5\"/><path d=\"M6 17l4-8h6l-3 8M9 6h4\"/>",
  "tools": "<path d=\"M14.5 6.5a4 4 0 0 1 5.2 5.2l-8 8a2.4 2.4 0 0 1-3.4-3.4l8-8z\"/><path d=\"M6 3l2 4-4-2z\"/>",
  "chair": "<path d=\"M6 4h12v8H6z\"/><path d=\"M5 12h14M7 12v8M17 12v8\"/>",
  "card": "<rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"2\"/><path d=\"M8 8h8M8 12h5\"/>",
  "camera": "<rect x=\"2.5\" y=\"6.5\" width=\"19\" height=\"13\" rx=\"2.5\"/><circle cx=\"12\" cy=\"13\" r=\"4\"/><path d=\"M8.5 6.5l1.4-2.6h4.2l1.4 2.6\"/>",
  "home": "<path d=\"M3.5 10.5L12 3.5l8.5 7M5.5 9.6V20h13V9.6\"/><path d=\"M10 20v-5.5h4V20\"/>",
  "bolt": "<path d=\"M13 2L4.5 13.5H11L10 22l8.5-11.5H12z\"/>",
  "search": "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"M20 20l-3.6-3.6\"/>",
  "heart": "<path d=\"M12 20s-7-4.5-7-9.4A4.1 4.1 0 0 1 12 7.7a4.1 4.1 0 0 1 7 2.9c0 4.9-7 9.4-7 9.4z\"/>",
  "bell": "<path d=\"M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 20h4\"/>",
  "share": "<path d=\"M12 16V4M8 7.5L12 3.5l4 4\"/><path d=\"M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5\"/>",
  "link": "<path d=\"M10 13a4 4 0 0 0 5.7.4l2.6-2.6a4 4 0 0 0-5.7-5.7L11 6.7\"/><path d=\"M14 11a4 4 0 0 0-5.7-.4L5.7 13.2a4 4 0 0 0 5.7 5.7L13 17.3\"/>",
  "mail": "<rect x=\"2.5\" y=\"5\" width=\"19\" height=\"14\" rx=\"2\"/><path d=\"M3 7l9 6 9-6\"/>",
  "wa": "<path d=\"M4 20l1.4-4A8 8 0 1 1 8 18.6z\"/><path d=\"M9 10c0 3 2 5 5 5\"/>",
  "tg": "<path d=\"M21 4L3 11l5 2 2 6 3-4 5 4z\"/>",
  "fb": "<path d=\"M14 8h3V5h-3a4 4 0 0 0-4 4v2H8v3h2v7h3v-7h3l1-3h-4V9a1 1 0 0 1 1-1z\"/>",
  "timer": "<circle cx=\"12\" cy=\"13\" r=\"8\"/><path d=\"M12 9v4l2.5 2M9 2h6\"/>",
  "tag": "<path d=\"M20.6 13.4L13 21a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 2.6 12V4.6A2 2 0 0 1 4.6 2.6H12a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 3z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\"1.2\"/>",
  "art": "<path d=\"M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2s-1-1.4-1-2.4 1-1.6 2-1.6h1.6A4.4 4.4 0 0 0 21 10.6C21 6.4 16.9 3 12 3z\"/><circle cx=\"7.6\" cy=\"11.6\" r=\"1.1\"/><circle cx=\"12\" cy=\"8.2\" r=\"1.1\"/><circle cx=\"16.2\" cy=\"11\" r=\"1.1\"/>",
  "audio": "<path d=\"M5 14v-2a7 7 0 0 1 14 0v2\"/><rect x=\"2.5\" y=\"13\" width=\"4.5\" height=\"7\" rx=\"2.2\"/><rect x=\"17\" y=\"13\" width=\"4.5\" height=\"7\" rx=\"2.2\"/>",
  "plus": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 8v8M8 12h8\"/>",
  "gavel": "<path d=\"M4 19h16M7 15l5-11 5 11M9.2 11h5.6\"/>",
  "arrow": "<path d=\"M4 12h15M13 6l6 6-6 6\"/>",
  "check": "<path d=\"M20 6L9 17l-5-5\"/>",
  "box": "<path d=\"M3 8l9-4 9 4v8l-9 4-9-4z\"/><path d=\"M3 8l9 4 9-4M12 12v8\"/>",
  /* Корзина — тем же контуром и толщиной линии, что остальные значки шапки. */
  "cart": "<path d=\"M3 4h2.2l2.3 10.3a2 2 0 0 0 2 1.7h7.1a2 2 0 0 0 2-1.6L20.2 8H6.2\"/><circle cx=\"10\" cy=\"19.3\" r=\"1.3\"/><circle cx=\"17\" cy=\"19.3\" r=\"1.3\"/>",
  "shield": "<path d=\"M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z\"/><path d=\"M9 12l2 2 4-4\"/>",
  "x": "<path d=\"M6 6l12 12M18 6L6 18\"/>",
  "globe": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18-2.5-2.6-2.5-15.4 0-18z\"/>",
  "pin": "<path d=\"M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z\"/><circle cx=\"12\" cy=\"10\" r=\"2.6\"/>",
  "menu": "<path d=\"M4 7h16M4 12h16M4 17h16\"/>",
  "gear": "<circle cx=\"12\" cy=\"12\" r=\"3.2\"/><path d=\"M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z\"/>",
  "sliders": "<path d=\"M4 7h10M18 7h2M4 17h6M14 17h6\"/><circle cx=\"16\" cy=\"7\" r=\"2.2\"/><circle cx=\"12\" cy=\"17\" r=\"2.2\"/>",
  "dot": "<circle cx=\"12\" cy=\"12\" r=\"3.2\"/>",
  "chev": "<path d=\"M6 9l6 6 6-6\"/>",
  "grid": "<rect x=\"3\" y=\"3\" width=\"7.5\" height=\"7.5\" rx=\"2\"/><rect x=\"13.5\" y=\"3\" width=\"7.5\" height=\"7.5\" rx=\"2\"/><rect x=\"3\" y=\"13.5\" width=\"7.5\" height=\"7.5\" rx=\"2\"/><rect x=\"13.5\" y=\"13.5\" width=\"7.5\" height=\"7.5\" rx=\"2\"/>",
};

export function Icon({ name, size, className }: { name: string; size?: number; className?: string }) {
  const d = ICONS[name];
  if (!d) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: d }}
    />
  );
}
