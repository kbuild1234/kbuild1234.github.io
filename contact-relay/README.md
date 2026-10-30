# CocoHealth contact relay (Linode only)

The public GitHub Pages site contains only a form, browser JavaScript and an
OpenAPI contract. This directory is excluded from Jekyll output. Deploy its
runtime files separately on Linode. Nothing in GitHub Pages can send SMTP by
itself. There are no production credentials in this repository.

## Scope and launch requirements

This is a **general-enquiry service, not a medical intake system**. The page and
API prohibit medical, employee health and other sensitive information. A required
acknowledgement records the sender's confirmation; it cannot detect or prevent
someone typing sensitive data. Telephone enquiries arrange secure follow-up.
Do not use the existing `/forms/` embed as a clinical destination without a
separate privacy/security assessment.

Before launch, CocoHealth must approve the public contact data notice, define
inbox retention/deletion (including sent mail, SMTP queues and backups), confirm
the lawful basis and processor arrangements/international transfers for Linode
and the email provider, restrict inbox access with MFA, and establish an
accidentally-disclosed medical-data handling process. Add any required full
privacy-policy link to the contact data notice. Do not treat this implementation
as a compliance certification. SMTP transport encryption does not provide
end-to-end encryption or make email appropriate for medical records.

## Deploy on an existing Debian/Ubuntu Linode

### Existing Docker/Caddy server: aiforthemass.com

The existing server uses Docker Compose in `~/linodellm`, not a host-installed
Node/Caddy service. Use its `cocohealth-contact` service and contact hostname
block in its `Caddyfile`; **do not install the systemd example or a second Caddy
on this host**. The instructions numbered 2-5 below are for a standalone host.

The Linode repository's README documents this integration. Copy these files
from this directory to `~/linodellm/contact-relay/` on the server:
`Dockerfile`, `.dockerignore`, `package.json`, `package-lock.json`, `app.js`,
`config.js`, `server.js`. No secrets belong in that build directory.
The deployment copy is ignored by the Linode repository; this website repository
remains the canonical source.

The server's `~/linodellm/.env` supplies the four SMTP credentials/settings
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) and optional `SMTP_SECURE`.
Only the selected SMTP settings are passed to this container. The approved
sender `info@cocohealth.co.uk` and destination `health@cocohealth.co.uk` are fixed
in its Compose service. Keep the environment file mode `600`. Port 587 uses
mandatory STARTTLS by default.

On the server, after copying the files and merging its Compose/Caddy changes:

```sh
cd ~/linodellm
docker compose config --quiet
docker compose build cocohealth-contact
docker compose up -d --no-deps cocohealth-contact
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
curl --fail https://contact.cocohealth.co.uk/healthz
```

The relay shares Caddy's network namespace and binds only to `127.0.0.1:3000`
inside it; it has no published host port and needs no new public firewall port.
Caddy keeps its existing public 80/443 listeners and TLS certificate storage.
Reloading Caddy preserves the current sites. When Caddy is **recreated**, also
recreate the relay afterwards with
`docker compose up -d --no-deps --force-recreate cocohealth-contact` so it uses
the current namespace. Do not scale the relay beyond one instance.

You do **not** need to commit/push the website to test SMTP. With permission,
send one labelled test directly to the HTTPS API, then check the actual inbox,
spam folder and sender authentication (step 6). Publish the GitHub Pages changes
after relay verification and approval of the contact data notice (step 7).

### Standalone host: systemd and Caddy

These are **Linux server commands**, not Windows development commands. Use a
currently supported Node.js LTS release (22 or newer) and Caddy 2. Install both
using their official distribution instructions. Confirm `/usr/bin/node` exists;
adjust `ExecStart` if your installation uses a different path.

