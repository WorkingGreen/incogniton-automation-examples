/**
 * Minimal PNG decoder for screenshot-based observation (8-bit RGB/RGBA,
 * non-interlaced, which is what Chromium screenshots produce). Avoids an
 * image-processing dependency for the canvas example.
 */
import { inflateSync } from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA bytes, row-major */
  data: Uint8Array;
}

export function decodePng(buffer: Buffer): RgbaImage {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) throw new Error('Not a PNG file');
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8]!;
      colorType = chunk[9]!;
      interlace = chunk[12]!;
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`Unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[dst + x - channels]! : 0;
      const b = y > 0 ? pixels[dst - stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[dst - stride + x - channels]! : 0;
      let value = raw[src + x]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[dst + x] = value & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i]!;
    rgba[j + 1] = pixels[i + 1]!;
    rgba[j + 2] = pixels[i + 2]!;
    rgba[j + 3] = 255;
  }
  return { width, height, data: rgba };
}

/** Parses '#rrggbb'. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Counts pixels close to `color`, grouped by grid cell. Returns the cells whose
 * match count reaches `minPixels`, so anti-aliased edges and text are ignored.
 */
export function findColorCells(
  image: RgbaImage,
  color: [number, number, number],
  grid: { cols: number; rows: number },
  options: { tolerance?: number; minPixels?: number } = {},
): Array<{ x: number; y: number; pixels: number }> {
  const tolerance = options.tolerance ?? 24;
  const cellW = image.width / grid.cols;
  const cellH = image.height / grid.rows;
  const minPixels = options.minPixels ?? Math.max(4, Math.floor(cellW * cellH * 0.15));
  const counts = new Map<number, number>();
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (
        Math.abs(image.data[i]! - color[0]) <= tolerance &&
        Math.abs(image.data[i + 1]! - color[1]) <= tolerance &&
        Math.abs(image.data[i + 2]! - color[2]) <= tolerance
      ) {
        const key = Math.floor(y / cellH) * grid.cols + Math.floor(x / cellW);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, pixels]) => pixels >= minPixels)
    .map(([key, pixels]) => ({ x: key % grid.cols, y: Math.floor(key / grid.cols), pixels }));
}
