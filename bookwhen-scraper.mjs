import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import csv from 'csv-parser';

// Connect to your Lovable app's database
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function runScraper() {
  console.log('Starting Bookwhen scraper...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    // Log in to Bookwhen
    await page.goto('https://bookwhen.com/login');
    await page.fill('#user_email', process.env.BOOKWHEN_EMAIL); 
    await page.fill('#user_password', process.env.BOOKWHEN_PASSWORD);
    await page.click('input[type="submit"]');
    await page.waitForNavigation();

    // Navigate to attendance and download the CSV
    // TODO: Update this URL to your actual Bookwhen attendance export page
    await page.goto('https://bookwhen.com/your-attendance-page-url'); 
    
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('text="Export CSV"') // TODO: Adjust if the button text is different
    ]);
    
    const filePath = await download.path();
    console.log(`CSV downloaded to: ${filePath}`);

    // Parse CSV and push to Supabase
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        for (const row of results) {
           const { error } = await supabase
             .from('student_attendance')
             .upsert({ 
                student_email: row['Email'], // Match to your exact CSV header
                student_name: row['Name'],   // Match to your exact CSV header
                class_date: new Date().toISOString().split('T')[0],
                status: row['Status'] === 'Attended' ? 'Present' : 'Absent'
             });
             
           if (error) console.error('Error inserting row:', error);
        }
        console.log('Successfully synced Bookwhen attendance to Lovable!');
        await browser.close();
      });

  } catch (error) {
    console.error('Automation failed:', error);
    await browser.close();
  }
}

// Execute the function
runScraper();
