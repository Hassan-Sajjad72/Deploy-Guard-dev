export default function ErrorState({ message = "Something went wrong." }) {
  return <div className="state error">{message}</div>;
}
