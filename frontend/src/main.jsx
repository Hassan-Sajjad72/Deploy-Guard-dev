import React from "react";
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")).render(<main><h1>Vite React Fixture</h1><p>{import.meta.env.VITE_API_URL}</p></main>);
