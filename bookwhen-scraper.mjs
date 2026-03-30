import { chromium } from 'playwright';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs";

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
  console.log("🚀 Starting Surgical Pipeline...");
  const browser = await chromium.launch({ 
    headless: true, 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
  });
  
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  
  try {
    console.log("🔑 Navigating to Login...");
    // We go to the business login specifically
    await page.goto('https://bookwhen.com/login', { waitUntil: 'domcontentloaded' });

    console.log("🔎 Filling login form by labels...");
    // Use 'getByLabel' or 'getByPlaceholder' which is more robust than IDs
    await page.getByLabel(/Your email address/i).fill(BOOKWHEN_EMAIL);
    await page.getByLabel(/Password/i).fill(BOOKWHEN_PASSWORD);
    
    // Click the green "Log in" button
    await page.click('button:has-text("Log in")');
    
    await page.waitForNavigation({ waitUntil: 'networkidle' });
    console.log("📅 Success! Logged in.");

    // The rest of your export logic
    await page.goto('https://lungesinleggings.bookwhen.com/attendances'); 
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
    // This is a pro-move: if it fails, we log the page content to see what went wrong
    const content = await page.content();
    console.log("HTML Preview of failure page:", content.slice(0, 500));
    process.exit(1); 
  } finally {
    await browser.close();
  }
}

runScraper();
