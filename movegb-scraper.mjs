import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

console.log("[movegb] VERSION 2 scraper starting");

const MOVEGB_PIN = process.env.MOVEGB_PIN;
const MOVEGB_RECEPTION_LOGIN_URL =
  process.env.MOVEGB_RECEPTION_LOGIN_URL ||
  "https://www.movegb.com/business-reception/13709";
const MOVEGB_RECEPTION_ID = process.env.MOVEGB_RECEPTION_ID || "13064";
const HEADLESS = process.env.HEADLESS !== "false";

const OUTPUT_DIR = path.join(process.cwd(), "movegb-output");
const NAV_TIMEOUT = 30000;
const SHORT_WAIT_MS = 2000;

if (!MOVEGB_PIN || !/^\d{4}$/.test(MOVEGB_PIN)) {
  console.error("[movegb] Missing or invalid MOVEGB_PIN. Expected a 4 digit PIN.");
  process.exit(1);
}

function log(message, data) {
  if (data !== undefined) {
    console.log(`[movegb] ${message}`, data);
  } else {
    console.log(`[movegb] ${message}`);
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function saveText(filename, text) {
  await fs.writeFile(path.join(OUTPUT_DIR, filename), text, "utf8");
}

async function saveJson(filename, data) {
  await fs.writeFile(
    path.join(OUTPUT_DIR, filename),
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

async function saveScreenshot(page, filename) {
  await page.screenshot({
    path: path.join(OUTPUT_DIR, filename),
    fullPage: true,
  });
}

async function saveArtifacts(page, prefix) {
  await saveScreenshot(page, `${prefix}.png`);
  await saveText(`${prefix}.html`, await page.content());
  const bodyText = await page.locator("body").innerText().catch(() => "");
  await saveText(`${prefix}.txt`, bodyText);
}

async function waitForSettled(page, ms = SHORT_WAIT_MS) {
  await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT }).catch(() => null);
  await page.waitForTimeout(ms);
}

async function findFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible()) return locator;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

async function loginWithPin(page) {
  log(`Opening login page: ${MOVEGB_RECEPTION_LOGIN_URL}`);
  await page.goto(MOVEGB_RECEPTION_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });
  await waitForSettled(page);

  await saveArtifacts(page, "01-login-page");

  const pinInput = await findFirstVisible(page, [
    'input[name*="pin" i]',
    'input[id*="pin" i]',
    'input[inputmode="numeric"]',
    'input[type="password"]',
    'input[type="text"]',
  ]);

  if (!pinInput) {
    throw new Error("Could not find PIN input.");
  }

  await pinInput.fill(MOVEGB_PIN);
  log("Filled PIN");

  const submitButton = await findFirstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    '#login-button',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'input[value*="submit" i]',
  ]);

  if (!submitButton) {
    throw new Error("Could not find login submit button.");
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT }).catch(() => null),
    submitButton.click(),
  ]);

  await waitForSettled(page, 2500);

  log(`URL after login: ${page.url()}`);
  await saveArtifacts(page, "02-after-login");
}

