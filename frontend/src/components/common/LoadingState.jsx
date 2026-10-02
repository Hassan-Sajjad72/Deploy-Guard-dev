import { Skeleton } from "./DesignSystem.jsx";

/** Page-shaped placeholder; the label is announced, the shimmer is decorative. */
export default function LoadingState({ message = "Loading…", inline = false }) {
  const skeleton = <Skeleton label={message} lines={4} />;
  return inline ? skeleton : <div className="page">{skeleton}</div>;
}
