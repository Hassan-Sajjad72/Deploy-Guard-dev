import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [result, setResult] = useState("loading");

  useEffect(() => {
    const base = import.meta.env.VITE_API_BASE_URL || "/__deployguard/backend";
    fetch(`${base}/api/ping`)
      .then((response) => response.json())
      .then((data) => setResult(data.message))
      .catch(() => setResult("error"));
  }, []);

  return <div>{result}</div>;
}

createRoot(document.getElementById("root")).render(<App />);
