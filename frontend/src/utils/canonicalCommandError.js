export function commandErrorForCanonicalFetch(failure, canonicalFetchVersion) {
  if (!failure || failure.canonicalFetchVersion !== canonicalFetchVersion) return "";
  return typeof failure.message === "string" ? failure.message : "";
}
