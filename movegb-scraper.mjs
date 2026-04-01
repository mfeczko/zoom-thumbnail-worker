import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

console.log("[movegb] VERSION 3 scraper starting");

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
  if (data) console.log(`[movegb] ${msg}`, data);
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

async function login(page) {
  log("Opening login page");
  await page.goto(MOVEGB_RECEPTION_LOGIN_URL, { timeout: NAV_TIMEOUT });
  await wait(page);

  await saveArtifacts(page, "01-login");

  const input = page.locator("input").first();
  await input.fill(MOVEGB_PIN);

  const submit = page.locator("button, input[type=submit]").first();

  await Promise.all([
    page.waitForNavigation({ timeout: NAV_TIMEOUT }).catch(() => null),
    submit.click(),
  ]);

  await wait(page);

  log(`After login URL: ${page.url()}`);
  await saveArtifacts(page, "02-after-login");
}

async function switchReception(page) {
  const url = `https://portal.movegb.com/business/switch-to-reception/${MOVEGB_RECEPTION_ID}`;
  log("Switching reception");

  await page.goto(url, { timeout: NAV_TIMEOUT });
  await wait(page);

  log(`After switch URL: ${page.url()}`);
  await saveArtifacts(page, "03-after-switch");
}

function splitMember(value) {
  if (!value) return { member_name: null, postcode: null };

  const parts = value.split(",");
  return {
    member_name: parts[0]?.trim() || null,
    postcode: parts[1]?.trim() || null,
  };
}

async function extractBookings(page, label, url) {
  log(`Opening ${label}`);
  await page.goto(url, { timeout: NAV_TIMEOUT });
  await wait(page, 3000);

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
      leftVals.push(cleanText(await left.nth(j).innerText()));
    }

    for (let j = 0; j < rightCount; j++) {
      rightVals.push(cleanText(await right.nth(j).innerText()));
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
      bookings.push(booking);
    }
  }

  log(`${label}: parsed = ${bookings.length}`);

  await saveJson(`${label}.json`, bookings);

  return bookings;
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

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
        };
      });

    const output = {
      upcoming: normalize(upcoming, "upcoming"),
      today: normalize(today, "today"),
    };

    await saveJson("06-summary.json", output);

    log(`Done: upcoming=${upcoming.length}, today=${today.length}`);
  } catch (err) {
    console.error("[movegb] ERROR:", err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
