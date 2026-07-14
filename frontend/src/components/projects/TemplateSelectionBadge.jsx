export default function TemplateSelectionBadge({ template }) {
  const label = template || "not selected";
  const className =
    template === "custom-dockerfile-required" ? "state error" : "state success";

  return <span className={className}>{label}</span>;
}
