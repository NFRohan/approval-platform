
// ================================================================ the working calendar
const sidebar = async () => page.locator('aside').innerText();
const hol = async (d) => one(`select name, kind, provisional, moved_from::text as moved_from from public.holidays where tenant_id = $1 and on_date = $2`, [tenant, d]);

await page.goto(BASE + '/?as=EMP-2847');
await settle(2500);
ok('an employee is not offered the calendar to keep', !/Working Calendar/.test(await sidebar()));

await page.goto(BASE + '/admin/calendar?as=EMP-0650');
await settle(3000);
ok('whoever keeps the org chart is', /Working Calendar/.test(await sidebar()));
let t = await page.locator('[data-testid="holiday-list"]').innerText();
ok('this year\'s holidays are listed, Victory Day among them', t.includes('Victory Day') && t.includes('Durga Puja'));
await page.locator('select[aria-label="Year"]').selectOption('2027');
await settle(1500);
t = await page.locator('[data-testid="holiday-list"]').innerText();
ok('2027\'s list is in too, the Eid days provisional', t.includes('Eid ul-Fitr') && /provisional/.test(t) && t.includes('National Revolution and Solidarity Day'));
ok('the year has its Eid break drawn', (await page.locator('[data-day="2027-03-10"]').getAttribute('aria-label')).includes('Eid ul-Fitr'));
await shot('s7-calendar');

// A three-day approval asked for before Eid.
await page.locator('input[aria-label="Asked on"]').fill('2027-03-04');
await page.locator('input[aria-label="Working days"]').fill('3');
await settle(500);
t = await page.locator('[data-testid="deadline-result"]').innerText();
ok('a three-day deadline set before Eid is due after it, and says what it steps over', t.includes('16/03/2027') && /Eid ul-Fitr/.test(t), t);
const dbDue = (await one(`select public.working_days_from('2027-03-04', 3)::text d`)).d;
ok('...the same day the database counts', dbDue === '2027-03-16', dbDue);

// An office closure, added on screen.
await page.locator('[data-day="2027-07-01"]').click();
await page.locator('input[aria-label="Holiday name"]').fill('Bank holiday (half-yearly closing)');
await page.locator('select[aria-label="Kind"]').selectOption('office');
await page.locator('button[name="save-holiday"]').click();
await settle(2000);
ok('a day the office closes is added', (await hol('2027-07-01'))?.kind === 'office');
await page.locator('input[aria-label="Asked on"]').fill('2027-06-30');
await page.locator('input[aria-label="Working days"]').fill('1');
await settle(500);
ok('...and deadlines step over it', (await page.locator('[data-testid="deadline-result"]').innerText()).includes('04/07/2027'));

// The moon is sighted a day late: Ashura moves.
await page.locator('[data-day="2027-06-16"]').click();
await page.locator('input[aria-label="Holiday date"]').fill('2027-06-17');
await page.locator('input[aria-label="Provisional"]').uncheck();
await page.locator('button[name="save-holiday"]').click();
await settle(2000);
const moved = await hol('2027-06-17');
ok('a holiday moves to the day the moon says, no longer provisional', !(await hol('2027-06-16')) && moved?.name === 'Ashura' && !moved.provisional && moved.moved_from === '2027-06-16', JSON.stringify(moved));
ok('...and the list says where it came from', (await page.locator('[data-testid="holiday-list"]').innerText()).includes('moved from 16/06/2027'));
await page.locator('button[name="load-gov"]').click();
await settle(2000);
ok('reloading the government\'s list does not put it back', !(await hol('2027-06-16')));

// And a working day again.
await page.locator('[data-day="2027-07-01"]').click();
await page.locator('button[name="remove-holiday"]').click();
await settle(2000);
ok('a holiday is removed', !(await hol('2027-07-01')));
ok('every change is on the trail', (await one(`select count(*)::int n from public.activity_log where tenant_id = $1 and action in ('holiday_saved', 'holiday_moved', 'holiday_removed')`, [tenant])).n === 3);
await shot('s7-calendar-edited');

ok('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
await local.stop();
console.log(failures ? `\n${failures} FAILED` : '\nALL CALENDAR E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
