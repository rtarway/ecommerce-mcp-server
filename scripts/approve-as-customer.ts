/**
 * Approves a purchase as the demo customer, headlessly: opens the approval link an agent showed, signs in on the
 * shop's approval page and clicks "Approve and pay". For automated harness runs; a person does this in a browser.
 *   TEST_USER_PASSWORD=… npx tsx scripts/approve-as-customer.ts '<approval link>'
 */
import { approveInBrowser } from "../test/attack/lib.js";

const link = process.argv[2];
if (!link || !process.env.TEST_USER_PASSWORD) {
  console.error("usage: TEST_USER_PASSWORD=… approve-as-customer.ts '<approval link>'");
  process.exit(2);
}
const r = await approveInBrowser(link);
console.log(JSON.stringify({ stage: r.stage, status: r.status, result: r.result }));
