import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TronWeb } from 'tronweb';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = path.join(root, '.env.local');
const labels = ['OWNER', 'AGENT', 'SEOUL_BOWL', 'HAN_TABLE'];
const wallets = await Promise.all(labels.map(async (label) => [label, await TronWeb.createAccount()]));
const lines = ['SHASTA_RPC=https://api.shasta.trongrid.io'];

for (const [label, wallet] of wallets) {
  lines.push(`${label}_PRIVATE_KEY=${wallet.privateKey}`);
}
lines.push('CONTRACT_ADDRESS=');
await writeFile(filename, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });

console.log(`Created ${filename} (private keys omitted from output):`);
for (const [label, wallet] of wallets) {
  console.log(`${label}: ${wallet.address.base58}`);
}
