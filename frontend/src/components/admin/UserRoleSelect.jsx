const roles = ["admin", "developer", "readonly"];

export default function UserRoleSelect({ disabled, onChange, value }) {
  return (
    <select
      aria-label="User role"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {roles.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
    </select>
  );
}
