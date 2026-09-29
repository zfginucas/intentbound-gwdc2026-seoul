import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from 'dotenv';
import { TronWeb } from 'tronweb';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(root, '.env.local'), override: false });
const host = process.env.SHASTA_RPC || 'https://api.shasta.trongrid.io';
if (!new URL(host).hostname.endsWith('.shasta.trongrid.io')) {
  throw new Error('Refusing to deploy outside Shasta');
}
const privateKey = process.env.OWNER_PRIVATE_KEY;
if (!privateKey) throw new Error('OWNER_PRIVATE_KEY is required');
const tronWeb = new TronWeb({ fullHost: host, privateKey });
const owner = TronWeb.address.fromPrivateKey(privateKey);
const balanceSun = await tronWeb.trx.getBalance(owner);
if (balanceSun < 100_000_000) {
  throw new Error(`Owner ${owner} needs Shasta test TRX for deployment (balance: ${balanceSun / 1e6})`);
}

const artifact = JSON.parse(await readFile(path.join(root, 'artifacts/SessionVault.json'), 'utf8'));
const unsigned = await tronWeb.transactionBuilder.createSmartContract(
  {
    abi: artifact.abi,
    bytecode: artifact.bytecode.slice(2),
    name: 'IntentBoundSessionVault',
    feeLimit: 500_000_000,
    callValue: 0,
    userFeePercentage: 100,
    originEnergyLimit: 10_000_000,
  },
  owner,
);
const signed = await tronWeb.trx.sign(unsigned, privateKey);
const broadcast = await tronWeb.trx.sendRawTransaction(signed);
if (!broadcast.result) throw new Error(`Broadcast failed: ${JSON.stringify(broadcast)}`);

const contractAddress = TronWeb.address.fromHex(unsigned.contract_address);
const txHash = signed.txID;
console.log(`Deployment sent: ${txHash}`);
console.log(`Expected contract address: ${contractAddress}`);

let receipt;
for (let i = 0; i < 30; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  receipt = await tronWeb.trx.getTransactionInfo(txHash);
  if (receipt?.receipt) break;
}
if (!receipt?.receipt || receipt.receipt.result !== 'SUCCESS') {
  throw new Error(`Deployment not confirmed as SUCCESS: ${JSON.stringify(receipt ?? {})}`);
}

const deployment = {
  network: 'tron-shasta',
  rpc: host,
  contractAddress,
  deploymentTxHash: txHash,
  blockNumber: receipt.blockNumber,
  compilerVersion: artifact.compilerVersion,
};
const directory = path.join(root, 'deployments');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'shasta.json'), `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`Confirmed in block ${receipt.blockNumber}`);
console.log(`Explorer: https://shasta.tronscan.org/#/transaction/${txHash}`);
