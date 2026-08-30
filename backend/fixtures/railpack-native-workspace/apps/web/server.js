const http = require("node:http");
const { message } = require("@deployguard-fixture/shared");

const port = Number(process.env.PORT || 8080);
http.createServer((_request, response) => response.end(message)).listen(port, "0.0.0.0");
