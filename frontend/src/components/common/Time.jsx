import { formatDateTime, formatRelativeTime } from "../../utils/time.js";

/** Relative time in the text, exact local time on hover and for assistive tech. */
export default function Time({ value, relative = true, className }) {
  if (!value) return <span className={className}>—</span>;
  const exact = formatDateTime(value);
  return <time className={className} dateTime={value} title={exact}>{relative ? formatRelativeTime(value) : exact}</time>;
}
