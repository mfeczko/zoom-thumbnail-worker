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
  console.log("🚀 Starting Precision Pipeline...");
  const browser = await chromium.launch({ 
    headless: true, 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
  });
  
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  
  try {
    console.log("🔑 Navigating to Login...");
    await page.goto('https://bookwhen.com/login', { waitUntil: 'domcontentloaded' });

    console.log("🔎 Filling Business Login form...");
    // Using the exact IDs discovered in the previous run's logs
    await page.fill('#admin_login_form_email', BOOKWHEN_EMAIL);
    await page.fill('#admin_login_form_password', BOOKWHEN_PASSWORD);
    
    // Click the "Log in" button specifically within the admin form
    await page.click('input[type="submit"]');
    
    await page.waitForNavigation({ waitUntil: 'networkidle' });
    console.log("📅 Success! Logged in.");

    // 4. Go to Attendances
    console.log("📅 Navigating to Attendances...");
    await page.goto('https://lungesinleggings.bookwhen.com/attendances', { waitUntil: 'networkidle' }); 

    // 5. Trigger Export
    console.log("🖱️ Opening Options and Requesting CSV...");
    await page.click('button:has-text("Options")');
    await page.click('text="Export attendances (CSV)"');

    // 6. Wait for the "Download" button
    console.log("⏳ Waiting for report generation (up to 3 mins)...");
    const downloadButton = page.locator('a.btn-primary:has-text("Download")');
    await downloadButton.waitFor({ state: 'visible', timeout: 180000 });
    console.log("✅ Report ready!");

    // 7. Execute Download
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click()
    ]);
    
    const filePath = await download.path();
    const fileBuffer = fs.readFileSync(filePath);

    // 8. Upload to R2
    console.log("☁️ Uploading to R2...");
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: 'latest_attendance.csv',
      Body: fileBuffer,
      ContentType: 'text/csv',
    }));

    console.log("🎉 Success! latest_attendance.csv is now in R2.");

  } catch (error) {
    console.error("❌ Pipeline Failed:", error.message);
    process.exit(1); 
  } finally {
    await browser.close();
  }
}

runScraper();
