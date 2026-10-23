export default function EmptyState({ message = "No records found." }) {
  return <div className="state muted">{message}</div>;
}
