// Fixture data for the asset-library eval. Deterministic: the same data on
// every run, for every condition. Deliberately messy: long and unicode
// filenames, near-duplicates, missing thumbnails, a zero-byte file, sizes
// from 1 KB to 4 GB, and a 10,000-asset scenario.

export const NOW = '2026-11-18T09:30:00Z';

/** 100 MB, in bytes. Uploads larger than this fail validation. */
export const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

/** Fails once with connection_interrupted, then succeeds. */
export const TRANSIENT_FAILURE_FILENAME = 'campaign-header.png';

/** Exceeds UPLOAD_LIMIT_BYTES. */
export const OVERSIZED_FILENAME = 'Q3-brand-guidelines-final-v2.pdf';

/** No asset matches this in any scenario. */
export const NO_RESULTS_QUERY = 'invoice-2023';

export const SCENARIOS = ['default', 'empty', 'large'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const LARGE_COUNT = 10_000;

export interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  /** null when no preview exists (unsupported type, still processing, or failed). */
  thumbnailUrl: string | null;
  dimensions: { width: number; height: number } | null;
  durationSeconds: number | null;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  psd: 'image/vnd.adobe.photoshop',
  ai: 'application/postscript',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
};

export function mimeFor(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  return (ext && MIME[ext]) ?? 'application/octet-stream';
}

export function thumbnailUrlFor(id: string): string {
  return `/api/thumbnails/${id}.svg`;
}

type Curated = [
  filename: string,
  sizeBytes: number,
  updatedAt: string,
  hasThumbnail: boolean,
  dimensions?: [number, number] | undefined,
  durationSeconds?: number,
];

// Most recent first. Dates are relative to NOW.
const CURATED: Curated[] = [
  ['Q4-2025-board-deck-FINAL-final-v7-approved-by-legal-do-not-edit.pptx', 48_234_112, '2026-11-17T16:42:00Z', true],
  ['homepage-hero@2x.png', 3_482_119, '2026-11-17T11:05:00Z', true, [2880, 1600]],
  ['product-demo-walkthrough-for-enterprise-customers-with-captions-and-chapters-1080p.mp4', 1_284_771_840, '2026-11-16T15:20:00Z', true, [1920, 1080], 754],
  ['IMG_20261103_142233.HEIC', 2_901_334, '2026-11-15T08:12:00Z', false, [4032, 3024]],
  ['brand-guidelines-2026.pdf', 18_334_201, '2026-11-14T10:00:00Z', true],
  ['Brand Guidelines 2026.pdf', 18_334_201, '2026-11-14T09:58:00Z', true],
  ['Untitled design (3).png', 412_008, '2026-11-14T09:33:00Z', true, [1080, 1080]],
  ['logo-mark.svg', 4_211, '2026-11-13T17:45:00Z', true, [512, 512]],
  ['pricing-table.xlsx', 88_120, '2026-11-13T14:02:00Z', false],
  ['podcast-ep-42-raw.wav', 612_442_118, '2026-11-12T19:30:00Z', false, undefined, 3471],
  ['press-kit.zip', 241_993_002, '2026-11-12T12:00:00Z', false],
  ['Screenshot 2026-11-11 at 09.41.22.png', 1_220_884, '2026-11-11T09:41:22Z', true, [3024, 1964]],
  ['team-offsite-lisbon-group-photo.jpg', 6_734_912, '2026-11-10T18:05:00Z', true, [6000, 4000]],
  ['customer-interviews-synthesis-notes.docx', 233_472, '2026-11-10T11:48:00Z', false],
  ['font-license.txt', 12_877, '2026-11-09T08:00:00Z', false],
  ['app-icon-1024.png', 304_118, '2026-11-08T13:22:00Z', true, [1024, 1024]],
  ['launch-email-header-dark-mode-variant-b-with-updated-tagline-and-cta.png', 892_331, '2026-11-07T16:10:00Z', true, [1200, 600]],
  ['café-menu-photo-déjà-vu.jpg', 4_102_773, '2026-11-06T12:30:00Z', true, [4000, 3000]],
  ['数据报告-2026年第三季度.pdf', 5_998_011, '2026-11-05T03:15:00Z', false],
  ['a.png', 1_024, '2026-11-04T10:00:00Z', true, [16, 16]],
  ['social-banner-linkedin-1584x396.png', 655_210, '2026-11-03T15:00:00Z', true, [1584, 396]],
  ['annual-report-2025-accessible-version-with-alt-text-and-tagged-structure.pdf', 27_441_920, '2026-11-02T09:00:00Z', true],
  ['favicon.ico', 15_086, '2026-11-01T10:10:00Z', false, [48, 48]],
  ['storyboard-frames-01-48.psd', 734_003_200, '2026-10-30T17:00:00Z', false, [3840, 2160]],
  ['motion-test.mov', 4_508_876_800, '2026-10-28T20:45:00Z', false, [3840, 2160], 95],
  ['README', 2_048, '2026-10-27T08:00:00Z', false],
  ['contract-scan-signed.tiff', 52_428_800, '2026-10-25T14:00:00Z', false, [5100, 6600]],
  ['webinar-recording-2026-10-21.webm', 905_969_664, '2026-10-21T18:00:00Z', true, [1280, 720], 3602],
  ['icons.sketch', 19_922_944, '2026-10-20T10:00:00Z', false],
  ['export.csv', 0, '2026-10-19T09:00:00Z', false],
  ['hero-video-poster.webp', 188_416, '2026-10-18T11:00:00Z', true, [1920, 1080]],
  ['packaging-dieline-v3 (1) (1).ai', 31_457_280, '2026-10-15T16:00:00Z', false],
  ['event-photos-day-2-0017.jpg', 8_912_334, '2026-10-12T13:00:00Z', true, [6000, 4000]],
  ['event-photos-day-2-0018.jpg', 9_104_002, '2026-10-12T13:00:00Z', true, [6000, 4000]],
  ['event-photos-day-2-0019.jpg', 8_877_431, '2026-10-12T13:01:00Z', false, [6000, 4000]],
  ['customer-testimonial-cut-03.mp4', 156_237_824, '2026-10-08T10:00:00Z', true, [1080, 1920], 48],
  ['invoice-2024-03.pdf', 141_312, '2026-03-04T09:00:00Z', true],
  ['invoice-2022-11.pdf', 139_264, '2025-11-30T09:00:00Z', true],
  ['old-logo-DO-NOT-USE.png', 98_304, '2025-03-02T10:00:00Z', true, [512, 512]],
];

