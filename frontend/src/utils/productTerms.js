/**
 * Presentation-only wording for backend-provided labels and messages.
 * The build tool is an implementation detail; the product speaks about a
 * Docker image build. Values are never changed in state or sent back to the
 * API — only the rendered text. Raw sanitized logs are left untouched.
 */
const replacements = [
  [/\bRailpack application build\b/gi, "Docker image build"],
  [/\bRailpack builder\b/gi, "Docker builder"],
  [/\binstall(?:ing)? pinned Railpack\b/gi, (match) => (match[0] === "I" ? "Prepare Docker Build" : "prepare Docker build")],
  [/\bRailpack (images?)\b/gi, (_, noun) => `Docker ${noun}`],
  [/\bRailpack build\b/gi, "Docker build"],
  [/\bRailpack (deployment|lifecycle)\b/gi, "$1"],
  [/\bRailpack\b/gi, "Docker build"],
];

export function productText(value) {
  if (typeof value !== "string" || !value) return value;
  let text = value;
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text.replace(/^([a-z])/, (letter) => (value.charAt(0) === value.charAt(0).toUpperCase() ? letter.toUpperCase() : letter));
}
