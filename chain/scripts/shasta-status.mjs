import 'dotenv/config';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TronWeb } from 'tronweb';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(root, '.env.local'), override: false });
const host = process.env.SHASTA_RPC || 'https://api.shasta.trongrid.io';
if (!new URL(host).hostname.endsWith('.shasta.trongrid.io')) {
  throw new Error('Refusing to use a non-Shasta RPC');
}

const tronWeb = new TronWeb({ fullHost: host });
const block = await tronWeb.trx.getCurrentBlock();
console.log(`Shasta block: ${block.block_header.raw_data.number}`);
for (const label of ['OWNER', 'AGENT', 'SEOUL_BOWL', 'HAN_TABLE']) {
  const key = process.env[`${label}_PRIVATE_KEY`];
  if (!key) continue;
  const address = TronWeb.address.fromPrivateKey(key);
  const balanceSun = await tronWeb.trx.getBalance(address);
  console.log(`${label}: ${address} (${balanceSun / 1_000_000} test TRX)`);
}
