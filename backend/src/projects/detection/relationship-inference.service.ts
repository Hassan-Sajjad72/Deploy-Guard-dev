import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, normalize } from "path";
import type { RepositoryEvidence } from "./repository-evidence.types";

const IGNORED = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "vendor", ".venv", "venv", "__pycache__"]);

export type StaticServingInference = {
  status: "proven" | "absent" | "unresolved";
  path: string | null;
  evidence: RepositoryEvidence[];
};

/** Performs bounded static expression resolution without executing repository code. */
export class RelationshipInferenceService {
  inferStaticServing(root: string, relativeRoot: string): StaticServingInference {
    const files = this.sources(root);
    const constants = new Map<string, string>();
    for (const item of files) {
      for (const match of item.text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
        const resolved = this.resolvePathExpression(match[2], constants);
        if (resolved) constants.set(match[1], resolved);
      }
    }
    const evidence: RepositoryEvidence[] = [];
    const directoryPaths: string[] = [];
    const filePaths: string[] = [];
    let dynamic = false;
    const pathExpression = String.raw`(path\.(?:join|resolve)\s*\((?:process\.cwd\(\)|[^()])*\)|[A-Za-z_$][\w$]*|[\x60'\"][^\x60'\"]+[\x60'\"])`;
    const patterns = [
      { kind: "directory" as const, pattern: new RegExp(String.raw`express\.static\s*\(\s*${pathExpression}\s*\)`, "g") },
      { kind: "file" as const, pattern: new RegExp(String.raw`(?:res\.)?sendFile\s*\(\s*${pathExpression}`, "g") },
      { kind: "directory" as const, pattern: new RegExp(String.raw`rootPath\s*:\s*${pathExpression}`, "g") },
      { kind: "directory" as const, pattern: new RegExp(String.raw`@fastify\/static[\s\S]{0,300}?root\s*:\s*${pathExpression}`, "g") },
      { kind: "directory" as const, pattern: /static_folder\s*=\s*([^,)\n]+)/g },
      { kind: "directory" as const, pattern: /send_from_directory\s*\(([^,\n]+)/g },
      { kind: "directory" as const, pattern: /StaticFiles\s*\([^)]*directory\s*=\s*([^,)\n]+)/g },
    ];
    for (const item of files) {
      for (const candidate of patterns) {
        candidate.pattern.lastIndex = 0;
        for (const match of item.text.matchAll(candidate.pattern)) {
          const resolved = this.resolvePathExpression(match[1], constants);
          if (resolved) {
            evidence.push({ kind: "serves-static", file: item.file, root: relativeRoot, value: resolved, confidence: "direct" });
            (candidate.kind === "directory" ? directoryPaths : filePaths).push(resolved);
          }
          else dynamic = true;
        }
      }
    }
    const servedDirectories = [...new Set(directoryPaths)];
    const sentFiles = [...new Set(filePaths)];
    if (dynamic) return { status: "unresolved", path: null, evidence };
    if (servedDirectories.length === 1 && sentFiles.every((file) => file === servedDirectories[0] || file.startsWith(`${servedDirectories[0]}/`))) {
      return { status: "proven", path: servedDirectories[0], evidence };
    }
    if (servedDirectories.length === 0 && sentFiles.length > 0) {
      const fileParents = [...new Set(sentFiles.map((file) => dirname(file).replace(/\\/g, "/")))];
      if (fileParents.length === 1 && fileParents[0] !== ".") return { status: "proven", path: fileParents[0], evidence };
    }
    if (servedDirectories.length > 1 || sentFiles.length > 0) return { status: "unresolved", path: null, evidence };
    return { status: "absent", path: null, evidence: [] };
  }

  resolvePathExpression(expression: string, constants = new Map<string, string>()) {
    const trimmed = expression.trim().replace(/\s*\/\/[\s\S]*$/, "");
    const literal = trimmed.match(/^[`'"](.+?)[`'"]$/)?.[1];
    if (literal && !/\$\{|\+/.test(literal)) return this.clean(literal);
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return constants.get(trimmed) || null;
    const call = trimmed.match(/^path\.(?:join|resolve)\s*\((.*)\)$/s);
    if (!call) return null;
    const args = this.arguments(call[1]);
    if (!args.length) return null;
    const parts: string[] = [];
    for (const argument of args) {
      if (argument === "__dirname" || argument === "process.cwd()") continue;
      const value = argument.match(/^[`'"]([^`'"]+)[`'"]$/)?.[1]
        || (/^[A-Za-z_$][\w$]*$/.test(argument) ? constants.get(argument) : null);
      if (!value) return null;
      parts.push(value);
    }
    return parts.length ? this.clean(parts.join("/")) : null;
  }

  private arguments(value: string) {
    const result: string[] = [];
    let quote = "";
    let depth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (quote) {
        if (character === quote && value[index - 1] !== "\\") quote = "";
        continue;
      }
      if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 0) { result.push(value.slice(start, index).trim()); start = index + 1; }
      if (depth < 0) return [];
    }
    if (quote || depth !== 0) return [];
    result.push(value.slice(start).trim());
    return result.filter(Boolean);
  }

  private clean(value: string) {
    const cleaned = normalize(value.replace(/^\.\//, "")).replace(/\\/g, "/").replace(/^\.\.\//, "");
    return cleaned && cleaned !== "." && !cleaned.startsWith("/") && !cleaned.includes("..") ? cleaned : null;
  }

  private sources(root: string) {
    const result: Array<{ file: string; text: string }> = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 6 || result.length >= 500) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (!IGNORED.has(entry.name)) visit(path, depth + 1); continue; }
        if (!/\.(?:js|jsx|mjs|cjs|ts|tsx|py)$/i.test(entry.name) || statSync(path).size > 512_000) continue;
        result.push({ file: path.slice(root.length + 1).replace(/\\/g, "/"), text: existsSync(path) ? readFileSync(path, "utf8") : "" });
      }
    };
    visit(root, 0);
    return result;
  }
}
