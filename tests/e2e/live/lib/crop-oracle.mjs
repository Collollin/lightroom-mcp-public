import assert from "node:assert/strict";
import { parseLuaTable } from "./catalog-db.mjs";

export function parseSavedSettings(text) {
  const source = text.replace(/^\s*s\s*=\s*/, "");
  assert.match(source, /^\s*\{/, "saved Develop settings must contain a Lua table");
  const settings = parseLuaTable(source);
  assert(settings && typeof settings === "object" && !Array.isArray(settings)
    && Object.keys(settings).length > 0, "saved Develop settings must be a nonempty object");
  return settings;
}

export function displayedPixels(source, orientation) {
  assert(orientation >= 1 && orientation <= 8 && Number.isInteger(orientation));
  const width = orientation >= 5 ? source.height : source.width;
  const height = orientation >= 5 ? source.width : source.height;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx, sy;
      switch (orientation) {
        case 1: sx = x; sy = y; break;
        case 2: sx = source.width - 1 - x; sy = y; break;
        case 3: sx = source.width - 1 - x; sy = source.height - 1 - y; break;
        case 4: sx = x; sy = source.height - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = source.height - 1 - x; break;
        case 7: sx = source.width - 1 - y; sy = source.height - 1 - x; break;
        case 8: sx = source.width - 1 - y; sy = x; break;
      }
      const from = (sy * source.width + sx) * 4;
      data.set(source.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

export function compareCrop(source, rendered, bounds) {
  const left = Math.round(bounds.left * source.width);
  const top = Math.round(bounds.top * source.height);
  const width = Math.round((bounds.right - bounds.left) * source.width);
  const height = Math.round((bounds.bottom - bounds.top) * source.height);
  assert(Math.abs(rendered.width - width) <= 1, `rendered width ${rendered.width}, expected ${width}`);
  assert(Math.abs(rendered.height - height) <= 1, `rendered height ${rendered.height}, expected ${height}`);
  let difference = 0, samples = 0;
  for (let y = 3; y < Math.min(height, rendered.height) - 3; y += 7) {
    for (let x = 3; x < Math.min(width, rendered.width) - 3; x += 7) {
      const expected = ((top + y) * source.width + left + x) * 4;
      const actual = (y * rendered.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        difference += Math.abs(source.data[expected + channel] - rendered.data[actual + channel]);
        samples++;
      }
    }
  }
  assert(samples > 0, "crop must contain sampled pixels");
  return { width: rendered.width, height: rendered.height, meanAbsoluteError: difference / samples / 255 };
}

export function withoutCrop(settings) {
  const cropState = new Set(["CropLeft", "CropTop", "CropRight", "CropBottom", "HasCrop"]);
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !cropState.has(key)));
}
