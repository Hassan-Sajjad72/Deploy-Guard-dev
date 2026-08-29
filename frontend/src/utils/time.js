const validDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

export function formatLocalDateTime(value) {
  const date = validDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function formatRelativeTime(value, now = Date.now()) {
  const date = validDate(value);
  if (!date) return "No activity yet";
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const [amount, unit] = abs < 60 ? [seconds, "second"] : abs < 3600 ? [Math.round(seconds / 60), "minute"] : abs < 86400 ? [Math.round(seconds / 3600), "hour"] : abs < 2592000 ? [Math.round(seconds / 86400), "day"] : [Math.round(seconds / 2592000), "month"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(amount, unit);
}

export function formatDuration(durationMs) {
  if (!Number.isFinite(Number(durationMs)) || Number(durationMs) < 0) return "—";
  const seconds = Math.round(Number(durationMs) / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}
