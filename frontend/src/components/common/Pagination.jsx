export default function Pagination({ pagination, onPageChange, onLimitChange }) {
  const page = pagination?.page || 1;
  const totalPages = pagination?.totalPages || 1;
  const limit = pagination?.limit || 20;

  return (
    <div className="pagination">
      <button
        className="secondary-button"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        type="button"
      >
        Previous
      </button>
      <span className="muted">
        Page {page} of {totalPages}
      </span>
      <button
        className="secondary-button"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        type="button"
      >
        Next
      </button>
      <select
        aria-label="Rows per page"
        onChange={(event) => onLimitChange(Number(event.target.value))}
        value={limit}
      >
        <option value="10">10</option>
        <option value="20">20</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
    </div>
  );
}
