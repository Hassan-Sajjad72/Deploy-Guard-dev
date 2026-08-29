/**
 * The public, platform-owned mount used when a browser build is bound to a
 * repository-local backend before Terraform has allocated any infrastructure.
 * Application paths are deliberately not encoded here: they are preserved.
 */
export const PLATFORM_BACKEND_MOUNT = "/__deployguard/backend" as const;
