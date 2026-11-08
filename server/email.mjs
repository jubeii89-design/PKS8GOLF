/**
 * Sends a player their credentials and tournament details once they have paid.
 *
 * SMTP rather than one provider's API, because every mail service speaks it —
 * Gmail, SendGrid, Mailgun, SES and the rest — so switching provider is a
 * change of environment variables, not of code.
 *
 * Configuration:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   MAIL_FROM              e.g. "Strategic Titans <tournament@strategictitans.ca>"
 *
 * With no SMTP_HOST set, mail is written to the log instead of sent. That
 * keeps local development and the test suite working without a mail server,
 * and it is obvious in the log that nothing actually went out.
 *
 * A player's PIN appears in the message body and nowhere else — it is never
 * logged, even in console mode.
 */

import { createTransport } from "nodemailer";

const HOST = process.env.SMTP_HOST ?? "";
const PORT = Number(process.env.SMTP_PORT ?? 587);
const USER = process.env.SMTP_USER ?? "";
const PASS = process.env.SMTP_PASS ?? "";
const FROM = process.env.MAIL_FROM ?? "PKS8GOLF Tournament <no-reply@strategictitans.ca>";

let transport = null;

export function isConfigured() {
  return HOST !== "";
}

function getTransport() {
  if (transport) return transport;
  transport = createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465, // 465 is implicit TLS; 587 upgrades via STARTTLS
    auth: USER ? { user: USER, pass: PASS } : undefined,
  });
  return transport;
}

/** Hide most of an address so the log shows who was mailed without exposing it. */
function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  if (!domain) return "***";
  return `${user.slice(0, 2)}***@${domain}`;
}

function plainBody({ name, playerId, pin, tournament, playUrl }) {
  return `Hello ${name},

You're entered in the ${tournament.name}. Your entry fee has been received —
thank you for supporting ${tournament.charity}.

YOUR CREDENTIALS
  Player ID:  ${playerId}
  PIN:        ${pin}

Keep these safe. You'll need both to join, and they're the only way we can
identify your round.

TOURNAMENT DETAILS
  When:      ${tournament.date}
  Tee-off:   ${tournament.teeOff}
  Format:    18 hands, one round, PokerStr8ts scoring
  Where:     ${playUrl}

HOW TO PLAY
  1. Open ${playUrl} on your phone at your tee-off time.
  2. Tap Tournament.
  3. Enter the Player ID and PIN above.
  4. Play all 18 hands. Your score is reported automatically on the last card.

You can warm up any time before then with Practice mode — practice rounds are
never scored or reported.

If you arrive after your tee-off time you won't be able to join, so please
check in early. Any trouble on the day, find a tournament official.

Good luck,
Strategic Titans
${tournament.contact}
`;
}

function htmlBody({ name, playerId, pin, tournament, playUrl }) {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  return `<!doctype html>
<html><body style="margin:0;background:#0d2818;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#eaf3ec">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <h1 style="color:#e8c766;font-size:22px;margin:0 0 4px">${esc(tournament.name)}</h1>
    <p style="color:#9fbfa8;margin:0 0 24px;font-size:14px">You're in. Thank you for supporting ${esc(tournament.charity)}.</p>

    <div style="background:#123a22;border:1px solid #2c6b42;border-radius:10px;padding:20px;margin-bottom:24px">
      <div style="color:#9fbfa8;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:12px">Your credentials</div>
      <table style="width:100%;border-collapse:collapse;font-size:16px">
        <tr><td style="padding:6px 0;color:#9fbfa8">Player ID</td>
            <td style="padding:6px 0;text-align:right;font-family:ui-monospace,Menlo,monospace;color:#e8c766;font-weight:700">${esc(playerId)}</td></tr>
        <tr><td style="padding:6px 0;color:#9fbfa8">PIN</td>
            <td style="padding:6px 0;text-align:right;font-family:ui-monospace,Menlo,monospace;color:#e8c766;font-weight:700">${esc(pin)}</td></tr>
      </table>
      <p style="color:#9fbfa8;font-size:12px;margin:12px 0 0">Keep these safe — you need both to join.</p>
    </div>

    <div style="margin-bottom:24px">
      <div style="color:#9fbfa8;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:10px">Tournament details</div>
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        <tr><td style="padding:5px 0;color:#9fbfa8">When</td><td style="padding:5px 0;text-align:right">${esc(tournament.date)}</td></tr>
        <tr><td style="padding:5px 0;color:#9fbfa8">Tee-off</td><td style="padding:5px 0;text-align:right">${esc(tournament.teeOff)}</td></tr>
        <tr><td style="padding:5px 0;color:#9fbfa8">Format</td><td style="padding:5px 0;text-align:right">18 hands, PokerStr8ts</td></tr>
      </table>
    </div>

    <a href="${esc(playUrl)}" style="display:block;text-align:center;background:#e8c766;color:#0d2818;text-decoration:none;font-weight:700;padding:14px;border-radius:8px;margin-bottom:24px">Play at your tee-off time</a>

    <p style="color:#9fbfa8;font-size:13px;line-height:1.6;margin:0 0 8px">
      Open the link on your phone, tap <strong style="color:#eaf3ec">Tournament</strong>, and enter your Player ID and PIN.
      Play all 18 hands — your score reports automatically on the last card.
    </p>
    <p style="color:#9fbfa8;font-size:13px;line-height:1.6;margin:0 0 24px">
      Warm up any time with <strong style="color:#eaf3ec">Practice</strong> mode; practice rounds are never scored.
      If you arrive after your tee-off time you won't be able to join, so check in early.
    </p>

    <p style="color:#6d8f78;font-size:12px;border-top:1px solid #2c6b42;padding-top:16px;margin:0">
      Strategic Titans · ${esc(tournament.contact)}
    </p>
  </div>
</body></html>`;
}

/**
 * Mail one player their credentials. Returns whether it actually went out, so
 * a failure can be recorded against the player rather than disappearing —
 * someone who paid and never got their PIN is a problem you need to see.
 */
export async function sendCredentials({ to, name, playerId, pin, tournament, playUrl }) {
  const message = {
    from: FROM,
    to,
    subject: `You're entered — ${tournament.name}`,
    text: plainBody({ name, playerId, pin, tournament, playUrl }),
    html: htmlBody({ name, playerId, pin, tournament, playUrl }),
  };

  if (!isConfigured()) {
    // No mail server: say exactly what would have been sent, minus the PIN.
    console.log(
      `[email] SMTP not configured — would have sent credentials for ${playerId} to ${maskEmail(to)} (PIN withheld from log)`,
    );
    return { sent: false, reason: "smtp-not-configured" };
  }

  try {
    await getTransport().sendMail(message);
    console.log(`[email] credentials sent for ${playerId} to ${maskEmail(to)}`);
    return { sent: true };
  } catch (err) {
    console.error(`[email] FAILED for ${playerId} to ${maskEmail(to)}: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}
