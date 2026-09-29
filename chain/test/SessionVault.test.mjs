import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, id, sha256, toUtf8Bytes } from 'ethers';
import solc from 'solc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = JSON.parse(await readFile(path.join(root, 'artifacts/SessionVault.evm.json'), 'utf8'));
const trx = (value) => BigInt(value) * 1_000_000n;
const balance = async (rpc, address) => BigInt(await rpc.request({
  method: 'eth_getBalance', params: [address, 'latest'],
}));

async function fixture(options = {}) {
  const rpc = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 6, defaultBalance: 1000 },
  });
  const provider = new BrowserProvider(rpc);
  const [owner, agent, seoulBowl, hanTable, impostor, outsider] = await Promise.all(
    Array.from({ length: 6 }, (_, index) => provider.getSigner(index)),
  );
  const vault = await new ContractFactory(artifact.abi, artifact.bytecode, owner).deploy();
  await vault.waitForDeployment();
  const sessionId = id(`session-${Math.random()}`);
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const merchants = options.merchants ?? [await seoulBowl.getAddress(), await hanTable.getAddress()];
  const cap = options.cap ?? trx('18');
  const initialFunding = options.initialFunding ?? cap;
  await (
    await vault.createSession(
      sessionId,
      await agent.getAddress(),
      merchants,
      cap,
      options.perPaymentCap ?? cap,
      expiry,
      id('policy-v1'),
      { value: initialFunding },
    )
  ).wait();
  return { rpc, provider, owner, agent, seoulBowl, hanTable, impostor, outsider, vault, sessionId };
}

async function attempt(vault, agent, sessionId, name, merchant, amount) {
  const attemptId = id(name);
  const quoteHash = sha256(toUtf8Bytes(`quote-${name}`));
  const receipt = await (
    await vault.connect(agent).attemptSpend(sessionId, attemptId, merchant, trx(amount), quoteHash)
  ).wait();
  const event = receipt.logs
    .map((log) => vault.interface.parseLog(log))
    .find((entry) => entry.name === 'PaymentExecuted' || entry.name === 'AttemptRejected');
  return { attemptId, quoteHash, event, receipt };
}

test('the demo story rejects both breaches, pays once, then enforces revocation', async () => {
  const f = await fixture();
  const bowl = await f.seoulBowl.getAddress();
  const han = await f.hanTable.getAddress();
  const fake = await f.impostor.getAddress();
  const hanBefore = await balance(f.rpc, han);
  const fakeBefore = await balance(f.rpc, fake);
  const vaultAddress = await f.vault.getAddress();

  const overBudget = await attempt(f.vault, f.agent, f.sessionId, 'fees-19', bowl, '19');
  assert.equal(overBudget.event.name, 'AttemptRejected');
  assert.equal(overBudget.event.args.reason, 5n);
  assert.equal(await f.vault.attemptStatus(f.sessionId, overBudget.attemptId), 1n);
  assert.equal(await balance(f.rpc, vaultAddress), trx('18'));

  const fakeMerchant = await attempt(f.vault, f.agent, f.sessionId, 'fake-merchant', fake, '14');
  assert.equal(fakeMerchant.event.name, 'AttemptRejected');
  assert.equal(fakeMerchant.event.args.reason, 4n);
  assert.equal(await balance(f.rpc, fake), fakeBefore);

  const paid = await attempt(f.vault, f.agent, f.sessionId, 'valid-16', han, '16');
  assert.equal(paid.event.name, 'PaymentExecuted');
  assert.equal(paid.event.args.amountSun, trx('16'));
  assert.equal(paid.event.args.quoteHash, paid.quoteHash);
  assert.equal(await f.vault.attemptStatus(f.sessionId, paid.attemptId), 2n);
  assert.equal(await balance(f.rpc, han), hanBefore + trx('16'));
  assert.equal(await balance(f.rpc, vaultAddress), trx('2'));

  await (await f.vault.revokeSession(f.sessionId)).wait();
  const afterStop = await attempt(f.vault, f.agent, f.sessionId, 'after-stop-1', han, '1');
  assert.equal(afterStop.event.name, 'AttemptRejected');
  assert.equal(afterStop.event.args.reason, 1n);
  assert.equal(await balance(f.rpc, han), hanBefore + trx('16'));
  assert.equal(await balance(f.rpc, vaultAddress), trx('2'));

  await (await f.vault.withdrawSession(f.sessionId)).wait();
  assert.equal(await balance(f.rpc, vaultAddress), 0n);
  assert.equal((await f.vault.sessions(f.sessionId)).spentSun, trx('16'));
});

