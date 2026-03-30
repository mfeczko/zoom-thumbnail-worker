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
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

async function runScraper() {
  console.log("🚀 Starting Bookwhen Export Pipeline...");
  
  // Launch browser and allow downloads
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  
  try {
    // 2. Login
    console.log("🔑 Logging into Bookwhen...");
    await page.goto('https://bookwhen.com/login');
    await page.fill('#user_email', BOOKWHEN_EMAIL); 
    await page.fill('#user_password', BOOKWHEN_PASSWORD);
    await page.click('input[type="submit"]');
    await page.waitForNavigation();

    // 3. Go to Attendances
    console.log("📅 Navigating to Attendances...");
    await page.goto('https://lungesinleggings.bookwhen.com/attendances'); 

    // 4. Trigger Export
    console.log("🖱️ Opening Options and Requesting CSV...");
    await page.click('button:has-text("Options")');
    await page.click('text="Export attendances (CSV)"');

    // 5. Wait for the "Download" button to appear in the modal
    console.log("⏳ Waiting for report generation (up to 3 mins)...");
    const downloadButton = page.locator('a.btn-primary:has-text("Download")');
    
    // This waits for the "Processing" modal to turn into the "Download" modal
    await downloadButton.waitFor({ state: 'visible', timeout: 180000 });
    console.log("✅ Report ready!");

    // 6. Execute Download
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click()
    ]);
    
    const filePath = await download.path();
    const fileBuffer = fs.readFileSync(filePath);

    // 7. Upload to R2 (naming it 'latest_attendance.csv')
    console.log("☁️ Uploading to R2...");
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: 'latest_attendance.csv',
      Body: fileBuffer,
      ContentType: 'text/csv',
    }));

    console.log("🎉 Success! File is now in R2.");

  } catch (error) {
    console.error("❌ Pipeline Failed:", error.message);
    process.exit(1); 
  } finally {
    await browser.close();
  }
}

runScraper();
