const express = require("express");
const app = express();
const port = Number(process.env.PORT || 4000);

app.get("/users", (_req, res) => {
  res.json([{ id: 1, name: "DeployGuard" }]);
});

app.listen(port, "0.0.0.0");
