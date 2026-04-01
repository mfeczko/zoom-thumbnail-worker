import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const MOVEGB_PIN = process.env.MOVEGB_PIN;
const MOVEGB_RECEPTION_LOGIN_URL =
  process.env.MOVEGB_RECEPTION_LOGIN_URL ||
  "https://www.movegb.com/business-reception/13709";
const MOVEGB_RECEPTION_ID = process.env.MOVEGB_RECEPTION_ID || "13064";
const HEADLESS = process.env.HEADLESS !== "false";

if (!MOVEGB_PIN || !/^\d{4}$/.test(MOVEGB_PIN)) {
  console.error("Missing or invalid MOVEGB_PIN. Expected a 4 digit PIN.");
  process.exit(1);
}

const OUTPUT_DIR = path.join(process.cwd(), "movegb-output");

function log(message, data) {
  if (data !== undefined) {
    console.log(`[movegb] ${message}`, data);
  } else {
    console.log(`[movegb] ${message}`);
  }
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

function cleanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

async function loginWithPin(page) {
  log(`Opening login page: ${MOVEGB_RECEPTION_LOGIN_URL}`);
  await page.goto(MOVEGB_RECEPTION_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await saveScreenshot(page, "01-login-page.png");

  const pinInput = page.locator('input[type="password"], input[type="text"], input[inputmode="numeric"]').first();
  await pinInput.fill(MOVEGB_PIN);
  log("Filled PIN");

  const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Log in")').first();

  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null),
    submit.click(),
  ]);

  log(`URL after login: ${page.url()}`);
  await saveScreenshot(page, "02-after-login.png");
  await saveText("02-after-login.html", await page.content());
}

async function switchReception(page) {
  const switchUrl = `https://portal.movegb.com/business/switch-to-reception/${MOVEGB_RECEPTION_ID}`;
  log(`Switching to reception ${MOVEGB_RECEPTION_ID}`);
  await page.goto(switchUrl, {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  log(`URL after switch: ${page.url()}`);
  await saveScreenshot(page, "03-after-switch.png");
}

async function extractBookings(page, label, url) {
  log(`Opening ${label}: ${url}`);
  await page.goto(url, {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  await saveScreenshot(page, `${label}.png`);
  await saveText(`${label}.html`, await page.content());

  const tables = page.locator("table");
  const tableCount = await tables.count();
  log(`${label}: table count = ${tableCount}`);

  const rows = page.locator("table tbody tr");
  const rowCount = await rows.count();
  log(`${label}: row count = ${rowCount}`);

  const bookings = [];

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const cells = row.locator("td");
    const cellCount = await cells.count();

    const values = [];
    for (let j = 0; j < cellCount; j++) {
      values.push(cleanText(await cells.nth(j).innerText()));
    }

    if (values.length === 0) continue;

    const booking = {
      venue: values[0] || null,
      member_name_postcode: values[1] || null,
      class_name: values[2] || null,
      class_time: values[3] || null,
      type: values[4] || null,
      status: values[5] || null,
      attended: values[6] || null,
      raw_cells: values,
    };

    bookings.push(booking);
  }

  await saveJson(`${label}.json`, {
    label,
    url,
    extractedAt: new Date().toISOString(),
    rowCount,
    bookings,
  });

  log(`${label}: parsed bookings = ${bookings.length}`);

  if (bookings.length > 0) {
    log(`${label}: first 5 bookings`);
    for (const booking of bookings.slice(0, 5)) {
      console.log(JSON.stringify(booking, null, 2));
    }
  } else {
    const bodyText = cleanText(await page.locator("body").innerText());
    await saveText(`${label}.txt`, bodyText);
    log(`${label}: no bookings parsed, saved page text for debugging`);
  }

  return bookings;
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("movegb.com")) {
      log(`response ${response.status()} ${url}`);
    }
  });

  try {
    await loginWithPin(page);
    await switchReception(page);

    const upcomingBookings = await extractBookings(
      page,
      "04-upcoming-bookings",
      "https://portal.movegb.com/reception/new/bookings"
    );

    const todaysBookings = await extractBookings(
      page,
      "05-todays-bookings",
      "https://portal.movegb.com/reception/new/bookings?all=1"
    );

    log(`Done. Upcoming = ${upcomingBookings.length}, Today = ${todaysBookings.length}`);
  } catch (error) {
    console.error("[movegb] FAILED:", error);
    try {
      await saveScreenshot(page, "99-error.png");
      await saveText("99-error.html", await page.content());
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
