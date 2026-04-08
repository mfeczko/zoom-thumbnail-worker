import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

console.log("[movegb] VERSION 7 scraper starting");

const MOVEGB_PIN = process.env.MOVEGB_RECEPTION_PIN;
const MOVEGB_RECEPTION_LOGIN_URL =
  process.env.MOVEGB_RECEPTION_LOGIN_URL ||
  "https://www.movegb.com/reception/13064";

const MOVEGB_INGEST_URL = process.env.MOVEGB_INGEST_URL;
const MOVEGB_INGEST_SECRET = process.env.MOVEGB_INGEST_SECRET;

const HEADLESS = process.env.HEADLESS !== "false";

const OUTPUT_DIR = path.join(process.cwd(), "movegb-output");
const NAV_TIMEOUT = 30000;
const SHORT_TIMEOUT = 5000;
const RETRY_DELAY_MS = 2500;

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

async function saveText(filename, text) {
  await fs.writeFile(path.join(OUTPUT_DIR, filename), text, "utf8");
}

async function saveScreenshot(page, filename) {
  await page.screenshot({
    path: path.join(OUTPUT_DIR, filename),
    fullPage: true,
  });
}

async function saveArtifacts(page, prefix) {
  await Promise.allSettled([
    saveScreenshot(page, `${prefix}.png`),
    fs.writeFile(
      path.join(OUTPUT_DIR, `${prefix}.html`),
      await page.content(),
      "utf8"
    ),
    saveText(`${prefix}.url.txt`, page.url()),
  ]);
}

async function wait(page, ms = 2000) {
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  await page.waitForTimeout(ms);
}

async function withRetry(label, fn, attempts = 3) {
  let lastErr;

  for (let i = 1; i <= attempts; i++) {
    try {
      log(`${label}: attempt ${i}/${attempts}`);
      return await fn(i);
    } catch (err) {
      lastErr = err;
      log(`${label}: failed attempt ${i}/${attempts}`, {
        message: err?.message || String(err),
        name: err?.name || null,
      });

      if (i < attempts) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  throw lastErr;
}

async function attachDebugListeners(page) {
  page.on("console", (msg) => {
    log(`browser console [${msg.type()}]: ${msg.text()}`);
  });

  page.on("pageerror", (err) => {
    log(`pageerror: ${err.message}`);
  });

  page.on("requestfailed", (req) => {
    log(`requestfailed: ${req.method()} ${req.url()} ${req.failure()?.errorText || ""}`);
  });

  page.on("response", (res) => {
    if (res.status() >= 400) {
      log(`http ${res.status()}: ${res.url()}`);
    }
  });
}

async function dumpDiagnostics(page, prefix) {
  const visibleInputs = await page
    .locator("input:visible")
    .evaluateAll((els) =>
      els.map((el) => ({
        name: el.getAttribute("name"),
        id: el.getAttribute("id"),
        type: el.getAttribute("type"),
        inputmode: el.getAttribute("inputmode"),
        placeholder: el.getAttribute("placeholder"),
        maxlength: el.getAttribute("maxlength"),
      }))
    )
    .catch(() => []);

  const visibleButtons = await page
    .locator("button:visible, input[type=submit]:visible")
    .evaluateAll((els) =>
      els.map((el) => ({
        tag: el.tagName,
        id: el.getAttribute("id"),
        name: el.getAttribute("name"),
        text: (el.innerText || el.getAttribute("value") || "").trim(),
      }))
    )
    .catch(() => []);

  const visibleText = await page
    .locator("body")
    .innerText()
    .then((t) => t.slice(0, 5000))
    .catch(() => "");

  await saveJson(`${prefix}-diagnostics.json`, {
    url: page.url(),
    title: await page.title().catch(() => null),
    visibleInputs,
    visibleButtons,
    visibleText,
    timestamp: new Date().toISOString(),
  });

  await saveArtifacts(page, prefix);
}

async function safeGoto(page, url, label) {
  log(`Opening ${label}: ${url}`);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });

  await wait(page, 2500);
  await saveArtifacts(page, label);
}

async function isLoginPage(page) {
  const url = page.url().toLowerCase();

  if (url.includes("/reception/13064") || url.includes("/reception/")) {
    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();

    if (
      bodyText.includes("pin") ||
      bodyText.includes("enter pin") ||
      bodyText.includes("login") ||
      bodyText.includes("log in")
    ) {
      return true;
    }
  }

  const inputCount = await page.locator("input:visible").count().catch(() => 0);
  return inputCount > 0 && !page.url().includes("/reception/new/bookings");
}

async function isBookingsPage(page) {
  const url = page.url().toLowerCase();
  if (url.includes("/reception/new/bookings")) return true;

  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  return bodyText.includes("bookings");
}

