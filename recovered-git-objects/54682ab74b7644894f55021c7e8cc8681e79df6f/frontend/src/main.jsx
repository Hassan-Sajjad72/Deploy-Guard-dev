import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./styles/legacy.css";
import "./styles/system.css";
import "./styles/shell.css";
import "./styles/mist-frost.css";
import "./styles/motion.css";
import { installActionFeedback } from "./utils/actionFeedback.js";

document.documentElement.dataset.theme = "dark";
installActionFeedback();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
