export default function TemplateSummaryCard({ template }) {
  if (!template) {
    return null;
  }

  return (
    <section className="panel">
      <h2>Selected Template</h2>
      <dl className="details-list">
        <dt>Template</dt>
        <dd>{template.templateKey}</dd>
        <dt>Name</dt>
        <dd>{template.displayName}</dd>
        <dt>Base Image</dt>
        <dd>{template.baseImage}</dd>
        <dt>Runtime Image</dt>
        <dd>{template.runtimeImage}</dd>
        <dt>Multi-stage</dt>
        <dd>{template.usesMultiStageBuild ? "yes" : "no"}</dd>
        <dt>Security Level</dt>
        <dd>{template.securityLevel}</dd>
      </dl>
    </section>
  );
}
