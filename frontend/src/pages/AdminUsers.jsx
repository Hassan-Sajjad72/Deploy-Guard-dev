import { useEffect, useState } from "react";
import { getUsers, updateUserRole } from "../api/adminApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import UserTable from "../components/admin/UserTable.jsx";

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [updatingUserId, setUpdatingUserId] = useState(null);

  async function loadUsers() {
    setError("");
    setIsLoading(true);

    try {
      const response = await getUsers();
      setUsers(response?.users || []);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function handleRoleChange(userId, role) {
    setError("");
    setSuccess("");
    setUpdatingUserId(userId);

    try {
      const response = await updateUserRole(userId, role);
      const updatedUser = response?.user;

      setUsers((currentUsers) =>
        currentUsers.map((user) =>
          user.id === userId ? { ...user, ...updatedUser } : user
        )
      );
      setSuccess("User role updated.");
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setUpdatingUserId(null);
    }
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Admin Users</h1>
          <p className="muted">Manage user RBAC roles.</p>
        </div>
      </div>

      {error ? <ErrorState message={error} /> : null}
      {success ? <div className="state success">{success}</div> : null}
      {isLoading ? <LoadingState message="Loading users..." /> : null}
      {!isLoading && !error && users.length === 0 ? (
        <EmptyState message="No users found." />
      ) : null}
      {!isLoading && users.length > 0 ? (
        <UserTable
          onRoleChange={handleRoleChange}
          updatingUserId={updatingUserId}
          users={users}
        />
      ) : null}
    </div>
  );
}
