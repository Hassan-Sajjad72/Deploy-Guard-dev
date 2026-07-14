import { Link } from "react-router-dom";

function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "-";
}

export default function ProjectTable({ projects }) {
  return (
    <div className="table-wrap panel">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Repository</th>
            <th>Branch</th>
            <th>Status</th>
            <th>Visibility</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id}>
              <td>{project.name}</td>
              <td>{project.repositoryFullName || "-"}</td>
              <td>{project.targetBranch}</td>
              <td>{project.status}</td>
              <td>{project.visibility}</td>
              <td>{formatDate(project.createdAt)}</td>
              <td>
                <Link className="secondary-button" to={`/projects/${project.id}`}>
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
