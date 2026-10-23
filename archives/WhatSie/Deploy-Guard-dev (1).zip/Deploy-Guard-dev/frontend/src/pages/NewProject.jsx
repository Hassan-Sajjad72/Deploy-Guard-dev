import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createProject } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import ProjectForm from "../components/projects/ProjectForm.jsx";

const initialForm = {
  name: "",
  description: "",
  repositoryUrl: "",
  targetBranch: "main",
  visibility: "private",
};

export default function NewProject() {
  const navigate = useNavigate();
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function updateField(event) {
    setForm((current) => ({
      ...current,
      [event.target.name]: event.target.value,
    }));
  }

  function validate() {
    if (!form.name.trim()) {
      return "Name is required.";
    }

    if (!form.repositoryUrl.startsWith("https://github.com/")) {
      return "Repository URL must start with https://github.com/.";
    }

    return "";
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const validationError = validate();

    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");
    setIsSubmitting(true);

    try {
      const response = await createProject(form);
      navigate(`/projects/${response.project.id}`);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Create Project</h1>
          <p className="muted">Link a GitHub repository to a deployment workspace.</p>
        </div>
      </div>
      {error ? <ErrorState message={error} /> : null}
      <ProjectForm
        form={form}
        isSubmitting={isSubmitting}
        onChange={updateField}
        onSubmit={handleSubmit}
        submitLabel="Create Project"
      />
    </div>
  );
}
