const express = require("express");

if (!process.env.API_KEY) {
  throw new Error("API_KEY is required");
}

const app = express();
const port = Number(process.env.PORT || 5000);

app.get("/", (_req, res) => {
  res.status(401).json({ error: "unauthorized" });
});

app.get("/protected", (req, res) => {
  if (req.headers["x-api-key"] !== process.env.API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.json({ ok: true });
});

app.listen(port, "0.0.0.0");
