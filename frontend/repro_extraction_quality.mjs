import { chromium } from '@playwright/test';

const PID = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage();

page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text());
});

async function login() {
  await page.goto('http://127.0.0.1:5173/login');
  await page.getByLabel('Username').fill('repro-diag2');
  await page.getByLabel('Password').fill('repro-diag-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(800);
}

await login();

// --- Forms page: enable quality assessment, create both forms ---
await page.goto(`http://127.0.0.1:5173/projects/${PID}/forms`);
await page.getByLabel('Enable quality assessment').check();
console.log('AFTER CHECK:', await page.locator('main').innerText());
const combos = await page.getByRole('combobox').all();
for (const c of combos) {
  console.log('COMBO:', JSON.stringify(await c.getAttribute('aria-label')), await c.evaluate(el => el.closest('label')?.textContent));
}
await page.getByLabel('Mode', { exact: true }).selectOption('both');
await page.getByLabel('Aggregation').selectOption('weighted_average');
await page.getByRole('button', { name: 'Save quality settings' }).click();
await page.waitForTimeout(500);

// Extraction form
await page.getByLabel('Name').fill('Extraction form');
await page.getByLabel('Kind').selectOption('extraction');
await page.getByRole('button', { name: 'Create form' }).click();
await page.waitForTimeout(500);
await page.getByLabel('Label').fill('Main finding');
await page.getByLabel('Type').selectOption('long_text');
await page.getByLabel('Required').check();
await page.getByRole('button', { name: 'Add field' }).click();
await page.waitForTimeout(500);
console.log('EXTRACTION FIELD ADDED:', await page.locator('main').innerText());

// Quality form
await page.getByLabel('Name').fill('Quality form');
await page.getByLabel('Kind').selectOption('quality');
await page.getByRole('button', { name: 'Create form' }).click();
await page.waitForTimeout(500);

await page.getByLabel('Label').fill('Study design');
await page.getByLabel('Type').selectOption('single_select');
await page.getByLabel('Required').check();
await page.getByLabel('Options (one per line)').fill('Strong\nWeak');
await page.waitForTimeout(200);
await page.getByLabel('Strong').fill('2');
await page.getByLabel('Weak').fill('0');
await page.getByRole('button', { name: 'Add field' }).click();
await page.waitForTimeout(500);

await page.getByLabel('Label').fill('Reporting quality');
await page.getByLabel('Type').selectOption('rating');
await page.getByLabel('Required').check();
await page.getByLabel('Score weight').fill('1');
await page.getByRole('button', { name: 'Add field' }).click();
await page.waitForTimeout(500);
console.log('QUALITY FIELDS ADDED:', await page.locator('main').innerText());

// --- Extraction page ---
await page.goto(`http://127.0.0.1:5173/projects/${PID}/extraction`);
await page.waitForTimeout(1000);
console.log('EXTRACTION PAGE BEFORE SUBMIT:', await page.locator('main').innerText());
await page.getByLabel('Main finding *').fill('Uses VR for urban analytics.');
await page.getByRole('button', { name: 'Submit extraction' }).click();
await page.waitForTimeout(1000);
console.log('EXTRACTION PAGE AFTER SUBMIT:', await page.locator('main').innerText());

// --- Quality page ---
await page.goto(`http://127.0.0.1:5173/projects/${PID}/quality`);
await page.waitForTimeout(1000);
console.log('QUALITY PAGE BEFORE SUBMIT:', await page.locator('main').innerText());
await page.getByLabel('Study design *').selectOption('Strong');
await page.getByLabel('Reporting quality *').selectOption('4');
await page.getByRole('button', { name: 'Submit assessment' }).click();
await page.waitForTimeout(1000);
console.log('QUALITY PAGE AFTER SUBMIT:', await page.locator('main').innerText());

await browser.close();
