import { chromium } from 'playwright';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs";

// 1. Setup R2 using your existing Zoom naming conventions
const {
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  BOOKWHEN_EMAIL,
  BOOKWHEN_PASSWORD
} = process.env;

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    access_key_id: R2_ACCESS_KEY_ID,
    secret_access_key: R2_SECRET_ACCESS_KEY,
  },
});

async function runScraper() {
  console.log("🚀 Starting Precision Diagnostic Pipeline...");
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  
  try {
    // 2. Login Phase
    console.log("🔑 Navigating to Login...");
    await page.goto('https://bookwhen.com/login', { waitUntil: 'domcontentloaded' });

    console.log("🔎 Filling Business Login form...");
    // Diagnostic log (check lengths to ensure env vars are loading correctly)
    console.log(`Debug: Email length: ${BOOKWHEN_EMAIL?.length}, Password length: ${BOOKWHEN_PASSWORD?.length}`);

    // Using .trim() to ensure no hidden spaces around the '@' or email
    await page.fill('#admin_login_form_email', (BOOKWHEN_EMAIL || "").trim());
    await page.fill('#admin_login_form_password', (BOOKWHEN_PASSWORD || "").trim());
    
    console.log("🖱️ Clicking Submit...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => console.log("⚠️ Navigation timed out, checking page state...")),
      page.click('input[type="submit"]')
    ]);

    // Check if we actually left the login page
    const currentUrl = page.url();
    console.log(`📍 Current URL after login: ${currentUrl}`);

    if (currentUrl.includes('login')) {
      console.log("❌ Login failed. Checking for on-screen errors...");
      const errorText = await page.locator('.alert-danger').textContent().catch(() => "No error message found");
      console.log(`❗ Bookwhen says: ${errorText.trim()}`);
      throw new Error("Could not log in. Check credentials or bot detection.");
    }

    // 3. Navigation Phase
    console.log("📅 Success! Navigating to Attendances...");
    await page.goto('https://lungesinleggings.bookwhen.com/attendances', { waitUntil: 'networkidle' }); 

    // 4. Export Phase
    console.log("🖱️ Opening Options and Requesting CSV...");
    await page.click('button:has-text("Options")');
    await page.click('text="Export attendances (CSV)"');

    console.log("⏳ Waiting for report generation (up to 3 mins)...");
    const downloadButton = page.locator('a.btn-primary:has-text("Download")');
    await downloadButton.waitFor({ state: 'visible', timeout: 180000 });
    console.log("✅ Report ready!");

    // 5. Download & Upload Phase
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click()
    ]);
    
    const filePath = await download.path();
    const fileBuffer = fs.readFileSync(filePath);

    console.log("☁️ Uploading latest_attendance.csv to R2...");
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: 'latest_attendance.csv',
      Body: fileBuffer,
      ContentType: 'text/csv',
    }));

    console.log("🎉 Success! Pipeline complete.");

  } catch (error) {
    console.error("❌ Pipeline Failed:", error.message);
    process.exit(1); 
  } finally {
    await browser.close();
  }
}

runScraper();
