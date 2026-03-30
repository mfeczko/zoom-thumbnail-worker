import { chromium } from 'playwright';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';

// 1. Configure Cloudflare R2 (Using your existing environment variables)
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function runScraper() {
  console.log('🚀 Starting Bookwhen attendance export...');
  
  // Launch browser with downloads accepted
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  
  try {
    // 2. Log in to Bookwhen
    console.log('🔑 Logging in...');
    await page.goto('https://bookwhen.com/login');
    await page.fill('#user_email', process.env.BOOKWHEN_EMAIL); 
    await page.fill('#user_password', process.env.BOOKWHEN_PASSWORD);
    await page.click('input[type="submit"]');
    await page.waitForNavigation();

    // 3. Navigate to the Attendances page
    console.log('📅 Navigating to bookings/attendances...');
    await page.goto('https://lungesinleggings.bookwhen.com/attendances'); 

    // 4. Trigger the Export
    console.log('🖱️ Opening Options menu...');
    await page.click('button:has-text("Options")');
    
    console.log('📩 Requesting Attendance CSV...');
    await page.click('text="Export attendances (CSV)"');

    // 5. Wait for the Processing Modal to finish
    // Based on your screenshot, we wait for the "Download" button to become visible.
    console.log('⏳ Waiting for Bookwhen to generate the report (up to 3 mins)...');
    
    // We use a broader locator to find the blue Download button in the modal
    const downloadButton = page.locator('a.btn-primary:has-text("Download")');
    
    // Increased timeout to 3 minutes as requested
    await downloadButton.waitFor({ state: 'visible', timeout: 180000 });
    console.log('✅ Report ready!');

    // 6. Handle the actual file download
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click()
    ]);
    
    const filePath = await download.path();
    const fileStream = fs.createReadStream(filePath);

    // 7. Upload the file to Cloudflare R2
    console.log('☁️ Uploading to Cloudflare R2...');
    const uploadParams = {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: 'latest_attendance.csv',
      Body: fileStream,
      ContentType: 'text/csv',
    };

    await s3.send(new PutObjectCommand(uploadParams));
    console.log('🎉 Success! latest_attendance.csv is now in R2.');

  } catch (error) {
    console.error('❌ Scraper failed:', error);
    process.exit(1); 
  } finally {
    await browser.close();
  }
}

runScraper();