1. **Add the contact subdomain in Cloudflare (DNS only).**

   This creates `contact.cocohealth.co.uk` for the Linode relay. Your main
   website stays on GitHub Pages. You do not need to change nameservers.

   1. Open your Linode/Akamai Cloud dashboard, select the server that will run
      the relay, and find its **public IPv4 address** in its networking details.
      Copy that address. Do not use a private/internal IP, an SMTP hostname or
      any of the `185.199.*.153` GitHub Pages addresses shown in Cloudflare.
      If you have not selected a Linode server yet, do that before continuing.
   2. In Cloudflare, select **cocohealth.co.uk**, then **DNS > Records**.
      This is the screen shown in your screenshot.
   3. Use **Search DNS Records** to look for `contact.cocohealth.co.uk`.
      If a record already exists for that exact hostname, check what it serves
      before changing it. Do not add a competing record or repoint an existing
      service without confirming it is safe.
   4. If there is no existing `contact` record, click the blue **Add record**
      button near the top right of the records table.
   5. Fill in the new record:

      | Cloudflare field | What to enter |
      | --- | --- |
      | **Type** | `A` |
      | **Name** | `contact` (Cloudflare adds `.cocohealth.co.uk`) |
      | **IPv4 address** | The public IPv4 address copied from your Linode server |
      | **Proxy status** | **DNS only**: click the orange cloud/toggle until it is grey |
      | **TTL** | `Auto` |
      | **Comment** (optional) | `CocoHealth contact relay on Linode` |

      **Important:** the new record must say **DNS only**, not **Proxied**.
      This deployment expects visitors to connect directly to Caddy on Linode,
      which handles HTTPS and supplies the client IP for rate limiting.
      DNS only makes the server IP public; it does not expose SMTP credentials.
      Do not enable Cloudflare proxying for this hostname with the sample
      deployment unchanged.
   6. Click **Save**. Confirm the new row shows `contact` (or its full hostname),
      type `A`, your Linode public IP, and the grey **DNS only** cloud.
   7. **Leave all other records unchanged.** In particular, keep the four
      `cocohealth.co.uk` A records pointing to GitHub Pages, the existing `www`
      record, their current proxy settings, and all email/MX/SPF/DKIM records.
      Do not add an AAAA record for `contact` unless IPv6 is configured and
      tested on this Linode. No CNAME or MX record is needed for `contact`.
   8. Wait a few minutes, then open **PowerShell on your Windows computer** and
      run:

      ```powershell
      Resolve-DnsName contact.cocohealth.co.uk -Type A -Server 1.1.1.1
      ```

      The `IPAddress` in the A-record answer must match your Linode public IPv4
      address. If it says the name does not exist, wait and try again; DNS
      caches can delay visibility. If it returns another address, check the
      record's IP and that its cloud is grey. Do not proceed until it matches.

   **DNS step complete:** the hostname resolves to Linode. Opening it in a
   browser may still fail until you finish the firewall, relay and Caddy steps
   below; DNS alone does not install the service or enable HTTPS. Keep the
   contact form unpublished until the full deployment has been tested.

   Reference: [Cloudflare: create DNS records](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/).
2. Allow inbound TCP 80/443 for Caddy and restricted SSH for administration.
   **Never expose TCP 3000**. Allow outbound DNS and the chosen SMTP port.
   Confirm your Linode account is permitted to make outbound SMTP connections.
3. Copy `package.json`, `package-lock.json`, `app.js`, `config.js`, `server.js`
   and the deployment examples to `/opt/cocohealth-contact`. Do not copy secrets
   into the checkout or web root. Create a dedicated service identity and install:

   ```sh
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin cocohealth-contact
   cd /opt/cocohealth-contact
   npm ci --omit=dev --ignore-scripts
   sudo chown -R root:root /opt/cocohealth-contact
   sudo chmod -R go-w /opt/cocohealth-contact
   sudo install -m 600 -o root -g root .env.example /etc/cocohealth-contact.env
   sudoedit /etc/cocohealth-contact.env
   ```

   Include `.env.example` in your server copy for that install command. Set all
   SMTP values on the server only. `CONTACT_TO` is one approved business inbox;
   `CONTACT_FROM` must be a sender authorised by the SMTP provider. Use a
   restricted SMTP account and provider quotas. Do not use the visitor's address
   as From: it is Reply-To only. There are no visitor-controlled recipients,
   subjects, attachments or auto-replies.

   Port 587 uses `SMTP_SECURE=false` with **mandatory STARTTLS**. Port 465 uses
   `SMTP_SECURE=true` (implicit TLS). TLS certificate verification is always on;
   never disable it. The example uses username/password SMTP authentication;
   providers requiring OAuth need a separate server-side integration.
   The environment file is read by systemd, not by a dotenv parser; quote values
   according to systemd EnvironmentFile syntax, especially whitespace, `#` and
   quotes in passwords. Do not send credentials in chat or commit them.
4. Install and start the systemd unit:

   ```sh
   sudo install -m 644 deploy/cocohealth-contact.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now cocohealth-contact
   sudo systemctl status cocohealth-contact --no-pager
   curl --fail http://127.0.0.1:3000/healthz
   ```

