import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from 'dotenv';
import { TronWeb } from 'tronweb';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(root, '.env.local'), override: false });
const host = process.env.SHASTA_RPC || 'https://api.shasta.trongrid.io';
if (new URL(host).hostname !== 'api.shasta.trongrid.io') {
  throw new Error('Refusing to transfer outside Shasta');
}

const ownerKey = process.env.OWNER_PRIVATE_KEY;
const agentKey = process.env.AGENT_PRIVATE_KEY;
if (!ownerKey || !agentKey) throw new Error('Demo owner and agent keys are required');
const targetTrx = Number(process.argv[2] ?? '150');
if (!Number.isInteger(targetTrx) || targetTrx < 1 || targetTrx > 500) {
  throw new Error('Agent target must be an integer from 1 to 500 test TRX');
}

const tronWeb = new TronWeb({ fullHost: host, privateKey: ownerKey });
const owner = TronWeb.address.fromPrivateKey(ownerKey);
const agent = TronWeb.address.fromPrivateKey(agentKey);
const [ownerBalanceSun, agentBalanceSun] = await Promise.all([
  tronWeb.trx.getBalance(owner),
  tronWeb.trx.getBalance(agent),
]);
const amountSun = targetTrx * 1_000_000 - agentBalanceSun;
if (amountSun <= 0) {
  console.log(`Agent ${agent} already has at least ${targetTrx} test TRX; no transfer sent.`);
  process.exit(0);
}
if (ownerBalanceSun - amountSun < 200_000_000) {
  throw new Error('Owner needs enough Shasta test TRX to fund the agent and retain 200 TRX');
}

const broadcast = await tronWeb.trx.sendTransaction(agent, amountSun);
if (!broadcast.result) throw new Error(`Transfer broadcast failed: ${JSON.stringify(broadcast)}`);
const txHash = broadcast.txid ?? broadcast.transaction?.txID;
if (!txHash) throw new Error('Transfer broadcast omitted a transaction hash');
console.log(`Agent funding sent: ${txHash}`);

let receipt;
for (let i = 0; i < 30; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  receipt = await tronWeb.trx.getTransactionInfo(txHash);
  if (receipt?.receipt) break;
}
const transaction = await tronWeb.trx.getTransaction(txHash);
const transferResult = transaction?.ret?.[0]?.contractRet;
const confirmedBalanceSun = await tronWeb.trx.getBalance(agent);
if (
  !receipt?.receipt
  || receipt.receipt.result === 'FAILED'
  || (transferResult && transferResult !== 'SUCCESS')
  || confirmedBalanceSun < targetTrx * 1_000_000
) {
  throw new Error('Agent transfer could not be verified; inspect tx ' + txHash + ' before retrying');
}
console.log('Confirmed agent balance: ' + confirmedBalanceSun / 1_000_000 + ' test TRX');
