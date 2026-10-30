export const topics = Object.freeze({
  general: "General enquiry",
  "health-checks": "Workplace health checks",
  "health-surveillance": "Health surveillance",
  "flu-clinics": "Flu clinics",
  construction: "Construction"
});

export function isEmail(value) {
  return typeof value === "string" && value.length <= 254 &&
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(value);
}

export function loadConfig(env = process.env) {
  const required = (key) => {
    if (!env[key]?.trim()) throw new Error(`Missing server setting: ${key}`);
    return env[key];
  };
  const integer = (key, fallback, maximum) => {
    const value = env[key] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
      throw new Error(`Invalid server setting: ${key}`);
    }
    return Number(value);
  };
  const from = required("CONTACT_FROM").trim();
  const to = required("CONTACT_TO").trim();
  if (!isEmail(from) || !isEmail(to)) throw new Error("CONTACT_FROM and CONTACT_TO must be single email addresses");
  if (!["true", "false"].includes(env.SMTP_SECURE ?? "false")) throw new Error("Invalid server setting: SMTP_SECURE");
  const port = integer("SMTP_PORT", 587, 65535);
  const secure = env.SMTP_SECURE === "true";
  if (port === 465 && !secure) throw new Error("SMTP_PORT 465 requires SMTP_SECURE=true");
  return {
    port: integer("PORT", 3000, 65535),
    from,
    to,
    allowedOrigins: ["https://www.cocohealth.co.uk", "https://cocohealth.co.uk"],
    smtp: {
      host: required("SMTP_HOST").trim(),
      port,
      secure,
      requireTLS: !secure,
      auth: { user: required("SMTP_USER"), pass: required("SMTP_PASS") },
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      dnsTimeout: 10000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false
    }
  };
}
