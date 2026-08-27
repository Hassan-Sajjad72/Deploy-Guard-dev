import express from "express";
import { MongoClient } from "mongodb";

const app = express();

app.get("/health", async (_request, response) => {
  const client = new MongoClient(process.env.MONGODB_URI || "");
  await client.connect();
  await client.db().command({ ping: 1 });
  await client.close();
  response.json({ status: "ok", database: "mongodb" });
});

app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
