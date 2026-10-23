export function commandErrorForCurrentSnapshot(failure, currentState) {
  if (!failure || failure.snapshot !== currentState) return "";
  return typeof failure.message === "string" ? failure.message : "";
}
