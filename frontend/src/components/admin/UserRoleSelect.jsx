const roles = [["admin", "Admin"], ["developer", "Developer"], ["readonly", "Read-only"]];

export default function UserRoleSelect({ disabled, onChange, value }) {
  return (
    <select
      aria-label="User role"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {roles.map(([role, label]) => (
        <option key={role} value={role}>
          {label}
        </option>
      ))}
    </select>
  );
}
