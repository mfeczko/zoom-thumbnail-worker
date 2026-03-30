import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs";

chromium.use(stealth()); // 🛡️ Adds stealth to hide automation traces

const {
  R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  R2_BUCKET, BOOKWHEN_EMAIL, BOOKWHEN_PASSWORD
} = process.env;

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

async function runScraper() {
  console.log("🚀 Starting Stealth Pipeline...");
  const browser = await chromium.launch({ 
    headless: true, 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
  });
  
  // Set a realistic User Agent so we don't look like a script
  const context = await browser.newContext({ 
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  try {
    console.log("🔑 Navigating to Login...");
    await page.goto('https://bookwhen.com/login', { waitUntil: 'networkidle' });

    // Wait for EITHER the email box OR a sign that we are blocked
    console.log("🔎 Looking for login fields...");
    try {
        await page.waitForSelector('#user_email', { timeout: 15000 });
    } catch (e) {
        console.log("⚠️ Could not find login box. Taking a screenshot for debug...");
        await page.screenshot({ path: '/tmp/error.png' });
        // If we can't find it, the page might be showing a Cloudflare challenge
        throw new Error("Login page didn't load correctly. Possible bot detection.");
    }

    await page.fill('#user_email', BOOKWHEN_EMAIL); 
    await page.fill('#user_password', BOOKWHEN_PASSWORD);
    await page.click('input[type="submit"]');
    await page.waitForNavigation();

    console.log("📅 Success! Logged in. Navigating to Attendances...");
    await page.goto('https://lungesinleggings.bookwhen.com/attendances', { waitUntil: 'networkidle' }); 

    await page.click('button:has-text("Options")');
    await page.click('text="Export attendances (CSV)"');

    console.log("⏳ Waiting for report...");
    const downloadButton = page.locator('a.btn-primary:has-text("Download")');
    await downloadButton.waitFor({ state: 'visible', timeout: 180000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click()
    ]);
    
    const filePath = await download.path();
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: 'latest_attendance.csv',
      Body: fs.readFileSync(filePath),
      ContentType: 'text/csv',
    }));

    console.log("🎉 Success! File is in R2.");

  } catch (error) {
    console.error("❌ Pipeline Failed:", error.message);
    process.exit(1); 
  } finally {
    await browser.close();
  }
}

runScraper();
