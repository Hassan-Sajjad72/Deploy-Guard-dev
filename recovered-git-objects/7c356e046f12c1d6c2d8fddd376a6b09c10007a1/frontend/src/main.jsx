import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./styles/legacy.css";
import "./styles/system.css";
import "./styles/aurora.css";
import "./styles/aurora-motion.css";
import { installActionFeedback } from "./utils/actionFeedback.js";
import { installSurfaceLight } from "./utils/surfaceLight.js";

document.documentElement.dataset.theme = "dark";
installActionFeedback();
installSurfaceLight();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