export const DEFAULT_ASSETS: readonly Asset[] = CURATED.map(([filename, sizeBytes, updatedAt, hasThumb, dims, duration], i) => {
  const id = `a-${String(i + 1).padStart(3, '0')}`;
  return {
    id,
    filename,
    mimeType: mimeFor(filename),
    sizeBytes,
    createdAt: updatedAt,
    updatedAt,
    thumbnailUrl: hasThumb ? thumbnailUrlFor(id) : null,
    dimensions: dims ? { width: dims[0], height: dims[1] } : null,
    durationSeconds: duration ?? null,
  };
});

// Deterministic PRNG (mulberry32).
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREAS = ['brand', 'campaign', 'event', 'social', 'product', 'team', 'customer', 'launch', 'website', 'newsletter', 'print', 'retail', 'partner', 'support', 'recruiting'];
const SUBJECTS = ['hero', 'banner', 'photo', 'deck', 'video', 'logo', 'poster', 'flyer', 'report', 'guide', 'mockup', 'screenshot', 'icon', 'cover', 'brief', 'storyboard', 'interview', 'invite'];
const QUALIFIERS = ['', '', '', 'final', 'draft', 'v2', 'v3', '2x', 'dark', 'light', 'en-US', 'de-DE', 'ja-JP', 'square', 'story', 'wide', 'approved', 'old'];
const KINDS: Array<[ext: string, weight: number, minBytes: number, maxBytes: number, thumbChance: number]> = [
  ['png', 22, 20_000, 12_000_000, 0.92],
  ['jpg', 22, 200_000, 18_000_000, 0.92],
  ['webp', 4, 30_000, 2_000_000, 0.9],
  ['gif', 2, 50_000, 9_000_000, 0.9],
  ['svg', 4, 1_000, 200_000, 0.95],
  ['pdf', 14, 50_000, 60_000_000, 0.6],
  ['mp4', 8, 5_000_000, 2_400_000_000, 0.7],
  ['mov', 3, 20_000_000, 6_000_000_000, 0.5],
  ['docx', 6, 20_000, 4_000_000, 0],
  ['pptx', 5, 500_000, 90_000_000, 0.4],
  ['xlsx', 4, 10_000, 3_000_000, 0],
  ['zip', 2, 1_000_000, 900_000_000, 0],
  ['psd', 2, 20_000_000, 900_000_000, 0],
  ['mp3', 2, 1_000_000, 120_000_000, 0],
];
const TOTAL_WEIGHT = KINDS.reduce((sum, [, w]) => sum + w, 0);

