import "./styles/system.css";
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
import "./styles/motion.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { installActionFeedback } from "./utils/actionFeedback.js";

installActionFeedback();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
