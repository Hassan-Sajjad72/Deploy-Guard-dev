import { useEffect } from "react";
import { Banner, Button } from "./DesignSystem.jsx";
import { productText } from "../../utils/productTerms.js";
import { reportActionOutcome } from "../../utils/actionFeedback.js";

export default function ErrorState({ message = "Something went wrong.", onRetry }) {
  // A failure that surfaces here also shakes the button that triggered it.
  useEffect(() => { reportActionOutcome("danger"); }, [message]);
  return <Banner title="This view needs attention" tone="danger"><p>{productText(message)} Check the guidance above or retry the operation after resolving the reported issue.</p>{onRetry ? <Button onClick={onRetry} tone="secondary">Retry</Button> : null}</Banner>;
}
