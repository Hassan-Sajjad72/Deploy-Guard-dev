export default function OrphanedLockWarningBanner({ lock }) {
  if (!lock || lock.status !== "orphaned") {
    return null;
  }

  return (
    <div className="state error">
      Terraform state lock is marked orphaned. Admin review is required before force release.
    </div>
  );
}
