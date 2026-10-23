export default function IssueEvidenceList({ evidence = [] }) {
  if (!evidence.length) return null;
  return <ul className="recovery-evidence-list">{evidence.map((item, index) => <li key={`${item.source}-${index}`}><span>{item.source}</span><p>{item.message}</p>{item.timestamp ? <time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleString()}</time> : null}</li>)}</ul>;
}
