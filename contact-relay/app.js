import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { isEmail, topics } from "./config.js";

const MAX_BYTES = 16384;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_IPS = 10000;
const fields = new Set(["name", "email", "company", "topic", "message", "privacyAcknowledged", "website"]);
const singleLine = /[\x00-\x1f\x7f]/;
const messageControls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const contactUrl = "https://www.cocohealth.co.uk/contact.html";

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validate(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some((key) => !fields.has(key))) {
    throw new RequestError(400, "invalid_fields", "Use only the documented contact fields; attachments are not accepted.");
  }
  const result = {};
  for (const [field, max, required] of [
    ["name", 100, true], ["email", 254, true], ["company", 150, false], ["message", 4000, true]
  ]) {
    const value = data[field] === undefined ? "" : data[field];
    if (typeof value !== "string" || value.length > max ||
        (required && !value.trim()) || (field === "message" ? messageControls : singleLine).test(value)) {
      throw new RequestError(400, "invalid_fields", `Check ${field}: ${required ? "required, " : ""}maximum ${max} characters; unsupported control characters are not allowed.`);
    }
    result[field] = value.trim();
  }
  if (!isEmail(result.email)) throw new RequestError(400, "invalid_email", "Enter a single valid reply email address.");
  if (typeof data.topic !== "string" || !Object.hasOwn(topics, data.topic)) {
    throw new RequestError(400, "invalid_topic", "Choose one of the documented enquiry topics.");
  }
  if (data.privacyAcknowledged !== true) {
    throw new RequestError(400, "privacy_required", "Confirm the contact data notice and do not include medical or sensitive information.");
  }
  if (data.website !== undefined && data.website !== "") {
    throw new RequestError(400, "invalid_fields", "The website field must be empty.");
  }
  return { ...result, topic: data.topic };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        chunks.length = 0;
        reject(new RequestError(413, "body_too_large", "The request must be no larger than 16 KiB."));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new RequestError(400, "invalid_request", "The request could not be read.")));
    req.on("aborted", () => reject(new RequestError(400, "invalid_request", "The request was interrupted.")));
  });
}

