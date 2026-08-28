/**
 * The only DeployGuard-owned Railpack configuration.  Railpack interprets the
 * checkout internally; these values only make the executable reproducible.
 */
export const RAILPACK_VERSION = "0.38.0" as const;
export const RAILPACK_LINUX_X64_ARCHIVE = `railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz`;
export const RAILPACK_LINUX_X64_SHA256 = "7c3f0e70ca8bf80bde87e8c30cb0171414c2b6bbd794d6f60a19cc3b71772950" as const;
export const RAILPACK_RELEASE_URL = `https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/${RAILPACK_LINUX_X64_ARCHIVE}`;
export const DEPLOYGUARD_PLATFORM_PORT = 8080 as const;
