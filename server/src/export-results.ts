import { Ajv } from "ajv";
import { open, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, normalize, basename } from "node:path";
import { imageSize } from "image-size";

type PhotoId = string | number;
type Input = { input_index: number; requested_id: PhotoId };
type Resolved = Input & { photo_id: string };
type Missing = Input & { status: "missing"; reason: "photo_not_found" };
type Skipped = Resolved & { status: "skipped"; reason: "existing_file" | "canceled" };
type FailureCode = "render_failed" | "rendition_missing" | "output_missing" | "output_unreadable"
  | "decode_failed" | "output_superseded" | "output_invalidated";
type Failed = Resolved & {
  status: "failed";
  error: { code: FailureCode; message: string };
  rendered_path?: string;
  superseded_by_input_index?: number;
};
type Dimensions = { status: "decoded"; width: number; height: number }
  | { status: "unavailable"; reason: "original_format_not_decoded" };
export type ExportResult = Missing | Skipped | Failed | (Resolved & {
  status: "completed";
  output: { path: string; bytes: number; dimensions: Dimensions };
});
export interface ExportManifest {
  success: boolean;
  complete: boolean;
  destination: string;
  results: ExportResult[];
  exported: number;
  counts: { completed: number; skipped: number; failed: number; missing: number };
  checksum_policy: "not_computed";
  remaining_ids?: string[];
}

type Rendered = Resolved & { status: "rendered"; path: string };
type RenderFailure = Resolved & {
  status: "failed";
  error: { code: "render_failed" | "rendition_missing"; message: string };
  attempted_path?: string;
};
type Receipt = Missing | Skipped | Rendered | RenderFailure;
interface Receipts { destination: string; results: Receipt[] }
interface ExportRequest {
  photo_ids: readonly PhotoId[];
  format?: "jpeg" | "png" | "tiff" | "original";
  on_existing?: "rename" | "overwrite" | "skip";
}

const text = { type: "string", minLength: 1 };
const inputProperties = { input_index: { type: "integer", minimum: 1 }, requested_id: { type: ["string", "number"] } };
const resolvedProperties = { ...inputProperties, photo_id: text };
const resolvedRequired = ["input_index", "requested_id", "photo_id", "status"];
const validateReceipts = new Ajv({ strict: false }).compile<Receipts>({
  type: "object", required: ["destination", "results"],
  properties: {
    destination: text,
    results: { type: "array", items: { oneOf: [
      { type: "object", additionalProperties: false,
        required: ["input_index", "requested_id", "status", "reason"],
        properties: { ...inputProperties, status: { const: "missing" }, reason: { const: "photo_not_found" } } },
      { type: "object", additionalProperties: false, required: [...resolvedRequired, "reason"],
        properties: { ...resolvedProperties, status: { const: "skipped" }, reason: { enum: ["existing_file", "canceled"] } } },
      { type: "object", additionalProperties: false, required: [...resolvedRequired, "path"],
        properties: { ...resolvedProperties, status: { const: "rendered" }, path: text } },
      { type: "object", additionalProperties: false, required: [...resolvedRequired, "error"],
        properties: { ...resolvedProperties, status: { const: "failed" }, attempted_path: text,
          error: { type: "object", additionalProperties: false, required: ["code", "message"],
            properties: { code: { enum: ["render_failed", "rendition_missing"] }, message: text } } } },
    ] } },
  },
});

function parseReceipts(wire: unknown, requested: readonly PhotoId[]): Receipts {
  if (!validateReceipts(wire)) {
    throw new Error("Export manifest unavailable: invalid or legacy count-only plugin response. Install the matching Lightroom plugin and reload it.");
  }
  if (!isAbsolute(wire.destination) || wire.results.length !== requested.length
    || wire.results.some((item, index) => item.input_index !== index + 1 || item.requested_id !== requested[index]
      || (item.status === "rendered" && !isAbsolute(item.path))
      || (item.status === "failed" && item.attempted_path !== undefined && !isAbsolute(item.attempted_path)))) {
    throw new Error("Export manifest does not match the requested photo occurrences or absolute output paths");
  }
  return wire;
}

async function outputKeys(path: string): Promise<string[]> {
  const keys = [normalize(path)];
  try { keys.push(await realpath(path)); } catch {
    // A failed overwrite can remove the file; resolve its parent aliases too.
    try { keys.push(join(await realpath(dirname(path)), basename(path))); } catch {}
  }
  try {
    const file = await stat(path);
    if (file.ino !== 0) keys.push(`inode:${file.dev}:${file.ino}`);
  } catch {}
  return keys;
}