async function findPinStrategy(page) {
  const selectors = [
    'input[name*="pin" i]:visible',
    'input[id*="pin" i]:visible',
    'input[autocomplete="one-time-code"]:visible',
    'input[inputmode="numeric"]:visible',
    'input[type="password"]:visible',
    'input[type="tel"]:visible',
    'input[type="text"]:visible',
  ];

  for (const selector of selectors) {
    const loc = page.locator(selector).first();

    try {
      await loc.waitFor({ state: "visible", timeout: 2500 });
      return { kind: "single", locator: loc, selector };
    } catch {}
  }

  const visibleInputs = page.locator("input:visible");
  const count = await visibleInputs.count().catch(() => 0);

  if (count >= 4) {
    const meta = await visibleInputs
      .evaluateAll((els) =>
        els.map((el) => ({
          maxlength: el.getAttribute("maxlength"),
          inputmode: el.getAttribute("inputmode"),
          type: el.getAttribute("type"),
        }))
      )
      .catch(() => []);

    const likely = meta
      .map((m, i) => ({ ...m, i }))
      .filter(
        (m) =>
          m.maxlength === "1" ||
          m.inputmode === "numeric" ||
          m.type === "tel"
      )
      .slice(0, 4);

    if (likely.length === 4) {
      return {
        kind: "four",
        locators: likely.map((m) => visibleInputs.nth(m.i)),
      };
    }
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
      return "clicked";
    } catch {}
  }

  await page.keyboard.press("Enter").catch(() => null);
  return "enter";
}

async function login(page) {
  await withRetry("login", async () => {
    await safeGoto(page, "https://www.movegb.com/logout", "00-logout");
    await safeGoto(page, MOVEGB_RECEPTION_LOGIN_URL, "01-login");

    const strategy = await findPinStrategy(page);

    if (!strategy) {
      await dumpDiagnostics(page, "login-no-pin-found");
      throw new Error("Could not find PIN input on login page");
    }

    if (strategy.kind === "single") {
      log(`PIN entry strategy: single (${strategy.selector})`);
      await strategy.locator.fill(MOVEGB_PIN);
    } else {
      log("PIN entry strategy: four inputs");
      for (let i = 0; i < 4; i++) {
        await strategy.locators[i].fill(MOVEGB_PIN[i]);
      }
    }

    const submitMode = await submitLogin(page);
    log(`Login submit mode: ${submitMode}`);

    await Promise.race([
      page.waitForURL(/\/reception\/new\/bookings|portal\.movegb\.com/i, {
        timeout: NAV_TIMEOUT,
      }).catch(() => null),
      page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT }).catch(() => null),
    ]);

    await wait(page, 3000);
    await saveArtifacts(page, "02-after-login");

    if (await isLoginPage(page)) {
      await dumpDiagnostics(page, "login-still-on-login");
      throw new Error("Login submitted but still appears to be on login page");
    }

    log(`After login URL: ${page.url()}`);
  });
}

async function ensureAuthenticated(page) {
  if (await isLoginPage(page)) {
    log("Detected login page; re-authenticating");
    await login(page);
  }
}

async function openBookingsPage(page, label, url) {
  await withRetry(`open-${label}`, async () => {
    await ensureAuthenticated(page);
    await safeGoto(page, url, label);

    if (await isLoginPage(page)) {
      log(`${label}: got bounced to login; retrying auth`);
      await login(page);
      await safeGoto(page, url, `${label}-after-relogin`);
    }

    if (!(await isBookingsPage(page))) {
      await dumpDiagnostics(page, `${label}-not-bookings`);
      throw new Error(`${label}: page did not look like bookings page`);
    }
  });
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

    const leftCount = await left.count();
    const rightCount = await right.count();

    const leftVals = [];
    const rightVals = [];

    for (let j = 0; j < leftCount; j++) {
      leftVals.push(cleanText(await left.nth(j).innerText().catch(() => "")));
    }

    for (let j = 0; j < rightCount; j++) {
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

  log(`${label}: parsed = ${bookings.length}`);
  await saveJson(`${label}.json`, bookings);

  if (count > 0 && bookings.length === 0) {
    await dumpDiagnostics(page, `${label}-rows-but-no-parsed-bookings`);
  }

  return bookings;
}

async function uploadToLovable(payload) {
  if (!MOVEGB_INGEST_URL || !MOVEGB_INGEST_SECRET) {
    log("Skipping Lovable upload (env vars not set)");
    return;
  }

  await withRetry("upload-to-lovable", async () => {
    log("Sending data to Lovable...");

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
  });
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 1200 },
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

    log(`Total bookings: ${allBookings.length}`);

    await uploadToLovable({
      source: "movegb",
      scraped_at: summary.scraped_at,
      bookings: allBookings,
    });

    log("Done");
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
