export default function ValidationChecklist({ validations = [] }) {
  if (validations.length === 0) {
    return null;
  }

  return (
    <section className="panel">
      <h2>Validation Checklist</h2>
      <div className="grid">
        {validations.map((validation) => (
          <div
            className={validation.status === "passed" ? "state success" : "state error"}
            key={validation.code}
          >
            <strong>{validation.code}</strong>
            <div>{validation.message}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
