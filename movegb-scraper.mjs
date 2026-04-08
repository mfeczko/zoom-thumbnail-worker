import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

console.log("[movegb] VERSION 9 scraper starting");

const MOVEGB_PIN = process.env.MOVEGB_RECEPTION_PIN;
const MOVEGB_RECEPTION_LOGIN_URL =
  process.env.MOVEGB_RECEPTION_LOGIN_URL ||
  "https://www.movegb.com/reception/13064";

const MOVEGB_INGEST_URL = process.env.MOVEGB_INGEST_URL;
const MOVEGB_INGEST_SECRET = process.env.MOVEGB_INGEST_SECRET;

const HEADLESS = process.env.HEADLESS !== "false";

const OUTPUT_DIR = path.join(process.cwd(), "movegb-output");
const NAV_TIMEOUT = 30000;

if (!MOVEGB_PIN || !/^\d{4}$/.test(MOVEGB_PIN)) {
  console.error("[movegb] Missing or invalid MOVEGB_RECEPTION_PIN");
  process.exit(1);
}

function log(msg, data) {
  if (data !== undefined) console.log(`[movegb] ${msg}`, data);
  else console.log(`[movegb] ${msg}`);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function splitMember(value) {
  if (!value) return { member_name: null, postcode: null };
  const parts = value.split(",");
  return {
    member_name: parts[0]?.trim() || null,
    postcode: parts.slice(1).join(",").trim() || null,
  };
}

function buildExternalKey(b) {
  return `${b.member_name_postcode}|${b.class_name}|${b.class_time}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function saveJson(filename, data) {
  await fs.writeFile(
    path.join(OUTPUT_DIR, filename),
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

async function saveArtifacts(page, prefix) {
  await Promise.allSettled([
    page.screenshot({
      path: path.join(OUTPUT_DIR, `${prefix}.png`),
      fullPage: true,
    }),
    fs.writeFile(
      path.join(OUTPUT_DIR, `${prefix}.html`),
      await page.content(),
      "utf8"
    ),
  ]);
}

async function wait(page, ms = 2000) {
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  await page.waitForTimeout(ms);
}

async function attachDebugListeners(page) {
  page.on("response", (res) => {
    const url = res.url();
    const status = res.status();
    if (
      status >= 400 &&
      (url.includes("movegb.com") || url.includes("challenges.cloudflare.com"))
    ) {
      log(`http ${status}: ${url}`);
    }
  });

  page.on("pageerror", (err) => {
    log(`pageerror: ${err.message}`);
  });
}

async function dumpDiagnostics(page, prefix) {
  const bodyText = await page
    .locator("body")
    .innerText()
    .then((t) => t.slice(0, 4000))
    .catch(() => "");

  const visibleInputs = await page
    .locator("input:visible")
    .evaluateAll((els) =>
      els.map((el) => ({
        name: el.getAttribute("name"),
        id: el.getAttribute("id"),
        type: el.getAttribute("type"),
        inputmode: el.getAttribute("inputmode"),
        maxlength: el.getAttribute("maxlength"),
        placeholder: el.getAttribute("placeholder"),
      }))
    )
    .catch(() => []);

  await saveJson(`${prefix}-diagnostics.json`, {
    url: page.url(),
    title: await page.title().catch(() => null),
    bodyText,
    visibleInputs,
    timestamp: new Date().toISOString(),
  });

  await saveArtifacts(page, prefix);
}

async function goto(page, url, label) {
  log(`Opening ${label}: ${url}`);

  const res = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });

  await wait(page, 2500);
  await saveArtifacts(page, label);

  return res;
}

async function looksBlocked(page) {
  const url = page.url().toLowerCase();
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();

  return (
    url.includes("challenges.cloudflare.com") ||
    bodyText.includes("cloudflare") ||
    bodyText.includes("verify you are human") ||
    bodyText.includes("attention required") ||
    bodyText.includes("access denied") ||
    bodyText.includes("forbidden")
  );
}

async function findPinInput(page) {
  const selectors = [
    'input[name*="pin" i]:visible',
    'input[id*="pin" i]:visible',
    'input[inputmode="numeric"]:visible',
    'input[type="password"]:visible',
    'input[type="tel"]:visible',
    'input[type="text"]:visible',
  ];

  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try {
      await loc.waitFor({ state: "visible", timeout: 3000 });
      return { kind: "single", locator: loc, selector };
    } catch {}
  }

  return null;
}

async function submitLogin(page) {
  const candidates = [
    page.getByRole("button", { name: /log.?in|login|continue|submit|enter/i }).first(),
    page.locator("#login-button").first(),
    page.locator('button[type="submit"]:visible').first(),
    page.locator('input[type="submit"]:visible').first(),
  ];

  for (const candidate of candidates) {
    try {
      await candidate.click({ timeout: 2500 });
      return;
    } catch {}
  }

  await page.keyboard.press("Enter").catch(() => null);
}

async function login(page) {
  const res = await goto(page, MOVEGB_RECEPTION_LOGIN_URL, "01-login");

  if (res && res.status() >= 400) {
    await dumpDiagnostics(page, "login-http-error");
    throw new Error(`Login page returned HTTP ${res.status()}`);
  }

  if (await looksBlocked(page)) {
    await dumpDiagnostics(page, "login-blocked");
    throw new Error("Blocked before PIN entry");
  }

  const pinInput = await findPinInput(page);

  if (!pinInput) {
    await dumpDiagnostics(page, "login-no-pin");
    throw new Error("Could not find PIN input");
  }

  log(`PIN entry strategy: single (${pinInput.selector})`);
  await pinInput.locator.fill(MOVEGB_PIN);

  await submitLogin(page);
  log("Login submit mode: clicked-or-enter");

  await Promise.race([
    page.waitForURL(/\/reception\/new\/bookings|portal\.movegb\.com/i, {
      timeout: NAV_TIMEOUT,
    }).catch(() => null),
    page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT }).catch(() => null),
  ]);

  await wait(page, 3000);
  await saveArtifacts(page, "02-after-login");

  if (await looksBlocked(page)) {
    await dumpDiagnostics(page, "after-login-blocked");
    throw new Error("Blocked after PIN submit");
  }
}

async function ensureAuthenticated(page) {
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  const onLoginPage =
    bodyText.includes("pin") || bodyText.includes("login") || bodyText.includes("log in");

  if (onLoginPage) {
    await login(page);
  }
}

async function openBookingsPage(page, label, url) {
  await ensureAuthenticated(page);

  const res = await goto(page, url, label);

  if (res && res.status() >= 400) {
    await dumpDiagnostics(page, `${label}-http-error`);
    throw new Error(`${label} returned HTTP ${res.status()}`);
  }

  if (await looksBlocked(page)) {
    await dumpDiagnostics(page, `${label}-blocked`);
    throw new Error(`${label} blocked`);
  }
}

async function extractBookings(page, label, url) {
  await openBookingsPage(page, label, url);

  const rows = page.locator(
    "div.col12.clearfix.pad1y.keyline-light-bottom.mobile-cols"
  );

  const count = await rows.count();
  log(`${label}: rows = ${count}`);

  const bookings = [];

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const left = row.locator("> div.col8.hide-mobile > div");
    const right = row.locator("> div.col4.hide-mobile > div");

    const leftVals = [];
    const rightVals = [];

    for (let j = 0; j < await left.count(); j++) {
      leftVals.push(cleanText(await left.nth(j).innerText().catch(() => "")));
    }

    for (let j = 0; j < await right.count(); j++) {
      rightVals.push(cleanText(await right.nth(j).innerText().catch(() => "")));
    }

    const booking = {
      venue: leftVals[0] || null,
      member_name_postcode: leftVals[1] || null,
      class_name: leftVals[2] || null,
      class_time: leftVals[3] || null,
      type: rightVals[0] || null,
      status: rightVals[1] || null,
      attended: rightVals[2] || null,
    };

    if (booking.member_name_postcode) {
      booking.external_key = buildExternalKey(booking);
      bookings.push(booking);
    }
  }

  await saveJson(`${label}.json`, bookings);
  return bookings;
}

async function uploadToLovable(payload) {
  if (!MOVEGB_INGEST_URL || !MOVEGB_INGEST_SECRET) {
    log("Skipping Lovable upload (env vars not set)");
    return;
  }

  const res = await fetch(MOVEGB_INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MOVEGB_INGEST_SECRET}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  log(`Lovable response status: ${res.status}`);
  log(`Lovable response: ${text}`);

  if (!res.ok) {
    throw new Error(`Lovable upload failed with status ${res.status}`);
  }
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 1200 },
    locale: "en-GB",
    timezoneId: "Europe/London",
  });

  const page = await context.newPage();
  await attachDebugListeners(page);

  try {
    await login(page);

    const upcoming = await extractBookings(
      page,
      "04-upcoming",
      "https://portal.movegb.com/reception/new/bookings"
    );

    const today = await extractBookings(
      page,
      "05-today",
      "https://portal.movegb.com/reception/new/bookings?all=1"
    );

    const normalize = (list, source) =>
      list.map((b) => {
        const split = splitMember(b.member_name_postcode);
        return {
          external_key: b.external_key,
          source,
          venue: b.venue,
          member_name: split.member_name,
          postcode: split.postcode,
          class_name: b.class_name,
          class_time: b.class_time,
          type: b.type,
          status: b.status,
          attended: b.attended,
          raw_row: b,
        };
      });

    const allBookings = uniqBy(
      [...normalize(upcoming, "upcoming"), ...normalize(today, "today")],
      (b) => `${b.source}|${b.external_key}`
    );

    const summary = {
      scraped_at: new Date().toISOString(),
      count: allBookings.length,
      upcoming_count: upcoming.length,
      today_count: today.length,
      bookings: allBookings,
    };

    await saveJson("06-summary.json", summary);

    await uploadToLovable({
      source: "movegb",
      scraped_at: summary.scraped_at,
      bookings: allBookings,
    });

    log(`Done: ${allBookings.length} bookings`);
  } catch (err) {
    console.error("[movegb] ERROR:", err);

    await dumpDiagnostics(page, "99-fatal").catch(() => null);
    await saveJson("99-error.json", {
      message: err?.message || String(err),
      name: err?.name || null,
      stack: err?.stack || null,
      url: page.url(),
      timestamp: new Date().toISOString(),
    }).catch(() => null);

    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
