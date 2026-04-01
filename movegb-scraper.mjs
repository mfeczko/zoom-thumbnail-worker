async function extractBookings(page, label, url) {
  log(`Opening ${label}: ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Give client-side rendering a moment
  await page.waitForTimeout(3000);

  await saveScreenshot(page, `${label}.png`);
  await saveText(`${label}.html`, await page.content());

  const bodyTextRaw = await page.locator("body").innerText();
  const bodyText = cleanText(bodyTextRaw);
  await saveText(`${label}.txt`, bodyTextRaw);

  log(`${label}: page title = ${await page.title()}`);
  log(`${label}: body length = ${bodyText.length}`);

  // First, try table parsing just in case
  const tableRows = page.locator("table tbody tr");
  const tableRowCount = await tableRows.count();
  log(`${label}: table row count = ${tableRowCount}`);

  const bookings = [];

  if (tableRowCount > 0) {
    for (let i = 0; i < tableRowCount; i++) {
      const row = tableRows.nth(i);
      const cells = row.locator("td");
      const cellCount = await cells.count();

      const values = [];
      for (let j = 0; j < cellCount; j++) {
        values.push(cleanText(await cells.nth(j).innerText()));
      }

      if (values.length) {
        bookings.push({
          source: "table",
          raw_cells: values,
        });
      }
    }
  }

  // If no table rows, try repeated card/list selectors
  if (bookings.length === 0) {
    const candidateSelectors = [
      '[class*="booking"]',
      '[class*="Booking"]',
      '[class*="card"]',
      '[class*="Card"]',
      '[class*="list"] > *',
      'main section > div',
      'main article',
      'main li',
      '.container li',
      '.container .row > div',
    ];

    for (const selector of candidateSelectors) {
      const nodes = page.locator(selector);
      const count = await nodes.count();

      if (count === 0) continue;

      log(`${label}: selector "${selector}" matched ${count} nodes`);

      const samples = [];
      for (let i = 0; i < Math.min(count, 12); i++) {
        const txt = cleanText(await nodes.nth(i).innerText().catch(() => ""));
        if (txt) samples.push(txt);
      }

      // Keep only nodes that actually look booking-ish
      const useful = samples.filter(
        (t) =>
          /confirmed|cancelled|attended|move|bookings?|today|upcoming|am|pm|\d{1,2}:\d{2}/i.test(t)
      );

      if (useful.length > 0) {
        log(`${label}: selector "${selector}" produced useful samples:`);
        useful.slice(0, 5).forEach((s, idx) => {
          console.log(`[movegb] ${label} sample ${idx + 1}: ${s}`);
        });

        for (const sample of useful) {
          bookings.push({
            source: selector,
            raw_text: sample,
          });
        }

        // Stop at first useful selector
        break;
      }
    }
  }

  await saveJson(`${label}.json`, {
    label,
    url,
    extractedAt: new Date().toISOString(),
    bookingCount: bookings.length,
    bookings,
  });

  log(`${label}: parsed bookings = ${bookings.length}`);

  if (bookings.length === 0) {
    log(`${label}: no structured bookings found`);
    log(`${label}: first 2000 chars of body text below`);
    console.log(bodyTextRaw.slice(0, 2000));
  }

  return bookings;
}
