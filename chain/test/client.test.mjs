import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Interface } from 'ethers';
import { TronWeb } from 'tronweb';
import { createShastaClient, decodeReceiptEvents, receiptAfterBroadcast, REJECT_REASONS } from '../src/client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { abi } = JSON.parse(await readFile(path.join(root, 'artifacts/SessionVault.json'), 'utf8'));
const iface = new Interface(abi);
const contractAddress = 'TTMWWb3XEtQ3C7i8vBB2xiZShNgWsuEdZK';
const merchantAddress = 'TB2sCSX5RDK8GMFT1ZTSsR8FsP1nWPFM5b';
const toEvmAddress = (address) => `0x${TronWeb.address.toHex(address).slice(2)}`;

test('TRON receipt logs decode to base58 addresses and decimal SUN strings', () => {
  const encoded = iface.encodeEventLog(iface.getEvent('PaymentExecuted'), [
    '0x' + '11'.repeat(32),
    '0x' + '22'.repeat(32),
    toEvmAddress(merchantAddress),
    16_000_000n,
    '0x' + '33'.repeat(32),
    16_000_000n,
    2_000_000n,
  ]);
  const events = decodeReceiptEvents({ log: [{
    address: TronWeb.address.toHex(contractAddress).slice(2),
    topics: encoded.topics.map((topic) => topic.slice(2)),
    data: encoded.data.slice(2),
  }] }, contractAddress);

  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'PaymentExecuted');
  assert.equal(events[0].args.merchant, merchantAddress);
  assert.equal(events[0].args.amountSun, '16000000');
  assert.equal(events[0].args.remainingSun, '2000000');
});

test('reason codes and Shasta-only network guard remain stable', () => {
  assert.equal(REJECT_REASONS[5], 'OVER_LIMIT');
  assert.equal(REJECT_REASONS[4], 'MERCHANT_NOT_ALLOWED');
  const client = createShastaClient({ contractAddress });
  assert.equal(client.contractAddress, contractAddress);
  assert.throws(
    () => createShastaClient({ contractAddress, rpcUrl: 'https://api.trongrid.io' }),
    /only permits.*Shasta/,
  );
});

test('a post-broadcast polling error preserves the original transaction hash', async () => {
  const txHash = 'a'.repeat(64);
  const result = await receiptAfterBroadcast(txHash, async () => {
    throw new Error('Shasta RPC temporarily unavailable');
  });
  assert.equal(result.txHash, txHash);
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.events, []);
});
