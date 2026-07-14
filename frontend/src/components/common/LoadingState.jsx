export default function LoadingState({ message = "Loading..." }) {
  return <div aria-live="polite" className="state loading-state"><span className="loading-indicator" aria-hidden="true" /><div className="loading-copy"><strong>Loading</strong><p>{message}</p><div aria-hidden="true" className="skeleton-lines"><span /><span /><span /></div></div></div>;
}
