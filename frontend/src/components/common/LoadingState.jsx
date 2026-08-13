import { Skeleton } from "./DesignSystem.jsx";

export default function LoadingState({ message = "Loading..." }) {
  return <div aria-live="polite" className="state loading-state"><span className="loading-indicator" aria-hidden="true" /><div className="loading-copy"><strong>Loading</strong><p>{message}</p><Skeleton label={message} lines={3} /></div></div>;
}
