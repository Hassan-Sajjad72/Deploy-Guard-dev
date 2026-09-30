import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./styles/legacy.css";
import "./styles/system.css";
import "./styles/aurora.css";
import "./styles/aurora-motion.css";
/* Keep route styles in the entry bundle so lazy routes share one cascade. */
import "./styles/pages/about.css";
import "./styles/pages/admin.css";
import "./styles/pages/audit.css";
import "./styles/pages/billing.css";
import "./styles/pages/cloud-cleanup.css";
import "./styles/pages/gate.css";
import "./styles/pages/home.css";
import "./styles/pages/infrastructure.css";
import "./styles/pages/landing.css";
import "./styles/pages/monitoring.css";
import "./styles/pages/new-project.css";
import "./styles/pages/overview.css";
import "./styles/pages/pipeline.css";
import "./styles/pages/projects.css";
import "./styles/pages/settings.css";
import "./styles/pages/troubleshoot.css";
import "./styles/cohesion.css";
import { installActionFeedback } from "./utils/actionFeedback.js";
import { installSurfaceLight } from "./utils/surfaceLight.js";

installActionFeedback();
installSurfaceLight();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
