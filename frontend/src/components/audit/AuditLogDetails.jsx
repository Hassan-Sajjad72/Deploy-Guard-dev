const SENSITIVE_KEYS = [
  "password",
  "token",
  "secret",
  "apiKey",
  "credential",
  "env",
  "authorization",
  "cookie",
];

function maskMetadata(value) {
  if (Array.isArray(value)) {
    return value.map(maskMetadata);
  }

  if (value && typeof value === "object") {
    return Object.entries(value).reduce((masked, [key, nestedValue]) => {
      const normalizedKey = key.toLowerCase();
      const isSensitive = SENSITIVE_KEYS.some((sensitiveKey) =>
        normalizedKey.includes(sensitiveKey.toLowerCase())
      );

      masked[key] = isSensitive ? "[REDACTED]" : maskMetadata(nestedValue);
      return masked;
    }, {});
  }

  return value;
}

export default function AuditLogDetails({ metadata }) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return <span className="muted">No metadata</span>;
  }

  return (
    <pre className="metadata admin-audit-evidence" tabIndex="0" title="Sanitized technical audit evidence">
      {JSON.stringify(maskMetadata(metadata), null, 2)}
    </pre>
  );
}
