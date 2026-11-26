// ================================================================ one ticket's history, to Excel
const { unzipSync, strFromU8 } = req('fflate');
const sub = await one(`select id, ref_number from public.form_submissions where tenant_id = $1 and submitted_by = 'EMP-2847' and status <> 'draft' order by submitted_at desc limit 1`, [tenant]);
await page.goto(`${BASE}/status/${sub.id}?as=EMP-2847`); await settle(3500);
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: /History \(Excel\)/ }).click()]);
ok('the status page exports the request\'s history to Excel', dl.suggestedFilename() === `${sub.ref_number}-history.xlsx`, dl.suggestedFilename());
const bytes = await (await import('node:fs/promises')).readFile(await dl.path());
const files = unzipSync(new Uint8Array(bytes));
const xml = Object.entries(files).filter(([n]) => /sharedStrings|sheet1/.test(n)).map(([, v]) => strFromU8(v)).join(' ');
ok('...a real workbook', bytes[0] === 0x50 && bytes[1] === 0x4b && !!files['xl/workbook.xml']);
const missing = ['Section', 'Request', 'Answer', 'Approval step', 'History', sub.ref_number].filter((w) => !xml.includes(w));
ok('...with the request, its answers, the approval steps and the trail', missing.length === 0, 'missing: ' + missing.join(', '));
ok('...and dates written dd/MM/yyyy', /\d{2}\/\d{2}\/\d{4}/.test(xml));
ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
await browser.close(); await local.stop(); process.exit(failures ? 1 : 0);
