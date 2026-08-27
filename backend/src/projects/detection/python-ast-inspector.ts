import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { extname, join, relative } from "path";
import { PythonModuleFacts } from "./framework-detector";

const ROOT_CANDIDATES = new Set(["main.py", "app.py", "server.py", "wsgi.py", "asgi.py", "manage.py"]);
const IGNORED = new Set([".git", ".venv", "venv", "__pycache__", "node_modules", "dist", "build", "tests", "test"]);

/**
 * A bounded, non-executing structural parser for the small Python syntax
 * surface needed by framework entrypoint detection. It never imports modules,
 * evaluates expressions, or invokes repository code.
 */
export class PythonAstInspector {
  inspect(root: string): PythonModuleFacts[] {
    return this.candidates(root).map((file) => this.parse(root, file));
  }

  private candidates(root: string) {
    const files: string[] = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 4 || files.length >= 80) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!IGNORED.has(entry.name) && (depth === 0 || entry.name === "src" || depth < 3)) visit(join(directory, entry.name), depth + 1);
          continue;
        }
        const file = join(directory, entry.name);
        const rel = relative(root, file).replace(/\\/g, "/");
        if (extname(entry.name) === ".py" && statSync(file).size <= 256_000 && (ROOT_CANDIDATES.has(entry.name) || /(?:^|\/)(?:wsgi|asgi)\.py$/.test(rel))) files.push(file);
      }
    };
    visit(root, 0);
    return files.sort();
  }

  private parse(root: string, file: string): PythonModuleFacts {
    const source = existsSync(file) ? readFileSync(file, "utf8") : "";
    const sanitized = this.stripStringsAndComments(source);
    const assignments = [...sanitized.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*(Flask|FastAPI)\s*\(/gm)]
      .map((match) => ({ name: match[1], constructor: match[2] }));
    const functions: PythonModuleFacts["functions"] = [];
    const lines = sanitized.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const declaration = lines[index].match(/^(\s*)def\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:->[^:]*)?:/);
      if (!declaration) continue;
      const indent = declaration[1].length;
      let body = "";
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (line.trim() && (line.match(/^\s*/)?.[0].length || 0) <= indent) break;
        body += `${line}\n`;
      }
      const local = body.match(/^\s+([A-Za-z_]\w*)\s*=\s*(Flask|FastAPI)\s*\(/m);
      const returned = body.match(/^\s+return\s+([A-Za-z_]\w*)\s*$/m);
      const direct = body.match(/^\s+return\s+(Flask|FastAPI)\s*\(/m);
      functions.push({ name: declaration[2], returnsConstructor: direct?.[1] || (local && returned?.[1] === local[1] ? local[2] : null) });
    }
    const rel = relative(root, file).replace(/\\/g, "/");
    return {
      file: rel,
      module: rel.replace(/\.py$/, "").replace(/\/__init__$/, "").replace(/\//g, "."),
      assignments,
      functions,
    };
  }

  private stripStringsAndComments(source: string) {
    return source
      .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, "")
      .replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""')
      .replace(/#.*$/gm, "");
  }
}
