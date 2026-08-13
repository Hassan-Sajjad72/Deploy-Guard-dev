import { Banner, Button } from "./DesignSystem.jsx";

export default function ErrorState({ message = "Something went wrong.", onRetry }) {
  return <Banner title="This view needs attention" tone="danger"><p>{message} Check the guidance above or retry the operation after resolving the reported issue.</p>{onRetry ? <Button onClick={onRetry} tone="secondary">Retry</Button> : null}</Banner>;
}
