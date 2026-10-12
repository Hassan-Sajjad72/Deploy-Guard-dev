import { RequirementRecord } from "../projects/deployment-requirement-resolver.service";

export type DependencyKind = "database" | "cache" | "queue" | "object_storage" | "external_service";
export type ApplicationDependency = {
  kind: DependencyKind; name: string; serviceIds: string[]; keys: string[];
  // DeployGuard provisions only explicitly attached databases; everything else must be supplied by the customer.
  provisioning: "deployguard_attachment" | "customer_supplied" | "missing";
  privateNetworkLikely: boolean;
};

// Ordered: the first matching rule classifies a configuration key.
const rules: Array<{ kind: DependencyKind; name: string; pattern: RegExp; privateNetworkLikely: boolean }> = [
  { kind: "database", name: "PostgreSQL", pattern: /^(POSTGRES|PG(HOST|PORT|USER|PASSWORD|DATABASE)$)/, privateNetworkLikely: true },
  { kind: "database", name: "MySQL", pattern: /^(MYSQL|MARIADB)/, privateNetworkLikely: true },
  { kind: "database", name: "MongoDB", pattern: /^MONGO/, privateNetworkLikely: true },
  { kind: "database", name: "SQL database", pattern: /^(DATABASE_URL|DB_(URL|HOST|PORT|USER|PASSWORD|NAME))$/, privateNetworkLikely: true },
  { kind: "cache", name: "Redis", pattern: /^(REDIS|UPSTASH_REDIS|KV_)/, privateNetworkLikely: true },
  { kind: "cache", name: "Memcached", pattern: /^MEMCACHE/, privateNetworkLikely: true },
  { kind: "queue", name: "RabbitMQ", pattern: /^(AMQP|RABBITMQ)/, privateNetworkLikely: true },
  { kind: "queue", name: "Kafka", pattern: /^KAFKA/, privateNetworkLikely: true },
  { kind: "queue", name: "Amazon SQS", pattern: /^SQS_/, privateNetworkLikely: false },
  { kind: "object_storage", name: "Amazon S3", pattern: /^(S3_|AWS_S3_|.*_BUCKET(_NAME)?$)/, privateNetworkLikely: false },
  { kind: "object_storage", name: "Object storage", pattern: /^(MINIO|R2_|GCS_|CLOUDINARY)/, privateNetworkLikely: false },
  { kind: "external_service", name: "Stripe", pattern: /^STRIPE_/, privateNetworkLikely: false },
  { kind: "external_service", name: "Email delivery", pattern: /^(SMTP_|SENDGRID|MAILGUN|POSTMARK|RESEND_|SES_)/, privateNetworkLikely: false },
  { kind: "external_service", name: "Twilio", pattern: /^TWILIO_/, privateNetworkLikely: false },
  { kind: "external_service", name: "Sentry", pattern: /^SENTRY_/, privateNetworkLikely: false },
  { kind: "external_service", name: "AI provider", pattern: /^(OPENAI|ANTHROPIC|GEMINI|GOOGLE_AI)_/, privateNetworkLikely: false },
  { kind: "external_service", name: "OAuth provider", pattern: /^(GITHUB|GOOGLE|AUTH0|CLERK|OKTA)_(CLIENT|SECRET|DOMAIN|ISSUER)/, privateNetworkLikely: false },
];

export function classifyDependencies(requirements: Pick<RequirementRecord, "serviceId" | "key" | "resolvedStatus">[], attachedDatabaseEngine: string | null): ApplicationDependency[] {
  const found = new Map<string, ApplicationDependency>();
  for (const record of requirements) {
    const key = record.key.toUpperCase();
    const rule = rules.find((item) => item.pattern.test(key));
    if (!rule) continue;
    const id = `${rule.kind}:${rule.name}`;
    const entry = found.get(id) || { kind: rule.kind, name: rule.name, serviceIds: [], keys: [], provisioning: "customer_supplied" as const, privateNetworkLikely: rule.privateNetworkLikely };
    if (!entry.serviceIds.includes(record.serviceId)) entry.serviceIds.push(record.serviceId);
    if (!entry.keys.includes(record.key)) entry.keys.push(record.key);
    if (record.resolvedStatus !== "provided") entry.provisioning = "missing";
    found.set(id, entry);
  }
  const engineNames: Record<string, string> = { postgres: "PostgreSQL", mysql: "MySQL", mongodb: "MongoDB" };
  if (attachedDatabaseEngine) {
    const name = engineNames[attachedDatabaseEngine] || attachedDatabaseEngine;
    const match = [...found.values()].find((item) => item.kind === "database" && (item.name === name || item.name === "SQL database"));
    if (match) { match.provisioning = "deployguard_attachment"; match.name = name; }
    else found.set(`database:${name}`, { kind: "database", name, serviceIds: [], keys: [], provisioning: "deployguard_attachment", privateNetworkLikely: true });
  }
  return [...found.values()].map((item) => ({ ...item, serviceIds: item.serviceIds.sort(), keys: item.keys.sort() }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}
