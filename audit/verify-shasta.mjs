import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createShastaClient, REJECT_REASONS } from '../chain/src/client.mjs';
import { policyHash, verifyEvidence } from '../policy/src/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sameHex(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

export async function auditRecord(record, chain) {
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: !!passed, detail });
  const live = await chain.getSession(record.id);
  if (!live) {
    check('Contract session exists', false, record.id);
    return { verdict: 'fail', checks };
  }

  check('Policy hash is reproducible',
    sameHex(policyHash(record.policy), record.policyHash),
    'SHA-256 of the exported approved fields');
  check('Contract policy hash matches record',
    sameHex(live.policyHash, record.policyHash),
    'The contract stores the same policy hash');
  check('Contract owner and agent match',
    live.owner === record.policy.owner && live.agent === record.policy.agent,
    'Public TRON addresses');
  check('Contract limits and expiry match',
    live.totalCapSun === String(record.policy.totalCapSun)
      && live.perPaymentCapSun === String(record.policy.perPaymentCapSun)
      && live.expiresAt === record.policy.expiresAt,
    'SUN limits and UTC deadline');
  check('Contract merchant allowlist matches',
    JSON.stringify([...live.allowedMerchants].sort())
      === JSON.stringify([...record.policy.allowedMerchantAddresses].sort()),
    'Base58 recipient addresses, not display names');

  const approval = await chain.getTransactionInfo(record.approvalTxHash);
  const approvalEvent = approval.events.find((event) =>
    event.name === 'SessionCreated' && sameHex(event.args.sessionId, record.id));
  check('Owner approval transaction is confirmed',
    approval.status === 'confirmed' && !!approvalEvent,
    record.approvalTxHash);

  let paidSum = 0n;
  for (const attempt of record.attempts) {
    if (!attempt.txHash) {
      check('Attempt ' + attempt.quoteId + ' has a transaction hash', false, attempt.id);
      continue;
    }
    const receipt = await chain.getTransactionInfo(attempt.txHash);
    const event = receipt.events.find((entry) =>
      (entry.name === 'PaymentExecuted' || entry.name === 'AttemptRejected')
      && sameHex(entry.args.sessionId, record.id)
      && sameHex(entry.args.attemptId, attempt.id));
    if (!event) {
      check('Attempt ' + attempt.quoteId + ' has a confirmed event', false, attempt.txHash);
      continue;
    }
    const observed = {
      name: event.name,
      sessionId: record.id,
      merchantAddress: event.args.merchant,
      amountSun: event.args.amountSun,
      quoteHash: event.args.quoteHash,
      ...(event.name === 'AttemptRejected'
        ? { reason: REJECT_REASONS[Number(event.args.reason)] }
        : {}),
    };
    const result = verifyEvidence({
      policy: { ...record.policy, revoked: attempt.policyRevokedAtAttempt },
      quote: attempt.quote,
      policyHash: record.policyHash,
      quoteHash: attempt.quoteHash,
      spentBeforeSun: attempt.spentBeforeSun,
      remainingBeforeSun: attempt.remainingBeforeSun,
      decision: attempt.decision,
    }, observed);
    check('Attempt ' + attempt.quoteId + ' quote and decision replay',
      receipt.status === 'confirmed' && result.verified,
      result.verified ? attempt.txHash : result.problems.join(', '));
    if (event.name === 'PaymentExecuted') paidSum += BigInt(event.args.amountSun);
  }
  check('Contract spent amount equals executed payment events',
    BigInt(live.spentSun) === paidSum,
    'Paid ' + paidSum + ' SUN; contract spent ' + live.spentSun + ' SUN');

  if (record.revokeTxHash) {
    const revoke = await chain.getTransactionInfo(record.revokeTxHash);
    check('Owner stop transaction is confirmed',
      revoke.status === 'confirmed'
        && revoke.events.some((event) =>
          event.name === 'SessionRevoked' && sameHex(event.args.sessionId, record.id))
        && live.revoked,
      record.revokeTxHash);
  }

  return {
    verdict: checks.every((item) => item.passed) ? 'pass' : 'fail',
    network: 'tron-shasta',
    sessionId: record.id,
    contractAddress: chain.contractAddress,
    paidSun: String(paidSum),
    checks,
    disclosure: 'Merchants, menus, quotes and delivery are simulated; this verifies testnet spending boundaries only.',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const evidencePath = path.resolve(
    process.argv[2] ?? path.join(projectRoot, 'docs/evidence/shasta-session-evidence.json'),
  );
  const deploymentPath = path.join(projectRoot, 'chain/deployments/shasta.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
  const chain = createShastaClient({ contractAddress: deployment.contractAddress });
  const result = await auditRecord(evidence.evidence ?? evidence, chain);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.verdict !== 'pass') process.exitCode = 1;
}
