import { useEffect } from "react";
import { Button, Callout } from "./DesignSystem.jsx";
import { productText } from "../../utils/productTerms.js";
import { reportActionOutcome } from "../../utils/actionFeedback.js";

/** An inline failure: what failed, the API's reason, and a retry when one makes sense. */
export default function ErrorState({ message = "The request did not complete.", onRetry, title = "Something went wrong" }) {
  // A failure that surfaces here also shakes the button that triggered it.
  useEffect(() => { reportActionOutcome("danger"); }, [message]);
  return <Callout actions={onRetry ? <Button onClick={onRetry} size="sm">Try again</Button> : null} title={title} tone="danger"><p>{productText(message)}</p></Callout>;
}
