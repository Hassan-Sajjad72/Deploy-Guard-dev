export default function LoadingState({ message = "Loading..." }) {
  return <div className="state muted">{message}</div>;
}
