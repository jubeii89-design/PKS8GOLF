# Building your own signup page

The signup page can live anywhere — your main site, a landing page, whatever
you build. It only needs to talk to two endpoints on the relay, and it never
touches card details: you hand the player to Square's own checkout and the
relay does the rest.

The bundled page at `/signup/` is a working reference; copy from it or ignore
it entirely.

## What your page has to do

1. **Ask the relay what the entry costs** so the price on your page can never
   drift from the price actually charged.
2. **Post a name and email**, get back a checkout URL.
3. **Send the browser to that URL.**

That is the whole integration. Everything after it — confirming the payment,
minting the PIN, emailing it, showing it on the return screen — already
happens without your page's involvement.

## The two endpoints

Base URL is wherever you run the relay, e.g. `https://relay.strategictitans.ca`.

### `GET /tournament`

```json
{
  "tournament": {
    "name": "Strategic Titans Charity Cup",
    "charity": "the Children's Hospital",
    "date": "Saturday 12 October 2026",
    "teeOff": "9:00 AM",
    "contact": "www.strategictitans.ca"
  },
  "entryFeeCents": 2500,
  "currency": "CAD",
  "acceptingSignups": true
}
```

`acceptingSignups` is `false` until Square is configured. When it is false,
show a "not open yet" message rather than a form that cannot work.

Format the price from `entryFeeCents` and `currency` rather than writing it
into your HTML:

```js
new Intl.NumberFormat(undefined, { style: "currency", currency }).format(entryFeeCents / 100);
```

### `POST /signup`

```json
{ "name": "Gordon Stitt", "email": "gordon@example.com" }
```

On success:

```json
{ "playerId": "GORDONSTITT0001", "checkoutUrl": "https://square.link/u/..." }
```

Send the browser to `checkoutUrl`. Do not show `playerId` as if it were a
credential — it is only half of one, and the PIN does not exist yet.

Every failure returns `{ "error": "..." }` with a message written for the
player. Show it as-is:

| Status | Means |
|---|---|
| `400` | Name or email failed validation |
| `409` | That email is already registered |
| `429` | Too many attempts from this address |
| `502` | Square could not be reached — they should try again shortly |
| `503` | Signups are not open (Square not configured) |

## A minimal working page

```html
<form id="signup">
  <input name="name" placeholder="Full name" required maxlength="60" />
  <input name="email" type="email" placeholder="Email address" required />
  <button type="submit">Enter</button>
  <p id="error" hidden></p>
</form>

<script type="module">
  const RELAY = "https://relay.strategictitans.ca";
  const form = document.getElementById("signup");
  const error = document.getElementById("error");
  const button = form.querySelector("button");

  // Price and details come from the relay so they cannot drift.
  const info = await (await fetch(`${RELAY}/tournament`)).json();
  if (!info.acceptingSignups) {
    form.hidden = true;
  } else {
    const price = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: info.currency,
    }).format(info.entryFeeCents / 100);
    button.textContent = `Pay ${price} and enter`;
  }

  let submitting = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitting) return;          // a double tap must not create two orders
    submitting = true;
    button.disabled = true;
    error.hidden = true;

    try {
      const res = await fetch(`${RELAY}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.value.trim(),
          email: form.email.value.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.checkoutUrl) throw new Error(body.error ?? "Something went wrong.");
      window.location.href = body.checkoutUrl;   // Square takes it from here
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      button.disabled = false;
      submitting = false;
    }
  });
</script>
```

## Two settings to get right

**`PLAY_URL`** (on the relay) is where Square returns the player after paying —
the **game**, not your signup page. That return screen shows their Player ID
and PIN, so pointing it anywhere else loses them.

**`VITE_SIGNUP_URL`** (when building the game) is where the game's "Not entered
yet?" links point. Set it to your page:

```bash
VITE_RELAY_URL=https://relay.strategictitans.ca \
VITE_SIGNUP_URL=https://www.strategictitans.ca/tournament-signup \
npm run build
```

## When your page's home is settled

Set `ALLOWED_ORIGINS` on the relay to the sites that may call it:

```bash
ALLOWED_ORIGINS="https://www.strategictitans.ca,https://strategictitans.ca"
```

Unset, any site may call it — fine while things are moving around, less fine
once they are not, since each signup creates a real Square order on your
account. Note this must list the origin of the **game** too if it is served
from a different domain than your signup page.

## What you do not have to build

- Anything touching card details. Square's hosted page takes them; they never
  reach your page, the game, or the relay.
- Generating Player IDs or PINs — the relay mints both.
- Confirming payment — Square's webhook does, and it is refused unless the
  signature verifies.
- Delivering credentials — emailed, and shown on the return screen.
- Checking whether someone paid before letting them play — `/join` does.
