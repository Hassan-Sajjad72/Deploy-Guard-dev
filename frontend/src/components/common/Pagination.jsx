export default function Pagination({ pagination, onPageChange, onLimitChange }) {
  const page = pagination?.page || 1;
  const totalPages = pagination?.totalPages || 1;
  const limit = pagination?.limit || 20;
  return <nav aria-label="Pagination" className="pagination">
    <span>Page {page} of {totalPages}{pagination?.total != null ? ` · ${pagination.total} records` : ""}</span>
    <div className="actions">
      <select aria-label="Rows per page" className="select" onChange={(event) => onLimitChange(Number(event.target.value))} value={limit}>
        {[10, 20, 50, 100].map((value) => <option key={value} value={value}>{value} per page</option>)}
      </select>
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)} type="button">Previous</button>
      <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} type="button">Next</button>
    </div>
  </nav>;
}
