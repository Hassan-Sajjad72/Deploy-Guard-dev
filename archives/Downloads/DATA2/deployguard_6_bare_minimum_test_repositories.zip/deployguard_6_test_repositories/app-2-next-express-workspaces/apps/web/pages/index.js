import { useEffect, useState } from "react";

export default function Home() {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_API_BASE_URL || "/__deployguard/backend";
    fetch(`${base}/users`)
      .then((response) => response.json())
      .then(setUsers);
  }, []);

  return <pre>{JSON.stringify(users)}</pre>;
}