function unchanged(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function failed(item: Resolved, code: FailureCode, message: string): Failed {
  return { input_index: item.input_index, requested_id: item.requested_id, photo_id: item.photo_id,
    status: "failed", error: { code, message } };
}

// Header dimensions do not prove pixel integrity. Memory is bounded per primary rendition.
async function verifyOutput(item: Rendered, format: NonNullable<ExportRequest["format"]>): Promise<ExportResult> {
  try {
    const file = await open(item.path, "r");
    let byteCount: number;
    let dimensions: Dimensions;
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size === 0 || !Number.isSafeInteger(before.size)) {
        throw new Error("Output must be a nonempty regular file with a safe byte size");
      }
      if (format === "original") {
        byteCount = before.size;
        dimensions = { status: "unavailable", reason: "original_format_not_decoded" };
      } else {
        if (before.size > 512 * 1024 * 1024) throw new Error("Raster output exceeds the 512 MiB verification limit");
        const bytes = Buffer.alloc(before.size);
        byteCount = 0;
        while (byteCount < bytes.length) {
          const read = await file.read(bytes, byteCount, bytes.length - byteCount, null);
          if (read.bytesRead === 0) break;
          byteCount += read.bytesRead;
        }
        try {
          const decoded = imageSize(bytes);
          const expected = { jpeg: "jpg", png: "png", tiff: "tiff" }[format];
          if ((decoded.type !== expected && !(format === "tiff" && decoded.type === "bigtiff")) || !Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height)
            || decoded.width <= 0 || decoded.height <= 0) throw new Error(`Expected ${format} dimension headers`);
          dimensions = { status: "decoded", width: decoded.width, height: decoded.height };
        } catch (error) {
          return { ...failed(item, "decode_failed", error instanceof Error ? error.message : String(error)), rendered_path: item.path };
        }
      }
      const after = await file.stat();
      const atPath = await stat(item.path);
      if (!unchanged(before, after) || !unchanged(after, atPath) || byteCount !== after.size) {
        throw new Error("Output changed or was replaced during verification");
      }
    } finally { await file.close(); }
    return { input_index: item.input_index, requested_id: item.requested_id, photo_id: item.photo_id,
      status: "completed", output: { path: item.path, bytes: byteCount, dimensions } };
  } catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return { ...failed(item, missing ? "output_missing" : "output_unreadable",
      error instanceof Error ? error.message : String(error)), rendered_path: item.path };
  }
}

export async function verifyExportResult(wire: unknown, request: ExportRequest): Promise<ExportManifest> {
  const receipts = parseReceipts(wire, request.photo_ids);
  const writers = new Map<string, Rendered | RenderFailure>();
  const superseded = new Map<number, Rendered | RenderFailure>();
  for (const item of [...receipts.results].reverse()) {
    const path = item.status === "rendered" ? item.path
      : item.status === "failed" && request.on_existing === "overwrite" ? item.attempted_path : undefined;
    if (path === undefined || (item.status !== "rendered" && item.status !== "failed")) continue;
    const keys = await outputKeys(path);
    const successors = keys.flatMap((key) => { const writer = writers.get(key); return writer ? [writer] : []; });
    const successor = successors.sort((a, b) => b.input_index - a.input_index)[0];
    if (successor) superseded.set(item.input_index, successor);
    for (const key of keys) if (!writers.has(key)) writers.set(key, item);
  }
  const results: ExportResult[] = [];
  for (const item of receipts.results) {
    if (item.status !== "rendered") {
      if (item.status === "failed") results.push(failed(item, item.error.code, item.error.message));
      else results.push(item);
      continue;
    }
    const successor = superseded.get(item.input_index);
    if (successor) {
      results.push({ ...failed(item, successor.status === "rendered" ? "output_superseded" : "output_invalidated",
        `Later input ${successor.input_index} ${successor.status === "rendered" ? "replaced" : "may have modified"} this output`),
      rendered_path: item.path, superseded_by_input_index: successor.input_index });
    } else results.push(await verifyOutput(item, request.format ?? "jpeg"));
  }
  const counts = { completed: 0, skipped: 0, failed: 0, missing: 0 };
  const remaining: string[] = [];
  for (const result of results) {
    counts[result.status]++;
    if (result.status === "skipped" && result.reason === "canceled") remaining.push(result.photo_id);
  }
  const complete = remaining.length === 0;
  return { success: complete && counts.failed === 0 && counts.missing === 0, complete,
    destination: receipts.destination, results, exported: counts.completed, counts, checksum_policy: "not_computed",
    ...(remaining.length > 0 ? { remaining_ids: remaining } : {}) };
}
