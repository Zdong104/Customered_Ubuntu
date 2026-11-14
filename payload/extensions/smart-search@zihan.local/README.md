# Quick Answers (smart-search@zihan.local)

Instant answers in the GNOME overview search: units (`36F`, `70mph`, `6'7`, `3斤`),
time zones and date math, currency, weather, `define <word>`, colours, hex, and
flight numbers.

## Inline flight status needs YOUR OWN API key

The extension ships **without** a key. Each user brings their own (free).

### Guided setup (recommended)

1. Search a flight number, e.g. `DL1847`. Without a key, the first Quick Answers
   row is **"Sign in free to show flight status"**.
2. Press Enter or click it. The overview closes and a setup dialog opens. It does
   not open the browser by itself: use its **Open sign-up page** button
   (https://rapid.aerodatabox.com/pricing).
3. Sign up or log in to RapidAPI, choose the **Basic** plan ($0 / month, about 200
   lookups a month) and click Subscribe.
4. Copy the `X-RapidAPI-Key` value (about 50 letters and numbers) from the
   Endpoints/Playground tab and paste it into the dialog. This is an API key from
   RapidAPI, **not** your computer password.
5. **Verify & save** checks the format locally, then makes ONE lookup for the flight
   you searched. If the key works it is saved to `~/.config/smart-search/aerodatabox.key`
   (created with mode 0600, written atomically), and the overview reopens on your
   search with the flight card. A 403 means the key is not subscribed to the Basic
   plan yet. A 401 means it was not copied correctly.

"Not now" closes the dialog. The setup row keeps showing for flight searches until
a key is saved.

### Manual fallback

```bash
mkdir -p ~/.config/smart-search
umask 077; nano ~/.config/smart-search/aerodatabox.key   # paste the key, save
chmod 600 ~/.config/smart-search/aerodatabox.key
```

The key file is personal data. It lives outside the extension folder, so copying,
packaging or publishing the extension never carries it along. Never put a key
inside this folder or in `config.example.json`.

Without a key, typing a flight number still gives rows that open Google's flight
card and FlightAware (below the setup row). The extension reloads the key file as soon as it changes,
with no relogin needed. Lookups stop at 190 per month (counter in
`~/.cache/smart-search/aerodatabox-usage.json`).

Other settings go in `~/.config/smart-search/config.json` (see `config.example.json`).
Changes are picked up live.

- `weatherCity`: city for a bare `weather` query (empty = the city of your system time zone).
- `currencyTargets`: currencies shown for `100 eur`-style queries with no target.
- `extraTimeZones`: extra zones for clock conversions such as `3pm PST` or
  `10:30 EST in CST`, e.g. `["Beijing"]` or `["Asia/Shanghai", "Europe/Berlin"]`
  (names the search understands, or IANA ids; unknown entries are skipped). Default
  none: `3pm PST` shows your local time plus UTC; with extra zones it shows local
  time plus those zones (at most three rows).
