export default function DetectionWarnings({ errors = [], warnings = [] }) {
  if (warnings.length === 0 && errors.length === 0) {
    return null;
  }

  return (
    <div className="grid">
      {warnings.length > 0 ? (
        <section className="state">
          <strong>Warnings</strong>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {errors.length > 0 ? (
        <section className="state error">
          <strong>Errors</strong>
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
