// Temporary probe — verify what listRunning() actually returns vs sandbox ids.
// Deleted in Phase 6.
import { CodeSandbox } from "@codesandbox/sdk";

const key = process.env.CODESANDBOX_API_KEY;
if (!key) throw new Error("no key");
const sdk = new CodeSandbox(key);

const running = await sdk.sandboxes.listRunning();
console.log("concurrentVmCount:", running.concurrentVmCount);
console.log("concurrentVmLimit:", running.concurrentVmLimit);
console.log("vms:", JSON.stringify(running.vms, null, 2));

const list = await sdk.sandboxes.list({ limit: 10 });
console.log("totalCount:", list.totalCount);
console.log("sandbox ids:", list.sandboxes.map((s) => `${s.id} updated=${s.updatedAt.toISOString()}`).slice(0, 10));

const runningIds = new Set(running.vms.map((v) => v.id));
for (const s of list.sandboxes.slice(0, 10)) {
  console.log(`membership ${s.id}: ${runningIds.has(s.id)}`);
}
