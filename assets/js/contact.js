(() => {
  "use strict";
  const form = document.getElementById("contact-form");
  const status = document.getElementById("contact-status");
  const button = document.getElementById("contact-submit");
  const topic = document.getElementById("contact-topic");
  const requestedTopic = new URLSearchParams(window.location.search).get("topic");
  if ([...topic.options].some((option) => option.value === requestedTopic)) topic.value = requestedTopic;
  if (!window.fetch || !window.AbortSignal?.timeout) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    button.disabled = true;
    form.setAttribute("aria-busy", "true");
    status.dataset.state = "pending";
    status.textContent = "Sending your enquiry. Please wait; do not submit it again.";
    const data = Object.fromEntries(new FormData(form));
    data.privacyAcknowledged = form.elements.privacyAcknowledged.checked;
    let confirmed = false;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(60000)
      });
      const result = await response.json();
      if (typeof result.message !== "string" || typeof result.requestId !== "string" ||
          typeof result.ok !== "boolean" || (response.ok && result.code !== "smtp_accepted")) {
        throw new Error("Unexpected contact response");
      }
      confirmed = response.ok && result.ok;
      status.dataset.state = confirmed ? "success" : "error";
      const retryAfter = response.headers.get("Retry-After");
      status.textContent = `${result.message} Reference: ${result.requestId}.${response.status === 429 && /^\d+$/.test(retryAfter) ? ` Try again in ${retryAfter} seconds.` : ""}`;
      if (confirmed) {
        form.reset();
        button.textContent = "Enquiry sent";
      }
    } catch {
      status.dataset.state = "error";
      status.textContent = "We could not confirm delivery. Your message has been kept in this form, but it may already have been accepted. Do not retry automatically. Please call +44 7340 677 361 to check, or arrange secure follow-up for a medical enquiry.";
    } finally {
      form.removeAttribute("aria-busy");
      if (!confirmed) button.disabled = false;
      status.focus();
    }
  });
})();
