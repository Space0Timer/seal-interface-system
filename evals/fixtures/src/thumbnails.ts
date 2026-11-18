// Deterministic abstract thumbnails. Fixture content, not product styling.
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function thumbnailSvg(id: string): string {
  const h = hash(id);
  const hue = h % 360;
  const hue2 = (hue + 40 + (h % 120)) % 360;
  const cx = 30 + (h % 40);
  const cy = 30 + ((h >>> 8) % 40);
  const r = 14 + ((h >>> 16) % 18);
  const horizon = 55 + ((h >>> 4) % 25);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="160" height="160">',
    `<rect width="100" height="100" fill="hsl(${hue} 45% 72%)"/>`,
    `<rect y="${horizon}" width="100" height="${100 - horizon}" fill="hsl(${hue2} 35% 42%)"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${(hue + 180) % 360} 55% 88%)"/>`,
    '</svg>',
  ].join('');
}