test('only the owner may fund and revoke, only the agent may attempt a payment', async () => {
  const f = await fixture({ initialFunding: trx('5') });
  await assert.rejects(
    f.vault.connect(f.outsider).fundSession(f.sessionId, { value: trx('1') }),
    /revert/i,
  );
  await assert.rejects(f.vault.connect(f.outsider).revokeSession(f.sessionId), /revert/i);
  await assert.rejects(
    f.vault.connect(f.outsider).attemptSpend(
      f.sessionId, id('unauthorized'), await f.hanTable.getAddress(), trx('1'), id('quote'),
    ),
    /revert/i,
  );

  await (await f.vault.fundSession(f.sessionId, { value: trx('13') })).wait();
  const session = await f.vault.sessions(f.sessionId);
  assert.equal(session.fundedSun, trx('18'));
  assert.equal(session.remainingSun, trx('18'));
  await assert.rejects(f.vault.fundSession(f.sessionId, { value: trx('1') }), /revert/i);
});

test('per-payment limit, insufficient escrow, and replay are rejected without spending', async () => {
  const f = await fixture({ initialFunding: trx('5'), perPaymentCap: trx('10') });
  const merchant = await f.hanTable.getAddress();
  const perPayment = await attempt(f.vault, f.agent, f.sessionId, 'per-payment', merchant, '11');
  assert.equal(perPayment.event.args.reason, 6n);
  const underfunded = await attempt(f.vault, f.agent, f.sessionId, 'underfunded', merchant, '6');
  assert.equal(underfunded.event.args.reason, 7n);
  const paid = await attempt(f.vault, f.agent, f.sessionId, 'paid-4', merchant, '4');
  assert.equal(paid.event.name, 'PaymentExecuted');
  const replay = await attempt(f.vault, f.agent, f.sessionId, 'paid-4', merchant, '4');
  assert.equal(replay.event.name, 'AttemptRejected');
  assert.equal(replay.event.args.reason, 9n);
  assert.equal((await f.vault.sessions(f.sessionId)).spentSun, trx('4'));
});

test('expiration rejects a payment and permits refund', async () => {
  const f = await fixture();
  await f.rpc.request({ method: 'evm_increaseTime', params: [601] });
  await f.rpc.request({ method: 'evm_mine', params: [] });
  const result = await attempt(
    f.vault, f.agent, f.sessionId, 'expired', await f.hanTable.getAddress(), '1',
  );
  assert.equal(result.event.args.reason, 2n);
  await (await f.vault.withdrawSession(f.sessionId)).wait();
  assert.equal((await f.vault.sessions(f.sessionId)).remainingSun, 0n);
});

test('invalid quote and failed merchant transfer leave the balance untouched', async () => {
  const refusalSource = 'pragma solidity ^0.8.20; contract RefusingMerchant { receive() external payable { revert(); } }';
  const compiled = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'RefusingMerchant.sol': { content: refusalSource } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const receiver = compiled.contracts['RefusingMerchant.sol'].RefusingMerchant;

  const f = await fixture();
  const refusing = await new ContractFactory(receiver.abi, `0x${receiver.evm.bytecode.object}`, f.owner).deploy();
  await refusing.waitForDeployment();
  const sessionId = id('refusing-merchant-session');
  await (
    await f.vault.createSession(
      sessionId,
      await f.agent.getAddress(),
      [await refusing.getAddress()],
      trx('18'),
      trx('18'),
      Math.floor(Date.now() / 1000) + 600,
      id('refusing-merchant-policy'),
      { value: trx('18') },
    )
  ).wait();
  const badQuoteId = id('zero-quote');
  const badQuoteReceipt = await (
    await f.vault.connect(f.agent).attemptSpend(
      sessionId, badQuoteId, await refusing.getAddress(), trx('1'), '0x' + '00'.repeat(32),
    )
  ).wait();
  const badQuote = f.vault.interface.parseLog(badQuoteReceipt.logs[0]);
  assert.equal(badQuote.args.reason, 8n);

  const failed = await attempt(f.vault, f.agent, sessionId, 'refused-payment', await refusing.getAddress(), '1');
  assert.equal(failed.event.name, 'AttemptRejected');
  assert.equal(failed.event.args.reason, 10n);
  assert.equal((await f.vault.sessions(sessionId)).spentSun, 0n);
  assert.equal((await f.vault.sessions(sessionId)).remainingSun, trx('18'));
});
