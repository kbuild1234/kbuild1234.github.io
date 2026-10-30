import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import nodemailer from "nodemailer";
import { createContactServer } from "../app.js";
import { loadConfig, topics } from "../config.js";

const env = {
  SMTP_HOST: "smtp.example.com", SMTP_USER: "test-user", SMTP_PASS: "test-password",
  CONTACT_FROM: "website@cocohealth.co.uk", CONTACT_TO: "health@cocohealth.co.uk"
};
const valid = {
  name: "Example Sender", email: "sender@example.com", company: "Example Ltd",
  topic: "general", message: "Please quote for a workplace clinic.", privacyAcknowledged: true
};

async function fixture(t, options = {}) {
  const sent = [];
  const logs = [];
  const config = loadConfig(env);
  const server = createContactServer({
    config,
    transport: { sendMail: async (mail) => {
      sent.push(mail);
      return { accepted: [config.to], rejected: [] };
    } },
    log: (line) => logs.push(JSON.parse(line)),
    ...options
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body = valid, headers = {}, path = "/v1/messages") => fetch(url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  return { sent, logs, config, server, url, post };
}

test("configuration requires secrets, single recipients and verified encrypted SMTP", () => {
  const config = loadConfig(env);
  assert.equal(config.smtp.secure, false);
  assert.equal(config.smtp.requireTLS, true);
  assert.equal(config.smtp.tls.rejectUnauthorized, true);
  assert.equal(config.smtp.tls.minVersion, "TLSv1.2");
  assert.equal(config.smtp.debug, false);
  assert.equal(config.smtp.disableFileAccess, true);
  assert.equal(config.smtp.disableUrlAccess, true);
  const implicit = loadConfig({ ...env, SMTP_PORT: "465", SMTP_SECURE: "true" });
  assert.equal(implicit.smtp.secure, true);
  for (const settings of [
    { SMTP_PASS: "" }, { CONTACT_TO: "a@example.com,b@example.com" },
    { CONTACT_FROM: "Name <a@example.com>" }, { PORT: "0" },
    { SMTP_PORT: "465" }, { SMTP_SECURE: "yes" }, { SMTP_PORT: "587oops" }
  ]) {
    assert.throws(() => loadConfig({ ...env, ...settings }));
  }
});

test("JSON agent request returns SMTP acceptance, never becomes an arbitrary relay", async (t) => {
  const f = await fixture(t);
  const response = await f.post();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ["ok", "code", "message", "requestId"].sort());
  assert.equal(result.ok, true);
  assert.equal(result.code, "smtp_accepted");
  assert.match(result.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].envelope, { from: env.CONTACT_FROM, to: [env.CONTACT_TO] });
  assert.equal(f.sent[0].to, env.CONTACT_TO);
  assert.equal(f.sent[0].from.address, env.CONTACT_FROM);
  assert.equal(f.sent[0].replyTo.address, valid.email);
  assert.equal(f.sent[0].subject, "Website enquiry: General enquiry");
  assert.equal(f.sent[0].html, undefined);
  assert.match(f.sent[0].text, /Sender identity.*unverified/);
  assert.deepEqual(f.logs, [{ event: "smtp_accepted", requestId: result.requestId }]);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("native HTML form works without JavaScript and does not echo user input", async (t) => {
  const f = await fixture(t);
  const response = await f.post(new URLSearchParams({
    ...valid, name: "<script>alert(1)</script>", privacyAcknowledged: "true", website: ""
  }).toString(), {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "text/html",
    Origin: "https://www.cocohealth.co.uk"
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  assert.match(html, /Thank you/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /https:\/\/www.cocohealth.co.uk\/contact.html/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("CORS allows site origins and exposes retry timing; rejects other origins", async (t) => {
  const f = await fixture(t);
  for (const origin of f.config.allowedOrigins) {
    const response = await fetch(f.url + "/v1/messages", { method: "OPTIONS", headers: { Origin: origin } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type");
    assert.equal(response.headers.get("access-control-expose-headers"), "Retry-After");
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
  }
  for (const origin of ["https://evil.example", "null", "https://www.cocohealth.co.uk.evil.example"]) {
    const response = await f.post(valid, { Origin: origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(f.sent.length, 0);
});

test("rejects malformed, oversized, injected, sensitive-capability and unacknowledged input", async (t) => {
  const f = await fixture(t);
  let ip = 1;
  for (const body of [
    null, [], {}, { ...valid, to: "other@example.com" }, { ...valid, attachments: [] },
    { ...valid, name: "Sender\r\nBcc: other@example.com" },
    { ...valid, email: "a@example.com,b@example.com" },
    { ...valid, email: "Sender <a@example.com>" }, { ...valid, email: "a@example.com\n" },
    { ...valid, company: "bad\tcompany" }, { ...valid, company: null }, { ...valid, topic: "__proto__" },
    { ...valid, topic: "bad" }, { ...valid, message: "   " },
    { ...valid, message: "\u0000" }, { ...valid, privacyAcknowledged: false },
    { ...valid, privacyAcknowledged: "true" }, { ...valid, website: "spam" },
    { ...valid, name: "n".repeat(101) }, { ...valid, company: "c".repeat(151) },
    { ...valid, message: "m".repeat(4001) }, { ...valid, email: 123 },
    { ...valid, name: ["Sender"] }, "{bad JSON"
  ]) {
    const response = await f.post(body, { "X-Forwarded-For": `192.0.2.${ip++}` });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).ok, false);
  }
  const duplicate = await f.post("name=one&name=two", {
    "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": `192.0.2.${ip++}`
  });
  assert.equal(duplicate.status, 400);
  assert.equal(f.sent.length, 0);
});

test("all documented topics and maximum field lengths are accepted", async (t) => {
  const f = await fixture(t);
  for (const topic of Object.keys(topics)) {
    const response = await f.post({
      ...valid, topic, name: "n".repeat(100), company: "c".repeat(150), message: "m".repeat(4000)
    });
    assert.equal(response.status, 200);
  }
  assert.equal(f.sent.length, Object.keys(topics).length);
});

test("rejects unexpected content types and compressed bodies", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(valid, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await f.post(valid, { "Content-Encoding": "gzip" })).status, 415);
  assert.equal(f.sent.length, 0);
});

test("accepts exactly 16 KiB and rejects larger content-length and streamed bodies", async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify(valid);
  assert.equal((await f.post(body.padEnd(16384, " "))).status, 200);
  assert.equal((await f.post("x".repeat(16385))).status, 413);
  const status = await new Promise((resolve, reject) => {
    const req = request(f.url + "/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.2" }
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.write("x".repeat(8192));
    req.end("x".repeat(8193));
  });
  assert.equal(status, 413);
  assert.equal(f.sent.length, 1);
});

test("per-IP attempt limit is 5, resets after 15 minutes, and separates IPs", async (t) => {
  let clock = 0;
  const f = await fixture(t, { now: () => clock });
  for (let i = 0; i < 5; i++) assert.equal((await f.post()).status, 200);
  const limited = await f.post();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "900");
  assert.equal((await f.post(valid, { "X-Forwarded-For": "192.0.2.2" })).status, 200);
  clock = 900000;
  assert.equal((await f.post()).status, 200);
});

test("global attempt limit is 60 per hour across IPs and resets", async (t) => {
  let clock = 0;
  const f = await fixture(t, { now: () => clock });
  for (let i = 1; i <= 60; i++) {
    assert.equal((await f.post(valid, { "X-Forwarded-For": `192.0.2.${i}` })).status, 200);
  }
  const response = await f.post(valid, { "X-Forwarded-For": "192.0.2.61" });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3600");
  clock = 3600000;
  assert.equal((await f.post()).status, 200);
});

test("missing and chained proxy IPs are rejected instead of trusting arbitrary headers", async (t) => {
  const f = await fixture(t);
  for (const ip of ["", "not-an-ip", "192.0.2.1, 192.0.2.2"]) {
    assert.equal((await f.post(valid, { "X-Forwarded-For": ip })).status, 400);
  }
  const noProxy = await fetch(f.url + "/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(valid)
  });
  assert.equal(noProxy.status, 400);
  assert.equal(f.sent.length, 0);
});

test("SMTP errors and recipient rejection produce unconfirmed delivery without leaking details", async (t) => {
  for (const sendMail of [
    async () => { throw new Error("SMTP secret password diagnostic"); },
    async () => ({ accepted: [], rejected: [env.CONTACT_TO] })
  ]) {
    const f = await fixture(t, { transport: { sendMail } });
    const response = await f.post();
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.code, "delivery_unconfirmed");
    assert.match(result.message, /Do not retry automatically/);
    assert.doesNotMatch(JSON.stringify({ result, logs: f.logs }), /secret password/);
    assert.deepEqual(f.logs, [{ event: "smtp_not_confirmed", requestId: result.requestId }]);
  }
});

test("at most 3 concurrent SMTP deliveries; success waits for actual acceptance", async (t) => {
  const release = [];
  const f = await fixture(t, { transport: {
    sendMail: () => new Promise((resolve) => release.push(() => resolve({ accepted: [env.CONTACT_TO], rejected: [] })))
  } });
  const pending = [];
  try {
    for (let i = 0; i < 3; i++) {
      pending.push(f.post(valid, { "X-Forwarded-For": `192.0.2.${i + 1}` }));
      while (release.length <= i) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const busy = await f.post(valid, { "X-Forwarded-For": "192.0.2.4" });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("retry-after"), "30");
  } finally {
    release.forEach((resolve) => resolve());
    assert.ok((await Promise.all(pending)).every((response) => response.status === 200));
  }
});

test("unsupported routes and methods do not send mail; health check is explicit about SMTP", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(valid, {}, "/other")).status, 404);
  const get = await fetch(f.url + "/v1/messages");
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
  const health = await fetch(f.url + "/healthz");
  assert.equal(health.status, 200);
  assert.match((await health.json()).message, /does not check SMTP/);
  assert.equal(f.sent.length, 0);
});

test("Nodemailer renders a fixed envelope and plain-text message", async (t) => {
  const f = await fixture(t);
  await f.post({ ...valid, name: 'Example "Sender"', message: "<b>Plain text, not HTML</b>" });
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const mail = await transport.sendMail(f.sent[0]);
  assert.deepEqual(mail.envelope, { from: env.CONTACT_FROM, to: [env.CONTACT_TO] });
  const mime = mail.message.toString();
  assert.match(mime, /Content-Type: text\/plain/);
  assert.match(mime, /Reply-To:.*sender@example.com/);
  assert.doesNotMatch(mime, /Content-Type: text\/html/);
});

test("SMTP refuses a server without STARTTLS before sending credentials or message", async (t) => {
  const commands = [];
  const smtp = createTcpServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 localhost ESMTP\r\n");
    socket.on("data", (chunk) => {
      commands.push(chunk);
      if (chunk.startsWith("EHLO")) socket.write("250 localhost\r\n");
      else if (chunk.startsWith("STARTTLS")) socket.write("502 TLS unavailable\r\n");
      else socket.end("500 Unsupported\r\n");
    });
  });
  smtp.listen(0, "127.0.0.1");
  await once(smtp, "listening");
  t.after(() => new Promise((resolve) => smtp.close(resolve)));
  const transport = nodemailer.createTransport({
    ...loadConfig(env).smtp, host: "127.0.0.1", port: smtp.address().port
  });
  await assert.rejects(transport.sendMail({ from: env.CONTACT_FROM, to: env.CONTACT_TO, text: "Test" }));
  assert.match(commands.join(""), /STARTTLS/);
  assert.doesNotMatch(commands.join(""), /AUTH|MAIL FROM|Test/);
});

test("published OpenAPI, form and agent instructions match server topics and limits", async () => {
  const root = new URL("../../", import.meta.url);
  const spec = JSON.parse(await readFile(new URL("contact-api.json", root), "utf8"));
  const form = await readFile(new URL("contact.html", root), "utf8");
  const agents = await readFile(new URL("llms.txt", root), "utf8");
  assert.deepEqual(spec.components.schemas.Enquiry.properties.topic.enum, Object.keys(topics));
  assert.equal(spec.components.schemas.Enquiry.properties.message.maxLength, 4000);
  assert.equal(spec.components.schemas.Enquiry.properties.privacyAcknowledged.const, true);
  assert.deepEqual(spec.security, []);
  assert.equal(spec.servers[0].url, "https://contact.cocohealth.co.uk");
  assert.match(form, /action="https:\/\/contact.cocohealth.co.uk\/v1\/messages" method="post"/);
  assert.match(form, /<meta name="referrer" content="strict-origin">/);
  assert.match(form, /maxlength="4000"/);
  for (const topic of Object.keys(topics)) assert.ok(form.includes(`value="${topic}"`));
  assert.match(agents, /contact-api.json/);
  assert.match(agents, /Never automatically retry/);
});