async function switchReception(page) {
  const url = `https://portal.movegb.com/business/switch-to-reception/${MOVEGB_RECEPTION_ID}`;
  log(`Switching to reception ${MOVEGB_RECEPTION_ID}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });
  await waitForSettled(page, 2500);

  log(`URL after switch: ${page.url()}`);
  await saveArtifacts(page, "03-after-switch");
}

function looksUsefulBookingText(text) {
  return /bookings|confirmed|cancelled|attended|venue|class|member|today|upcoming|\d{1,2}:\d{2}|\bapr\b|\bmay\b|\bjun\b|\bjul\b/i.test(
    text
  );
}

function parseBookingTextBlock(text) {
  const lines = text
    .split(/\n+/)
    .map(cleanText)
    .filter(Boolean);

  if (lines.length < 3) return null;

  const joined = lines.join(" | ");

  const booking = {
    venue: null,
    member_name_postcode: null,
    class_name: null,
    class_time: null,
    type: null,
    status: null,
    attended: null,
    raw_text: joined,
    raw_lines: lines,
  };

  // Heuristic based on screenshot structure:
  // venue, member name/postcode, class name, class time, type, status, attended
  if (lines.length >= 6) {
    booking.venue = lines[0] || null;
    booking.member_name_postcode = lines[1] || null;
    booking.class_name = lines[2] || null;
    booking.class_time = lines[3] || null;
    booking.type = lines[4] || null;
    booking.status = lines[5] || null;
    booking.attended = lines[6] || null;
  }

  return booking;
}

async function extractUsingTable(page, label) {
  const rows = page.locator("table tbody tr");
  const rowCount = await rows.count();
  log(`${label}: table row count = ${rowCount}`);

  const bookings = [];

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const cells = row.locator("td");
    const cellCount = await cells.count();
    const values = [];

    for (let j = 0; j < cellCount; j++) {
      values.push(cleanText(await cells.nth(j).innerText()));
    }

    if (values.length > 0) {
      bookings.push({
        source: "table",
        venue: values[0] || null,
        member_name_postcode: values[1] || null,
        class_name: values[2] || null,
        class_time: values[3] || null,
        type: values[4] || null,
        status: values[5] || null,
        attended: values[6] || null,
        raw_cells: values,
      });
    }
  }

  return bookings;
}

async function extractUsingCandidateSelectors(page, label) {
  const candidateSelectors = [
    '[class*="booking"]',
    '[class*="Booking"]',
    '[class*="bookings"]',
    '[class*="row"]',
    '[class*="Row"]',
    "main section div",
    "main .container div",
    ".container div",
    "article div",
    "li",
  ];

  for (const selector of candidateSelectors) {
    const nodes = page.locator(selector);
    const count = await nodes.count();

    if (count === 0) continue;

    log(`${label}: selector "${selector}" matched ${count} nodes`);

    const samples = [];
    for (let i = 0; i < Math.min(count, 30); i++) {
      const text = cleanText(await nodes.nth(i).innerText().catch(() => ""));
      if (text && looksUsefulBookingText(text)) {
        samples.push(text);
      }
    }

    if (samples.length === 0) continue;

    log(`${label}: selector "${selector}" produced ${samples.length} useful samples`);

    const parsed = [];
    for (const sample of samples.slice(0, 20)) {
      const parsedBlock = parseBookingTextBlock(sample);
      if (parsedBlock) {
        parsed.push({
          source: selector,
          ...parsedBlock,
        });
      } else {
        parsed.push({
          source: selector,
          raw_text: sample,
        });
      }
    }

    if (parsed.length > 0) {
      parsed.slice(0, 5).forEach((item, idx) => {
        console.log(`[movegb] ${label} sample ${idx + 1}: ${JSON.stringify(item)}`);
      });
      return parsed;
    }
  }

  return [];
}

async function extractBookings(page, label, url) {
  log(`Opening ${label}: ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });

  await waitForSettled(page, 3000);

  log(`${label}: current URL after load = ${page.url()}`);
  log(`${label}: title = ${await page.title()}`);

  await saveArtifacts(page, label);

  const bodyTextRaw = await page.locator("body").innerText().catch(() => "");
  const bodyText = cleanText(bodyTextRaw);

  log(`${label}: body length = ${bodyText.length}`);
  log(`${label}: first 500 chars = ${bodyText.slice(0, 500)}`);

  let bookings = await extractUsingTable(page, label);

  if (bookings.length === 0) {
    bookings = await extractUsingCandidateSelectors(page, label);
  }

  await saveJson(`${label}.json`, {
    label,
    url,
    extractedAt: new Date().toISOString(),
    bookingCount: bookings.length,
    bookings,
  });

  log(`${label}: parsed bookings = ${bookings.length}`);

  if (bookings.length === 0) {
    log(`${label}: no structured bookings found; artifacts saved for debugging`);
  }

  return bookings;
}

async function main() {
  log("main: starting");
  await ensureDir(OUTPUT_DIR);
  log("main: output dir ready");

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  log("main: browser launched");

  const context = await browser.newContext({
    viewport: { width: 1400, height: 1200 },
  });
  log("main: context created");

  const page = await context.newPage();
  log("main: page created");

  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("movegb.com")) {
      log(`response ${response.status()} ${url}`);
    }
  });

  try {
    log("main: before loginWithPin");
    await loginWithPin(page);
    log("main: after loginWithPin");

    log("main: before switchReception");
    await switchReception(page);
    log("main: after switchReception");

    log("main: before upcoming extraction");
    const upcomingBookings = await extractBookings(
      page,
      "04-upcoming-bookings",
      "https://portal.movegb.com/reception/new/bookings"
    );
    log("main: after upcoming extraction");

    log("main: before today extraction");
    const todaysBookings = await extractBookings(
      page,
      "05-todays-bookings",
      "https://portal.movegb.com/reception/new/bookings?all=1"
    );
    log("main: after today extraction");

    await saveJson("06-summary.json", {
      extractedAt: new Date().toISOString(),
      upcomingCount: upcomingBookings.length,
      todayCount: todaysBookings.length,
      upcomingBookings,
      todaysBookings,
    });

    log(`Done. Upcoming = ${upcomingBookings.length}, Today = ${todaysBookings.length}`);
  } catch (error) {
    console.error("[movegb] FAILED:", error);
    try {
      await saveArtifacts(page, "99-error");
    } catch {}
    process.exit(1);
  } finally {
    log("main: closing browser");
    await browser.close();
    log("main: browser closed");
  }
}

main();
