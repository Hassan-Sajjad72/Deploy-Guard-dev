import { EmptyState as SharedEmptyState } from "./DesignSystem.jsx";

export default function EmptyState({ action, icon, message = "No records found.", title }) {
  return <SharedEmptyState action={action} icon={icon} message={message} title={title} />;
}
