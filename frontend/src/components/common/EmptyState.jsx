import { EmptyState as SharedEmptyState } from "./DesignSystem.jsx";

export default function EmptyState({ message = "No records found." }) {
  return <SharedEmptyState message={message} />;
}
