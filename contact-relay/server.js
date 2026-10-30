import nodemailer from "nodemailer";
import { loadConfig } from "./config.js";
import { createContactServer } from "./app.js";

const config = loadConfig();
const transport = nodemailer.createTransport(config.smtp);
const server = createContactServer({ config, transport });
server.on("error", (error) => {
  console.error(JSON.stringify({ event: "server_failed", code: error.code }));
  process.exitCode = 1;
});
server.listen(config.port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "listening", port: config.port }));
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => transport.close());
  });
}