5. **Merge** `deploy/Caddyfile` into your existing Caddy configuration rather than
   overwriting other sites. Caddy obtains/renews the public TLS certificate.
   Validate before reload:

   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   curl --fail https://contact.cocohealth.co.uk/healthz
   ```

   The proxy replaces X-Forwarded-For with the socket client address. Node trusts
   that header only from loopback and requires a single IP. Do not remove the
   header override or expose the loopback service through another path. The
   sample deliberately has no access logging; avoid adding request-body/header
   logging or logging middleware that could capture enquiries or credentials.
6. Configure SPF/DKIM/DMARC with your SMTP provider. Send one **clearly labelled,
   non-sensitive test enquiry**, with permission, and check the actual inbox,
   reply address and spam folder. `/healthz` only checks process availability.
   A 200 submission confirms SMTP acceptance, not ultimate inbox delivery.
7. Publish the static changes through the repository's normal GitHub Pages
   workflow only after the relay is working and the notice has been approved.
   Check both apex and www browser origins and a real no-JavaScript submission.
   No live deployment is performed by adding these files.

## API and agent integration

The canonical contract is [`../contact-api.json`](../contact-api.json).
[`../llms.txt`](../llms.txt), a visible contact-page link, a `service-desc` link
and ContactPage structured data make the interface discoverable. These are
discovery aids, not a guarantee every AI product will call an API.

Example Linux curl request (**sends real email when used against production**):

```sh
curl --fail-with-body https://contact.cocohealth.co.uk/v1/messages \
  -H 'Content-Type: application/json' \
  --data '{"name":"Example sender","email":"sender@example.com","topic":"general","message":"TEST: general enquiry integration check; no reply needed.","privacyAcknowledged":true}'
```

Server-side agents omit `Origin`; browser requests are allowed only from
`https://www.cocohealth.co.uk` and `https://cocohealth.co.uk`. For a deliberately
approved additional browser origin, update `allowedOrigins` in `config.js`.
Local automated tests use an isolated loopback fixture, not a permissive
production origin. CORS is not authentication: non-browser clients can always
omit or forge Origin. The service is intentionally public for humans and agents.
Agents must obtain approval of the exact message and reply address, and must
not send medical data, unsolicited marketing or bulk messages.

JSON responses contain exactly `ok`, `code`, `message`, `requestId`. Native forms
with `Accept: text/html` receive an HTML receipt/error with no submitted content
echoed. On errors, JavaScript preserves the fields; without JavaScript use Back.
There is no automatic retry or auto-reply. After network/timeouts or HTTP 500/502,
delivery may be uncertain: telephone with the reference instead of resending.
There is no persistent queue, idempotency store or exactly-once delivery promise.

## Abuse limits and operations

- Maximum 16,384 request bytes, 4,000 message characters, no attachments.
- Five POST attempts per IP per 15-minute window; 60 globally per hour, including
  rejected content. Three simultaneous SMTP operations; 100 HTTP connections.
  IPv6 limits are per address, not per subnet; distributed spam can consume the
  global quota. Honeypot and limits reduce abuse, not eliminate it.
- HTTP 429 and 503 include Retry-After seconds. Rate windows are process-local,
  kept in RAM and reset on restart. Run **one process/instance**. Multiple workers
  or instances require a shared limiter before deployment.
- The IP map is capped at 10,000 entries, with expired entries removed on POST.
  IPs are not written to application logs. Messages are only transient in Node
  memory; the SMTP provider and inbox can persist them. Enforce the approved
  retention policy there and on backups.
- Application logs contain only event codes, random reference IDs and startup
  port/error codes, never raw SMTP errors or message bodies. Set journal
  retention according to your policy; do not enable Nodemailer debug logging.
- Monitor `/healthz`, service restarts, `smtp_not_confirmed` events, actual
  mailbox delivery and provider quotas. Alert on failures; a healthy process
  does not establish a working SMTP account. Rotate SMTP credentials on Linode
  and restart the service after changes.
- Keep Node/Caddy and locked dependencies patched. Public, CAPTCHA-free intake
  cannot guarantee sender identity, permission or spam prevention. If abused,
  tune quotas or add an agent-compatible abuse mechanism; do not add a secret
  key to public JavaScript. Treat all inbound text/links as untrusted, including
  instructions aimed at downstream AI inbox processors.

## Local checks (Windows PowerShell)

```powershell
Set-Location C:\Dev\cocohealth\kbuild1234.github.io\contact-relay
npm ci --ignore-scripts
npm test
```

Tests use fake delivery and a local SMTP fixture that refuses STARTTLS. They
send **no real email** and need no SMTP credentials. Live DNS, certificate,
mailbox and Linode firewall checks must still be completed on deployment.