function generateAssets(count: number): Asset[] {
  const rand = random(20261118);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const start = Date.parse('2024-01-01T00:00:00Z');
  const end = Date.parse('2026-10-01T00:00:00Z');
  const assets: Asset[] = [];
  for (let i = 1; i <= count; i++) {
    let roll = rand() * TOTAL_WEIGHT;
    const kind = KINDS.find(([, w]) => (roll -= w) < 0) ?? KINDS[0]!;
    const [ext, , minBytes, maxBytes, thumbChance] = kind;
    const qualifier = pick(QUALIFIERS);
    const filename = [pick(AREAS), pick(SUBJECTS), qualifier, String(i).padStart(4, '0')].filter(Boolean).join('-') + `.${ext}`;
    const id = `g-${String(i).padStart(5, '0')}`;
    const updated = new Date(start + Math.floor(rand() * (end - start))).toISOString().replace('.000', '');
    const visual = ['png', 'jpg', 'webp', 'gif', 'svg', 'psd', 'mp4', 'mov'].includes(ext);
    assets.push({
      id,
      filename,
      mimeType: mimeFor(filename),
      sizeBytes: Math.floor(minBytes + rand() ** 3 * (maxBytes - minBytes)),
      createdAt: updated,
      updatedAt: updated,
      thumbnailUrl: rand() < thumbChance ? thumbnailUrlFor(id) : null,
      dimensions: visual ? pick([{ width: 1920, height: 1080 }, { width: 1080, height: 1080 }, { width: 1080, height: 1920 }, { width: 4000, height: 3000 }]) : null,
      durationSeconds: ['mp4', 'mov', 'mp3'].includes(ext) ? Math.floor(5 + rand() * 3600) : null,
    });
  }
  return assets;
}

let large: readonly Asset[] | undefined;

function byUpdatedDesc(a: Asset, b: Asset): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export function assetsFor(scenario: Scenario): readonly Asset[] {
  if (scenario === 'empty') return [];
  if (scenario === 'default') return DEFAULT_ASSETS;
  large ??= [...DEFAULT_ASSETS, ...generateAssets(LARGE_COUNT - DEFAULT_ASSETS.length)].sort(byUpdatedDesc);
  return large;
}

/** The batch every generator and test uploads to reach partial upload failure. */
export interface UploadFile {
  filename: string;
  sizeBytes: number;
}

export const UPLOAD_BATCH: readonly UploadFile[] = [
  { filename: 'retail-window-display-mockup.png', sizeBytes: 2_411_008 },
  { filename: 'holiday-campaign-brief.pdf', sizeBytes: 1_204_224 },
  { filename: 'store-opening-photos-001.jpg', sizeBytes: 5_242_880 },
  { filename: 'store-opening-photos-002.jpg', sizeBytes: 5_017_600 },
  { filename: 'store-opening-photos-003.jpg', sizeBytes: 4_812_800 },
  { filename: TRANSIENT_FAILURE_FILENAME, sizeBytes: 1_843_200 },
  { filename: 'social-carousel-slide-1.png', sizeBytes: 905_216 },
  { filename: 'social-carousel-slide-2.png', sizeBytes: 887_808 },
  { filename: OVERSIZED_FILENAME, sizeBytes: 117_440_512 },
  { filename: 'product-sheet-de-DE.pdf', sizeBytes: 3_145_728 },
  { filename: 'launch-teaser-15s.mp4', sizeBytes: 24_117_248 },
  { filename: 'press-release-final.docx', sizeBytes: 98_304 },
];

/** A valid replacement for the oversized file. */
export const REPLACEMENT_FILE: UploadFile = { filename: 'Q3-brand-guidelines-final-v2-compressed.pdf', sizeBytes: 8_388_608 };
