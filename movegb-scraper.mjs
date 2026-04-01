import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

console.log("[movegb] VERSION 4 scraper starting");

const MOVEGB_PIN = process.env.MOVEGB_PIN;
const MOVEGB_RECEPTION_LOGIN_URL =
  process.env.MOVEGB_RECEPTION_LOGIN_URL ||
  "https://www.movegb.com/business-reception/13709";
const MOVEGB_RECEPTION_ID = process.env.MOVEGB_RECEPTION_ID || "13064";
const HEADLESS = process.env.HEADLESS !== "false";

const OUTPUT_DIR = path.join(process.cwd(), "movegb-output");
const NAV_TIMEOUT = 30000;

if (!MOVEGB_PIN || !/^\d{4}$/.test(MOVEGB_PIN)) {
  console.error("[movegb] Missing or invalid MOVEGB_PIN");
  process.exit(1);
}

function log(msg, data) {
  if (data !== undefined) console.log(`[movegb] ${msg}`, data);
  else console.log(`[movegb] ${msg}`);
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
  const text = await page.locator("body").innerText().catch(() => "");
  await saveText(`${prefix}.txt`, text);
}

async function wait(page, ms = 2000) {
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  await page.waitForTimeout(ms);
}

function splitMember(value) {
  if (!value) return { member_name: null, postcode: null };

  const parts = value.split(",");
  return {
    member_name: parts[0]?.trim() || null,
    postcode: parts.slice(1).join(",").trim() || null,
  };
}

async function login(page) {
  log("Opening login page");
  await page.goto(MOVEGB_RECEPTION_LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });
  await wait(page);

  await saveArtifacts(page, "01-login");

  log(`Login page input count: ${await page.locator("input").count()}`);

  const pinCandidates = page.locator(
    'input[name*="pin" i], input[id*="pin" i], input[inputmode="numeric"], input[type="password"], input[type="text"]'
  );
  log(`PIN candidate count: ${await pinCandidates.count()}`);

  const input = pinCandidates.first();
  await input.waitFor({ state: "visible", timeout: NAV_TIMEOUT });
  await input.fill(MOVEGB_PIN);
  log("Filled PIN");

  const submit = page.locator(
    '#login-button, button[type="submit"], input[type="submit"], button, input[value*="submit" i]'
  ).first();

  await submit.waitFor({ state: "visible", timeout: NAV_TIMEOUT });

  await Promise.all([
    page.waitForNavigation({ timeout: NAV_TIMEOUT }).catch(() => null),
    submit.click(),
  ]);

  await wait(page, 2500);

  log(`After login URL: ${page.url()}`);
  await saveArtifacts(page, "02-after-login");
}

async function switchReception(page) {
  const url = `https://portal.movegb.com/business/switch-to-reception/${MOVEGB_RECEPTION_ID}`;
  log(`Switching reception to ${MOVEGB_RECEPTION_ID}`);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });
  await wait(page, 2500);

  log(`After switch URL: ${page.url()}`);
  await saveArtifacts(page, "03-after-switch");
}

async function extractBookings(page, label, url) {
  log(`Opening ${label}: ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });
  await wait(page, 3000);

  log(`${label}: current URL = ${page.url()}`);
  log(`${label}: title = ${await page.title()}`);

  await saveArtifacts(page, label);

  const rows = page.locator(
    "div.col12.clearfix.pad1y.keyline-light-bottom.mobile-cols"
  );
  const count = await rows.count();

  log(`${label}: rows found = ${count}`);

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
      raw_left: leftVals,
      raw_right: rightVals,
    };

    if (booking.member_name_postcode) {
      bookings.push(booking);
    }
  }

  log(`${label}: parsed = ${bookings.length}`);

  if (bookings.length > 0) {
    log(`${label}: first parsed booking`);
    console.log(JSON.stringify(bookings[0], null, 2));
  }

  await saveJson(`${label}.json`, bookings);

  return bookings;
}

async function main() {
  log("main: starting");
  await ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 1200 },
  });
  const page = await context.newPage();

  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("movegb.com")) {
      log(`response ${response.status()} ${url}`);
    }
  });

  try {
    await login(page);
    await switchReception(page);

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

    const output = {
      extracted_at: new Date().toISOString(),
      upcoming_count: upcoming.length,
      today_count: today.length,
      upcoming: normalize(upcoming, "upcoming"),
      today: normalize(today, "today"),
    };

    await saveJson("06-summary.json", output);

    log(`Done: upcoming=${upcoming.length}, today=${today.length}`);
  } catch (err) {
    console.error("[movegb] ERROR:", err);
    try {
      await saveArtifacts(page, "99-error");
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
