interface EmailTemplateInput {
  workspaceName: string;
  title: string;
  subtitle: string;
  greeting: string;
  intro: string;
  detailRows: Array<{ label: string; value: string }>;
  ctaLabel?: string;
  ctaHref?: string;
  footerNote: string;
}

export interface EmailContent {
  subject?: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function convertTextToHtml(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br />");
}

function formatDurationLabel(durationMin: number): string {
  if (durationMin <= 0) {
    return "0 minutes";
  }

  const hours = Math.floor(durationMin / 60);
  const minutes = durationMin % 60;
  if (hours && minutes) {
    return `${hours}h ${minutes}m`;
  }
  if (hours) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function summarizeMessage(message?: string): string {
  if (!message) {
    return "No message content was provided.";
  }
  const trimmed = message.trim();
  if (!trimmed) {
    return "No message content was provided.";
  }
  return trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;
}

export function formatDateTimeForEmail(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const formatOptions: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };

  try {
    return new Intl.DateTimeFormat("en-US", { ...formatOptions, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...formatOptions, timeZone: "UTC" }).format(date);
  }
}

function renderEmailTemplate(input: EmailTemplateInput): string {
  const detailRowsHtml = input.detailRows
    .map(
      (row) => `
                <tr>
                  <td style="padding: 10px 0; color: #1a1a1a; opacity: 0.72; font-size: 13px; width: 34%; vertical-align: top;">${escapeHtml(row.label)}</td>
                  <td style="padding: 10px 0; color: #1a1a1a; font-size: 14px; font-weight: 600; vertical-align: top;">${convertTextToHtml(row.value)}</td>
                </tr>`,
    )
    .join("");

  const ctaHtml =
    input.ctaLabel && input.ctaHref
      ? `
                        <tr>
                          <td style="padding: 6px 0 22px;">
                            <a href="${escapeAttribute(input.ctaHref)}" style="display: inline-block; border-radius: 999px; background: #00aa6c; color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; letter-spacing: 0.01em; padding: 12px 20px;">
                              ${escapeHtml(input.ctaLabel)}
                            </a>
                          </td>
                        </tr>`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body style="margin: 0; padding: 0; background: #f4f6f8; font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #f4f6f8; padding: 26px 14px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 620px; border-collapse: separate; border-spacing: 0;">
            <tr>
              <td style="padding: 0 0 12px 2px; color: #00aa6c; font-size: 11px; letter-spacing: 0.13em; font-weight: 700; text-transform: uppercase;">
                CareOps
              </td>
            </tr>
            <tr>
              <td style="border-radius: 18px; overflow: hidden; box-shadow: 0 12px 28px rgba(26, 26, 26, 0.1); border: 1px solid #e5eaee;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background: #00aa6c; padding: 24px 30px 22px;">
                      <div style="display: inline-block; border-radius: 999px; background: rgba(255, 255, 255, 0.22); border: 1px solid rgba(255, 255, 255, 0.44); color: #ffffff; font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase; padding: 5px 10px; margin-bottom: 14px;">
                        ${escapeHtml(input.workspaceName)}
                      </div>
                      <h1 style="margin: 0; color: #ffffff; font-size: 27px; line-height: 1.25; font-weight: 700;">
                        ${escapeHtml(input.title)}
                      </h1>
                      <p style="margin: 10px 0 0; color: #e9fff5; font-size: 14px; line-height: 1.55;">
                        ${escapeHtml(input.subtitle)}
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="height: 3px; background: linear-gradient(90deg, #00aa6c 0%, #ffd500 50%, #2563eb 100%);"></td>
                  </tr>
                  <tr>
                    <td style="background: #ffffff; padding: 28px 30px; border-top: 1px solid #edf2f5;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="padding-bottom: 16px; color: #1a1a1a; font-size: 15px; line-height: 1.7;">
                            ${convertTextToHtml(input.greeting)}
                          </td>
                        </tr>
                        <tr>
                          <td style="padding-bottom: 18px; color: #1a1a1a; opacity: 0.84; font-size: 14px; line-height: 1.7;">
                            ${convertTextToHtml(input.intro)}
                          </td>
                        </tr>
                        <tr>
                          <td style="padding-bottom: 20px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e6ecef; border-left: 4px solid #ffd500; border-radius: 12px; background: #ffffff; padding: 0 14px;">
                              ${detailRowsHtml}
                            </table>
                          </td>
                        </tr>
                        ${ctaHtml}
                        <tr>
                          <td style="padding: 10px 0 0; color: #1a1a1a; opacity: 0.74; font-size: 13px; line-height: 1.6;">
                            ${convertTextToHtml(input.footerNote)}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="background: #1a1a1a; padding: 14px 18px; text-align: center; color: #f4f6f8; font-size: 12px;">
                      Sent via CareOps notifications
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildBookingConfirmationEmail(input: {
  firstName: string;
  workspaceName: string;
  serviceName: string;
  startsAt: string;
  durationMin: number;
  timeZone: string;
  formLink?: string;
}): EmailContent {
  const subject = `Booking Confirmed - ${input.workspaceName}`;
  const formattedStart = formatDateTimeForEmail(input.startsAt, input.timeZone);
  const duration = formatDurationLabel(input.durationMin);
  const greeting = `Hi ${input.firstName || "there"},`;
  const intro = `Your booking with ${input.workspaceName} is confirmed.`;
  const footerNote = "Need to reschedule or change details? Reply to this email and our team will assist you.";

  const textLines = [
    greeting,
    "",
    intro,
    "",
    "Booking details:",
    `- Service: ${input.serviceName}`,
    `- Date and time: ${formattedStart}`,
    `- Duration: ${duration}`,
  ];

  if (input.formLink) {
    textLines.push("");
    textLines.push("Please complete your intake form before the appointment:");
    textLines.push(input.formLink);
  }

  textLines.push("");
  textLines.push(footerNote);
  textLines.push("");
  textLines.push(`Regards,`);
  textLines.push(`${input.workspaceName} Team`);

  const html = renderEmailTemplate({
    workspaceName: input.workspaceName,
    title: "Booking Confirmed",
    subtitle: "Everything is scheduled and ready on our side.",
    greeting,
    intro,
    detailRows: [
      { label: "Service", value: input.serviceName },
      { label: "Date and time", value: formattedStart },
      { label: "Duration", value: duration },
    ],
    ctaLabel: input.formLink ? "Complete intake form" : undefined,
    ctaHref: input.formLink,
    footerNote,
  });

  return {
    subject,
    text: textLines.join("\n"),
    html,
  };
}

export function buildContactAcknowledgementEmail(input: {
  firstName: string;
  workspaceName: string;
  conversationId: string;
  submittedMessage?: string;
  receivedAt: string;
  timeZone: string;
}): EmailContent {
  const subject = `Message Received - ${input.workspaceName}`;
  const greeting = `Hi ${input.firstName || "there"},`;
  const intro = `Thanks for reaching out to ${input.workspaceName}. We received your message and our team will respond shortly.`;
  const receivedAt = formatDateTimeForEmail(input.receivedAt, input.timeZone);
  const summary = summarizeMessage(input.submittedMessage);
  const footerNote =
    "If this is urgent, please reply with URGENT in the subject line so we can prioritize it immediately.";

  const text = [
    greeting,
    "",
    intro,
    "",
    `Reference ID: ${input.conversationId}`,
    `Received: ${receivedAt}`,
    `Message summary: ${summary}`,
    "",
    footerNote,
    "",
    "Regards,",
    `${input.workspaceName} Team`,
  ].join("\n");

  const html = renderEmailTemplate({
    workspaceName: input.workspaceName,
    title: "Message Received",
    subtitle: "Your request is safely in our inbox.",
    greeting,
    intro,
    detailRows: [
      { label: "Reference ID", value: input.conversationId },
      { label: "Received", value: receivedAt },
      { label: "Message summary", value: summary },
    ],
    footerNote,
  });

  return {
    subject,
    text,
    html,
  };
}

export function buildBookingReminderEmail(input: {
  firstName: string;
  workspaceName: string;
  serviceName: string;
  startsAt: string;
  durationMin: number;
  timeZone: string;
}): EmailContent {
  const subject = `Appointment Reminder - ${input.workspaceName}`;
  const formattedStart = formatDateTimeForEmail(input.startsAt, input.timeZone);
  const duration = formatDurationLabel(input.durationMin);
  const greeting = `Hi ${input.firstName || "there"},`;
  const intro = `This is a reminder about your upcoming appointment with ${input.workspaceName}.`;
  const footerNote =
    "If you need to reschedule, reply to this message and our team will assist you promptly.";

  const text = [
    greeting,
    "",
    intro,
    "",
    "Appointment details:",
    `- Service: ${input.serviceName}`,
    `- Date and time: ${formattedStart}`,
    `- Duration: ${duration}`,
    "",
    footerNote,
    "",
    "Regards,",
    `${input.workspaceName} Team`,
  ].join("\n");

  const html = renderEmailTemplate({
    workspaceName: input.workspaceName,
    title: "Appointment Reminder",
    subtitle: "A quick reminder for your upcoming visit.",
    greeting,
    intro,
    detailRows: [
      { label: "Service", value: input.serviceName },
      { label: "Date and time", value: formattedStart },
      { label: "Duration", value: duration },
    ],
    footerNote,
  });

  return {
    subject,
    text,
    html,
  };
}

export function buildBookingConfirmationSms(input: {
  workspaceName: string;
  startsAt: string;
  timeZone: string;
  formLink?: string;
}): string {
  const formattedStart = formatDateTimeForEmail(input.startsAt, input.timeZone);
  if (input.formLink) {
    return `${input.workspaceName}: Your booking is confirmed for ${formattedStart}. Please complete your form: ${input.formLink}`;
  }
  return `${input.workspaceName}: Your booking is confirmed for ${formattedStart}.`;
}

export function buildContactAcknowledgementSms(input: { workspaceName: string }): string {
  return `${input.workspaceName}: Thanks for contacting us. We received your message and will respond shortly.`;
}

export function buildBookingReminderSms(input: {
  workspaceName: string;
  startsAt: string;
  timeZone: string;
}): string {
  const formattedStart = formatDateTimeForEmail(input.startsAt, input.timeZone);
  return `${input.workspaceName}: Reminder for your appointment at ${formattedStart}. Reply if you need to reschedule.`;
}