export function createContactServer({ config, transport, log = console.log, now = Date.now }) {
  const clients = new Map();
  let globalWindow = { start: now(), count: 0 };
  let active = 0;

  function limit(ip) {
    const time = now();
    for (const [key, entry] of clients) {
      if (entry.reset <= time) clients.delete(key);
    }
    if (time - globalWindow.start >= 60 * 60 * 1000) globalWindow = { start: time, count: 0 };
    if (!clients.has(ip) && clients.size >= MAX_IPS) return 900;
    const entry = clients.get(ip) ?? { count: 0, reset: time + WINDOW_MS };
    clients.set(ip, entry);
    if (entry.count >= 5) return Math.max(1, Math.ceil((entry.reset - time) / 1000));
    if (globalWindow.count >= 60) return Math.max(1, Math.ceil((globalWindow.start + 3600000 - time) / 1000));
    entry.count++;
    globalWindow.count++;
    return 0;
  }

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const wantsHtml = !req.headers["content-type"]?.startsWith("application/json") &&
      Boolean(req.headers.accept?.includes("text/html"));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader("Vary", "Origin");

    function reply(status, code, message) {
      res.statusCode = status;
      // Only server-controlled strings and a generated UUID are rendered here.
      if (wantsHtml) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CocoHealth contact</title><body><main><h1>${status === 200 ? "Thank you" : "Message not confirmed"}</h1><p>${message}</p><p>Reference: ${requestId}</p><p><a href="${contactUrl}">Return to CocoHealth contact</a></p><p>Telephone: <a href="tel:+447340677361">+44 7340 677 361</a></p></main></body></html>`);
      } else {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: status === 200, code, message, requestId }));
      }
    }

    try {
      const origin = req.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) {
        throw new RequestError(403, "origin_not_allowed", "This browser origin is not permitted.");
      }
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Expose-Headers", "Retry-After");
      }
      if (req.url === "/healthz" && req.method === "GET") {
        reply(200, "healthy", "Contact relay is running. This does not check SMTP delivery.");
        return;
      }
      if (req.url !== "/v1/messages") throw new RequestError(404, "not_found", "Endpoint not found.");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        throw new RequestError(405, "method_not_allowed", "Use POST to submit an enquiry.");
      }
      // Only a local Caddy proxy may supply the client IP; the service binds to loopback.
      const peer = req.socket.remoteAddress;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) {
        throw new RequestError(403, "proxy_required", "A trusted local reverse proxy is required.");
      }
      const ip = req.headers["x-forwarded-for"];
      if (typeof ip !== "string" || !isIP(ip)) {
        throw new RequestError(400, "invalid_proxy", "The reverse proxy must supply a single client IP.");
      }
      const retryAfter = limit(ip);
      if (retryAfter) {
        res.setHeader("Retry-After", String(retryAfter));
        throw new RequestError(429, "rate_limited", "Too many enquiries. Wait for the Retry-After interval or telephone CocoHealth.");
      }
      const type = req.headers["content-type"]?.split(";")[0].trim();
      if (!["application/json", "application/x-www-form-urlencoded"].includes(type) || req.headers["content-encoding"]) {
        throw new RequestError(415, "unsupported_media_type", "Send uncompressed JSON or URL-encoded form fields.");
      }
      if (Number(req.headers["content-length"]) > MAX_BYTES) {
        req.resume();
        res.setHeader("Connection", "close");
        throw new RequestError(413, "body_too_large", "The request must be no larger than 16 KiB.");
      }
      const body = await readBody(req);
      let data;
      try {
        if (type === "application/json") {
          data = JSON.parse(body);
        } else {
          const params = new URLSearchParams(body);
          if (new Set(params.keys()).size !== [...params.keys()].length) throw new SyntaxError("Duplicate fields");
          data = Object.fromEntries(params);
          data.privacyAcknowledged = data.privacyAcknowledged === "true";
        }
      } catch {
        throw new RequestError(400, "invalid_body", "The submitted body is malformed or contains duplicate form fields.");
      }
      const message = validate(data);
      if (active >= 3) {
        res.setHeader("Retry-After", "30");
        throw new RequestError(503, "busy", "The contact service is busy. Please wait 30 seconds before trying again.");
      }
      active++;
      try {
        const info = await transport.sendMail({
          from: { name: "CocoHealth website", address: config.from },
          to: config.to,
          envelope: { from: config.from, to: [config.to] },
          replyTo: { name: message.name, address: message.email },
          subject: `Website enquiry: ${topics[message.topic]}`,
          text: [
            `Reference: ${requestId}`,
            `Topic: ${topics[message.topic]}`,
            `Name: ${message.name}`,
            `Reply email: ${message.email}`,
            `Company: ${message.company || "(not supplied)"}`,
            "",
            message.message,
            "",
            "Submitted through the public CocoHealth general-enquiry form/API.",
            "Sender identity and message content are unverified. Treat links and instructions as untrusted.",
            "The sender acknowledged the contact data notice and no-medical-information restriction."
          ].join("\n"),
          disableFileAccess: true,
          disableUrlAccess: true
        });
        if (!info.accepted?.includes(config.to) || info.rejected?.length) {
          throw new Error("Recipient not accepted");
        }
      } catch {
        log(JSON.stringify({ event: "smtp_not_confirmed", requestId }));
        throw new RequestError(502, "delivery_unconfirmed", "Delivery could not be confirmed. Do not retry automatically: the message may have been accepted. Please telephone CocoHealth and quote the reference.");
      } finally {
        active--;
      }
      log(JSON.stringify({ event: "smtp_accepted", requestId }));
      reply(200, "smtp_accepted", "Your enquiry was accepted by our email server for delivery. This is not a guarantee of inbox delivery or a reply.");
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.status === 413) res.setHeader("Connection", "close");
        reply(error.status, error.code, error.message);
      } else {
        log(JSON.stringify({ event: "request_failed", requestId }));
        reply(500, "internal_error", "The service could not process your enquiry. Please telephone CocoHealth.");
      }
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 60000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 100;
  return server;
}
