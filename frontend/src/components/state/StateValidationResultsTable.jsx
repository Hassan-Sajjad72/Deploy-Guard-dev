export default function StateValidationResultsTable({ results = [] }) {
  return (
    <section className="panel">
      <h2>Validation Results</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>JSON</th>
              <th>Checksum</th>
              <th>Resources</th>
              <th>Graph</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr key={result.id}>
                <td>{result.status}</td>
                <td>{result.jsonSchemaValid ? "valid" : "invalid"}</td>
                <td>{result.checksumValid ? "valid" : "invalid"}</td>
                <td>{result.resourceCountValid ? "valid" : "invalid"}</td>
                <td>{result.dependencyGraphValid ? "valid" : "invalid"}</td>
              </tr>
            ))}
            {results.length === 0 ? (
              <tr>
                <td colSpan="5">No validation results yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
