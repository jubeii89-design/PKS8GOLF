/**
 * Tournament signup page.
 *
 * Collects a name and an email, asks the relay for a Square checkout page, and
 * sends the player there. No card details are handled here or anywhere else in
 * this codebase — Square's own page takes them, which is the point of using a
 * hosted checkout.
 *
 * Credentials are not shown on screen: they are emailed once payment clears,
 * so that what a player can play with matches what they have actually paid for.
 */

import { RELAY_URL, hasRelay, relayEndpoint } from "../game/relay.js";
import { mountCourseBackground } from "../ui/courseBackground.js";
import { setAssetBase } from "../ui/assetBase.js";
import "../ui/styles.css";
import "./signup.css";

setAssetBase("../"); // this entry lives one level under the site root, at /signup/

interface TournamentInfo {
  tournament: { name: string; charity: string; date: string; teeOff: string; contact: string };
  entryFeeCents: number;
  currency: string;
  acceptingSignups: boolean;
}

const root = document.getElementById("signup")!;
const bg = document.getElementById("bg");
if (bg) mountCourseBackground(bg);

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Nothing to sign up to without a relay — say so rather than showing a dead form. */
function renderUnavailable(message: string): void {
  root.replaceChildren();
  const card = el("div", "signup-card");
  card.append(
    el("h1", "signup-title", "Signups are not open"),
    el("p", "signup-note", message),
    Object.assign(el("a", "signup-back", "Back to the game"), { href: "../play/" }),
  );
  root.appendChild(card);
}

function renderForm(info: TournamentInfo): void {
  root.replaceChildren();
  const { tournament } = info;

  const card = el("div", "signup-card");
  card.append(
    el("p", "signup-eyebrow", "Strategic Titans presents"),
    el("h1", "signup-title", tournament.name),
    el("p", "signup-sub", `Entry ${money(info.entryFeeCents, info.currency)} — supporting ${tournament.charity}`),
  );

  const details = el("dl", "signup-details");
  for (const [label, value] of [
    ["When", tournament.date],
    ["Tee-off", tournament.teeOff],
    ["Format", "18 hands, one round"],
  ]) {
    details.append(el("dt", undefined, label), el("dd", undefined, value));
  }
  card.appendChild(details);

  const form = el("form", "signup-form");
  const nameInput = el("input", "signup-input");
  nameInput.type = "text";
  nameInput.name = "name";
  nameInput.placeholder = "Full name";
  nameInput.autocomplete = "name";
  nameInput.required = true;
  nameInput.maxLength = 60;

  const emailInput = el("input", "signup-input");
  emailInput.type = "email";
  emailInput.name = "email";
  emailInput.placeholder = "Email address";
  emailInput.autocomplete = "email";
  emailInput.required = true;

  const submit = el("button", "signup-submit");
  submit.type = "submit";
  submit.textContent = `Pay ${money(info.entryFeeCents, info.currency)} and enter`;

  const error = el("p", "signup-error");
  error.hidden = true;

  form.append(
    labelled("Your name", nameInput),
    labelled("Your email", emailInput),
    el(
      "p",
      "signup-note",
      "We'll email your Player ID and PIN as soon as your payment clears. You need both to play.",
    ),
    error,
    submit,
  );

  let submitting = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = "Setting up payment…";

    try {
      const res = await fetch(relayEndpoint("/signup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameInput.value.trim(), email: emailInput.value.trim() }),
      });
      const body = (await res.json()) as { checkoutUrl?: string; error?: string };
      if (!res.ok || !body.checkoutUrl) {
        throw new Error(body.error ?? "Something went wrong. Please try again.");
      }
      // Square's hosted page takes it from here.
      window.location.href = body.checkoutUrl;
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = `Pay ${money(info.entryFeeCents, info.currency)} and enter`;
      submitting = false;
    }
  });

  card.appendChild(form);
  card.appendChild(Object.assign(el("a", "signup-back", "Back to the game"), { href: "../play/" }));
  root.appendChild(card);
}

function labelled(text: string, input: HTMLElement): HTMLElement {
  const wrap = el("label", "signup-field");
  wrap.append(el("span", "signup-label", text), input);
  return wrap;
}

async function main(): Promise<void> {
  if (!hasRelay()) {
    renderUnavailable(
      "This site was built without a tournament server, so entries cannot be taken here yet.",
    );
    return;
  }
  try {
    const res = await fetch(relayEndpoint("/tournament"));
    if (!res.ok) throw new Error(String(res.status));
    const info = (await res.json()) as TournamentInfo;
    if (!info.acceptingSignups) {
      renderUnavailable("Entries are not open yet. Please check back closer to the event.");
      return;
    }
    renderForm(info);
  } catch {
    renderUnavailable(`Could not reach the tournament server (${RELAY_URL}). Please try again shortly.`);
  }
}

void main();
