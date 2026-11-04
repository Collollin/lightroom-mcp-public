import { Worker } from "node:worker_threads";
import type { CallOptions, Dispatcher } from "./dispatcher.js";
import {
  MAX_BATCH_BYTES, MAX_PREVIEW_BYTES, MAX_SOURCE_BYTES, PREVIEW_TIMEOUT_MS,
  type PreviewJob, type PreviewRegion, type PreviewWorkerResult,
} from "./preview-worker.js";

export interface PreviewArgs {
  photo_id: string | number;
  size?: number;
  region?: PreviewRegion;
}

export type PreviewRequest =
  | { kind: "single"; args: PreviewArgs }
  | { kind: "batch"; photo_ids: (string | number)[]; size?: number };

type PhotoId = PreviewArgs["photo_id"];
interface Preview {
  photo_id: PhotoId;
  requested_size: number;
  width: number;
  height: number;
  bytes: number;
  image: { mime_type: "image/jpeg"; data: string };
}
class PreviewDeadline extends Error {
  constructor() { super("Preview deadline exceeded (20s)"); }
}

function parseSource(result: unknown) {
  if (typeof result !== "object" || result === null || !("image" in result)
    || typeof result.image !== "object" || result.image === null
    || !("mime_type" in result.image) || result.image.mime_type !== "image/jpeg"
    || !("data" in result.image) || typeof result.image.data !== "string") {
    throw new Error("Lightroom returned no JPEG preview");
  }
  const data = result.image.data;
  if (data.length > 4 * Math.ceil(MAX_SOURCE_BYTES / 3)) throw new Error("Preview source exceeds the 10 MiB byte limit");
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error("Preview source has invalid base64 JPEG data");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("Preview source exceeds the 10 MiB byte limit");
  if (bytes.toString("base64") !== data) throw new Error("Preview source has invalid base64 JPEG data");
  if (!("photo_id" in result) || (typeof result.photo_id !== "string" && typeof result.photo_id !== "number")) {
    throw new Error("Lightroom returned no preview photo ID");
  }
  return { jpeg: bytes, photo_id: result.photo_id };
}

export async function getPreviews(
  dispatcher: Pick<Dispatcher, "call">,
  request: PreviewRequest,
  options?: CallOptions,
) {
  const deadline = performance.now() + PREVIEW_TIMEOUT_MS;
  let worker: Worker | undefined;
  const remaining = () => {
    if (options?.signal?.aborted) throw new Error("Request cancelled");
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw new PreviewDeadline();
    return ms;
  };
  const acquire = (args: PreviewArgs, size: number) => {
    const timeout = remaining();
    return new Promise<Awaited<ReturnType<Dispatcher["call"]>>>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); options?.signal?.removeEventListener("abort", cancel); };
      const cancel = () => { cleanup(); reject(new Error("Request cancelled")); };
      const timer = setTimeout(() => { cleanup(); reject(new PreviewDeadline()); }, timeout);
      options?.signal?.addEventListener("abort", cancel, { once: true });
      dispatcher.call("get_photo_preview", {
        photo_id: args.photo_id, size, _preview_source: true, _preview_timeout_ms: timeout,
      }, timeout, options).then(
        response => { cleanup(); resolve(response); },
        error => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); },
      );
    });
  };
  const transform = async (job: PreviewJob): Promise<PreviewWorkerResult> => {
    const timeout = remaining();
    // Node's source runner uses type stripping; distributions always load emitted JavaScript.
    worker ??= new Worker(new URL(import.meta.url.endsWith(".ts") ? "./preview-worker.ts" : "./preview-worker.js", import.meta.url));
    const active = worker;
    try {
      return await new Promise<PreviewWorkerResult>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          active.off("message", onMessage);
          active.off("error", onError);
          active.off("exit", onExit);
          options?.signal?.removeEventListener("abort", cancel);
        };
        const onMessage = (result: PreviewWorkerResult) => { cleanup(); resolve(result); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onExit = () => onError(new Error("Preview JPEG worker exited before completing"));
        const cancel = () => onError(new Error("Request cancelled"));
        const timer = setTimeout(() => { cleanup(); reject(new PreviewDeadline()); }, timeout);
        active.once("message", onMessage);
        active.once("error", onError);
        active.once("exit", onExit);
        options?.signal?.addEventListener("abort", cancel, { once: true });
        try { active.postMessage(job); } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
      });
    } catch (error) {
      await active.terminate();
      worker = undefined;
      throw error;
    }
  };
  const preview = async (args: PreviewArgs, maxBytes: number): Promise<Preview | undefined> => {
    const size = args.region
      ? Math.min(2048, Math.ceil((args.size ?? 512) / Math.max(args.region.width, args.region.height)))
      : args.size ?? 512;
    const response = await acquire(args, size);
    remaining();
    if (response.error) throw new Error(response.error);
    const source = parseSource(response.result);
    const result = await transform({ jpeg: source.jpeg, region: args.region, maxBytes });
    remaining();
    if (result.kind === "error") throw new Error(result.error);
    if (result.kind === "budget") return undefined;
    return {
      photo_id: source.photo_id, requested_size: Math.floor(size), width: result.width, height: result.height,
      bytes: result.jpeg.length, image: { mime_type: "image/jpeg", data: Buffer.from(result.jpeg).toString("base64") },
    };
  };
  try {
    if (request.kind === "single") {
      const result = await preview(request.args, MAX_PREVIEW_BYTES);
      if (!result) throw new Error("Preview cannot fit within the 3.5 MiB byte limit");
      return result;
    }
    const previews: ((Preview & { requested_id: PhotoId }) | { requested_id: PhotoId; error: string })[] = [];
    let bytes = 0, index = 0;
    for (; index < request.photo_ids.length; index++) {
      const id = request.photo_ids[index];
      if (bytes >= MAX_BATCH_BYTES || performance.now() >= deadline) break;
      try {
        const result = await preview({ photo_id: id, size: request.size ?? 256 }, Math.min(MAX_PREVIEW_BYTES, MAX_BATCH_BYTES - bytes));
        if (!result) break;
        previews.push({ ...result, requested_id: id });
        bytes += result.bytes;
      } catch (error) {
        if (options?.signal?.aborted) throw new Error("Request cancelled");
        if (error instanceof PreviewDeadline || performance.now() >= deadline) break;
        previews.push({ requested_id: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { previews, complete: index === request.photo_ids.length, remaining_ids: request.photo_ids.slice(index), bytes };
  } finally {
    await worker?.terminate();
  }
}
