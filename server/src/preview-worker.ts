import { parentPort } from "node:worker_threads";
import jpeg from "jpeg-js";

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 3.5 * 1024 * 1024;
export const MAX_PREVIEW_EDGE = 2000;
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;
export const PREVIEW_TIMEOUT_MS = 20_000;

export interface PreviewRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewJob {
  jpeg: Uint8Array;
  region?: PreviewRegion;
  maxBytes: number;
}

export type PreviewWorkerResult =
  | { kind: "image"; jpeg: Uint8Array; width: number; height: number }
  | { kind: "budget" }
  | { kind: "error"; error: string };

function validateJpeg(data: Uint8Array) {
  const invalid = () => { throw new Error("Invalid JPEG frame or missing image scan"); };
  if (data[0] !== 0xff || data[1] !== 0xd8) invalid();
  let offset = 2, inScan = false, hasScan = false, hasEntropy = false;
  while (offset < data.length) {
    if (inScan && data[offset] !== 0xff) {
      hasEntropy = true;
      offset++;
      continue;
    }
    if (data[offset++] !== 0xff) invalid();
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (inScan && marker === 0x00) { hasEntropy = true; continue; }
    if (inScan && marker >= 0xd0 && marker <= 0xd7) continue;
    inScan = false;
    if (marker === 0xd9) {
      if (!hasScan || !hasEntropy) invalid();
      return;
    }
    if (marker === 0x01) continue;
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    const length = data[offset] * 256 + data[offset + 1];
    if (!Number.isFinite(length) || length < 2 || offset + length > data.length) invalid();
    offset += length;
    if (marker === 0xda) { hasScan = true; inScan = true; }
  }
  invalid();
}

function decode(data: Uint8Array) {
  validateJpeg(data);
  const image = jpeg.decode(data, {
    useTArray: true, formatAsRGBA: true, tolerantDecoding: false,
    maxResolutionInMP: 32, maxMemoryUsageInMB: 512,
  });
  if (image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) {
    throw new Error("JPEG must have positive dimensions and decoded pixels");
  }
  return image;
}

export function normalize({ jpeg: encoded, region, maxBytes }: PreviewJob): PreviewWorkerResult {
  const source = decode(encoded);
  const sums = new Float64Array(3);
  if (!region && Math.max(source.width, source.height) <= MAX_PREVIEW_EDGE && encoded.length <= maxBytes) {
    return { kind: "image", jpeg: encoded, width: source.width, height: source.height };
  }
  const left = region ? Math.floor(region.x * source.width) : 0;
  const top = region ? Math.floor(region.y * source.height) : 0;
  const right = region
    ? Math.min(source.width, Math.max(left + 1, Math.ceil((region.x + region.width) * source.width)))
    : source.width;
  const bottom = region
    ? Math.min(source.height, Math.max(top + 1, Math.ceil((region.y + region.height) * source.height)))
    : source.height;
  const cropWidth = right - left, cropHeight = bottom - top;
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(cropWidth, cropHeight));
  let width = Math.max(1, Math.floor(cropWidth * scale));
  let height = Math.max(1, Math.floor(cropHeight * scale));
  for (;;) {
    const data = new Uint8Array(width * height * 4);
    const dx = cropWidth / width, dy = cropHeight / height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const target = (y * width + x) * 4;
        for (let sy = Math.floor(y * dy); sy < Math.ceil((y + 1) * dy); sy++) {
          const wy = Math.min(sy + 1, (y + 1) * dy) - Math.max(sy, y * dy);
          for (let sx = Math.floor(x * dx); sx < Math.ceil((x + 1) * dx); sx++) {
            const wx = Math.min(sx + 1, (x + 1) * dx) - Math.max(sx, x * dx);
            const sourceIndex = ((top + Math.min(cropHeight - 1, sy)) * source.width
              + left + Math.min(cropWidth - 1, sx)) * 4;
            const weight = wx * wy / (dx * dy);
            for (let channel = 0; channel < 3; channel++) {
              sums[channel] += source.data[sourceIndex + channel] * weight;
            }
          }
        }
        for (let channel = 0; channel < 3; channel++) { data[target + channel] = Math.round(sums[channel]); sums[channel] = 0; }
        data[target + 3] = 255;
      }
    }
    for (const quality of [90, 80, 70, 60, 50, 40, 30]) {
      const output = jpeg.encode({ width, height, data }, quality).data;
      if (output.length <= maxBytes) {
        const checked = decode(output);
        return { kind: "image", jpeg: output, width: checked.width, height: checked.height };
      }
    }
    if (width === 1 && height === 1) return { kind: "budget" };
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
}

parentPort?.on("message", (job: PreviewJob) => {
  let result: PreviewWorkerResult;
  try { result = normalize(job); }
  catch (error) { result = { kind: "error", error: `Preview JPEG could not be decoded or encoded: ${error instanceof Error ? error.message : String(error)}` }; }
  parentPort?.postMessage(result);
});
