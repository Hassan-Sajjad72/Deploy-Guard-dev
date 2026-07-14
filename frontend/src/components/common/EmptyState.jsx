export default function EmptyState({ message = "No records found." }) {
  return <div className="state empty-state"><span className="empty-state-mark" aria-hidden="true">—</span><div><strong>Nothing to show yet</strong><p>{message}</p></div></div>;
}
