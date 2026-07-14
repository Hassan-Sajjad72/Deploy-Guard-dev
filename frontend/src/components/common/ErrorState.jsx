export default function ErrorState({ message = "Something went wrong." }) {
  return <div className="state error error-state" role="alert"><span aria-hidden="true">!</span><div><strong>This view needs attention</strong><p>{message} Check the guidance above or retry the operation after resolving the reported issue.</p></div></div>;
}
