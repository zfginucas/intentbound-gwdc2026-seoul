import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createShastaClient } from '../src/client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(root, '.env.local') });

const sessionId = process.argv[2];
if (!/^0x[0-9a-fA-F]{64}$/.test(sessionId ?? '')) {
  throw new Error('Usage: npm run shasta:withdraw -- 0x<64-hex-session-id>');
}
if (!process.env.CONTRACT_ADDRESS || !process.env.OWNER_PRIVATE_KEY) {
  throw new Error('Shasta contract address and demo owner key are required in chain/.env.local');
}

const chain = createShastaClient({
  contractAddress: process.env.CONTRACT_ADDRESS,
  rpcUrl: process.env.SHASTA_RPC || undefined,
});
const session = await chain.getSession(sessionId);
if (!session) throw new Error('Session does not exist on Shasta');
if (!session.revoked && Math.floor(Date.now() / 1000) < session.expiresAt) {
  throw new Error('Withdraw only after owner revocation or session expiry');
}
if (BigInt(session.remainingSun) === 0n) {
  process.stdout.write('No test TRX remains in this session.\n');
  process.exit(0);
}

const result = await chain.withdrawSession(sessionId, process.env.OWNER_PRIVATE_KEY);
if (result.status !== 'confirmed' || !result.events.some((event) => event.name === 'SessionWithdrawn')) {
  throw new Error('Withdrawal did not confirm with a SessionWithdrawn event: ' + result.txHash);
}
process.stdout.write('Withdrawn ' + session.remainingSun + ' SUN from Shasta session ' + sessionId + '\n');
process.stdout.write('Transaction: ' + result.txHash + '\n');
