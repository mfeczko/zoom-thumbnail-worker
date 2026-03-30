import { chromium } from 'playwright';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';

// 1. Setup Cloudflare R2 Client (Reusing your existing logic)
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function runScraper() {
  console.log('Starting Bookwhen scraper...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    // 2. Log in to Bookwhen
    await page.goto('https://bookwhen.com/login');
    await page.fill('#user_email', process.env.BOOKWHEN_EMAIL); 
    await page.fill('#user_password', process.env.BOOKWHEN_PASSWORD);
    await page.click('input[type="submit"]');
    await page.waitForNavigation();

    // 3. Navigate to attendance and download
    // TODO: Replace with your actual attendance export URL
    await page.goto('https://bookwhen.com/your-attendance-page-url'); 
    
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('text="Export CSV"') 
    ]);
    
    const filePath = await download.path();
    const fileStream = fs.createReadStream(filePath);

    // 4. Upload directly to Cloudflare R2
    const uploadParams = {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: 'latest_attendance.csv', // This stays the same name so the app always finds it
      Body: fileStream,
      ContentType: 'text/csv',
    };

    console.log('Uploading to Cloudflare R2...');
    await s3.send(new PutObjectCommand(uploadParams));
    
    console.log('Successfully uploaded latest_attendance.csv to R2!');
    await browser.close();

  } catch (error) {
    console.error('Scraper failed:', error);
    if (browser) await browser.close();
    process.exit(1); // Tell Render the job failed
  }
}

runScraper();
