import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createProject } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
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
      return "Enter a project name so this workspace can be identified across releases and audit activity.";
    }

    if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/.test(form.repositoryUrl.trim())) {
      return "Enter a complete GitHub repository URL in the format https://github.com/owner/repository.";
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
      navigate(`/projects/${response.project.id}`, {
        state: { startAutomation: true },
      });
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="grid">
      <PageHeader eyebrow="New project" title="Deploy a repository" description="Choose the repository and branch. DeployGuard will start detection and the enabled automation stages after creation." />
      {error ? <ErrorState message={error} /> : null}
      <ProjectForm
        form={form}
        isSubmitting={isSubmitting}
        onChange={updateField}
        onSubmit={handleSubmit}
        submitLabel="Create Workspace"
      />
    </div>
  );
}
