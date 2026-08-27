const fastify = require("fastify")({ logger: false });
const mysql = require("mysql2/promise");

fastify.get("/health", async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await connection.query("SELECT 1");
  await connection.end();
  return { status: "ok", database: "mysql" };
});

fastify.listen({ port: Number(process.env.PORT || 3000), host: "0.0.0.0" });
