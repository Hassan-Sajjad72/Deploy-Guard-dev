import { posix } from "path";

const SAFE_OUTPUT = /^[A-Za-z0-9._/-]+$/;

function normalizeOutput(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || !SAFE_OUTPUT.test(normalized) || normalized.split("/").includes("..")) return null;
  return posix.normalize(normalized);
}

/** Extracts a static Webpack output path without importing or executing repository code. */
export function deriveWebpackOutputDirectory(source: string) {
  const output = source.match(/\boutput\s*:\s*\{([\s\S]{0,3000}?)\}/)?.[1] || "";
  if (!output) return null;

  const concatenated = output.match(/\bpath\s*:\s*__dirname\s*\+\s*["']([^"']+)["']/)?.[1];
  if (concatenated) return normalizeOutput(concatenated);

  const callArguments = output.match(/\bpath\s*:\s*path\.(?:join|resolve)\s*\(\s*__dirname\s*,([\s\S]{0,500}?)\)/)?.[1];
  if (callArguments) {
    const parts = [...callArguments.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    if (parts.length) return normalizeOutput(parts.join("/"));
  }

  const literal = output.match(/\bpath\s*:\s*["']([^"']+)["']/)?.[1];
  if (literal && !literal.startsWith("/") && !/^[A-Za-z]:/.test(literal)) return normalizeOutput(literal);
  return null;
}
