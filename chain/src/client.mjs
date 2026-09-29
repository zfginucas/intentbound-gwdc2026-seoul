import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Interface } from 'ethers';
import { TronWeb } from 'tronweb';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = JSON.parse(await readFile(path.join(root, 'artifacts/SessionVault.json'), 'utf8'));
const iface = new Interface(artifact.abi);

export const SHASTA_RPC = 'https://api.shasta.trongrid.io';
export const REJECT_REASONS = Object.freeze([
  'NONE',
  'REVOKED',
  'EXPIRED',
  'INVALID_AMOUNT',
  'MERCHANT_NOT_ALLOWED',
  'OVER_LIMIT',
  'PER_PAYMENT_LIMIT',
  'INSUFFICIENT_ESCROW',
  'INVALID_QUOTE',
  'DUPLICATE_ATTEMPT',
  'TRANSFER_FAILED',
]);

export async function receiptAfterBroadcast(txHash, poller) {
  try {
    return await poller(txHash);
  } catch {
    return {
      txHash,
      status: 'pending',
      events: [],
      error: 'Receipt polling failed after broadcast; reconcile by txHash before retrying',
    };
  }
}

function bytes32(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${field} must be 0x-prefixed bytes32`);
  }
  return value;
}

function uint(value, field) {
  const parsed = BigInt(value);
  if (parsed < 0n) throw new RangeError(`${field} must not be negative`);
  return parsed.toString();
}

function safeSun(value, field) {
  const parsed = BigInt(uint(value, field));
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${field} exceeds TronWeb's safe callValue range`);
  }
  return Number(parsed);
}

function tronAddress(value) {
  if (typeof value !== 'string') throw new TypeError('Invalid TRON address');
  if (value.startsWith('0x') && value.length === 42) {
    return TronWeb.address.fromHex(`41${value.slice(2)}`);
  }
  if (value.length === 42 && value.startsWith('41')) {
    return TronWeb.address.fromHex(value);
  }
  if (!TronWeb.isAddress(value)) throw new TypeError(`Invalid TRON address: ${value}`);
  return TronWeb.address.fromHex(TronWeb.address.toHex(value));
}

function logAddressPayload(value) {
  let hex = value.replace(/^0x/, '');
  if (hex.length === 42 && hex.startsWith('41')) hex = hex.slice(2);
  return hex.toLowerCase();
}

export function decodeReceiptEvents(info, contractAddress) {
  const payload = logAddressPayload(TronWeb.address.toHex(tronAddress(contractAddress)));
  const events = [];
  for (const log of info?.log ?? []) {
    if (logAddressPayload(log.address) !== payload) continue;
    try {
      const parsed = iface.parseLog({
        topics: log.topics.map((topic) => topic.startsWith('0x') ? topic : `0x${topic}`),
        data: log.data?.startsWith('0x') ? log.data : `0x${log.data ?? ''}`,
      });
      if (!parsed) continue;
      const args = Object.fromEntries(parsed.fragment.inputs.map((input, index) => {
        const raw = parsed.args[index];
        const value = input.type === 'address' ? tronAddress(raw)
          : typeof raw === 'bigint' ? raw.toString() : raw;
        return [input.name, value];
      }));
      events.push({ name: parsed.name, args });
    } catch {
      // An unrelated or unknown log does not invalidate other decoded events.
    }
  }
  return events;
}

export function createShastaClient({
  rpcUrl = SHASTA_RPC,
  contractAddress,
  tronGridApiKey,
  feeLimitSun = 150_000_000,
} = {}) {
  if (new URL(rpcUrl).hostname !== 'api.shasta.trongrid.io') {
    throw new Error('This client only permits the public TRON Shasta network');
  }
  const address = tronAddress(contractAddress);
  const headers = tronGridApiKey ? { 'TRON-PRO-API-KEY': tronGridApiKey } : undefined;
  const reader = new TronWeb({ fullHost: rpcUrl, headers });
  const normalizedFeeLimit = safeSun(feeLimitSun, 'feeLimitSun');

  function contractFor(privateKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(privateKey ?? '')) {
      throw new TypeError('A 64-character private key is required to sign');
    }
    const signer = new TronWeb({ fullHost: rpcUrl, headers, privateKey });
    return signer.contract(artifact.abi, address);
  }

  function readContract() {
    return reader.contract(artifact.abi, address);
  }

  async function getTransactionInfo(txHash) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(txHash ?? '')) {
      throw new TypeError('Invalid TRON transaction hash');
    }
    const hash = txHash.replace(/^0x/, '');
    const info = await reader.trx.getTransactionInfo(hash);
    if (!info?.receipt) return { txHash: hash, status: 'pending', events: [] };
    return {
      txHash: hash,
      status: info.receipt.result === 'SUCCESS' ? 'confirmed' : 'failed',
      blockNumber: info.blockNumber,
      energyUsage: info.receipt.energy_usage_total ?? info.receipt.energy_usage,
      feeSun: info.fee ?? 0,
      events: decodeReceiptEvents(info, address),
      error: info.resMessage ? reader.toUtf8(info.resMessage) : undefined,
    };
  }

  async function waitForTransaction(txHash, { attempts = 45, intervalMs = 2000 } = {}) {
    for (let index = 0; index < attempts; index += 1) {
      const result = await getTransactionInfo(txHash);
      if (result.status !== 'pending') return result;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { txHash, status: 'pending', events: [] };
  }

  async function send(privateKey, method, args, callValueSun = 0) {
    const contract = contractFor(privateKey);
    const txHash = await contract[method](...args).send({
      feeLimit: normalizedFeeLimit,
      callValue: safeSun(callValueSun, 'callValueSun'),
    });
    return receiptAfterBroadcast(txHash, waitForTransaction);
  }

  return {
    contractAddress: address,
    abi: artifact.abi,
    getTransactionInfo,
    waitForTransaction,
    async getBalance(accountAddress) {
      return String(await reader.trx.getBalance(tronAddress(accountAddress)));
    },
    async getSession(sessionId) {
      bytes32(sessionId, 'sessionId');
      const contract = readContract();
      const raw = await contract.sessions(sessionId).call({ from: address });
      const fields = [
        'owner', 'agent', 'totalCapSun', 'perPaymentCapSun', 'fundedSun', 'spentSun',
        'remainingSun', 'expiresAt', 'revoked', 'policyHash',
      ];
      const values = Object.fromEntries(fields.map((field, index) => [field, raw[field] ?? raw[index]]));
      if (/^0x0{40}$/i.test(values.owner)) return null;
      return {
        sessionId,
        owner: tronAddress(values.owner),
        agent: tronAddress(values.agent),
        totalCapSun: uint(values.totalCapSun, 'totalCapSun'),
        perPaymentCapSun: uint(values.perPaymentCapSun, 'perPaymentCapSun'),
        fundedSun: uint(values.fundedSun, 'fundedSun'),
        spentSun: uint(values.spentSun, 'spentSun'),
        remainingSun: uint(values.remainingSun, 'remainingSun'),
        expiresAt: Number(values.expiresAt),
        revoked: values.revoked,
        policyHash: values.policyHash,
        allowedMerchants: (await contract.getAllowedMerchants(sessionId).call({ from: address }))
          .map(tronAddress),
      };
    },
    async getAttemptStatus(sessionId, attemptId) {
      bytes32(sessionId, 'sessionId');
      bytes32(attemptId, 'attemptId');
      const result = await readContract().attemptStatus(sessionId, attemptId).call({ from: address });
      return Number(result);
    },
    async createSession({
      sessionId, agentAddress, allowedMerchants, totalCapSun, perPaymentCapSun,
      expiresAt, policyHash, initialFundingSun = totalCapSun,
    }, ownerPrivateKey) {
      bytes32(sessionId, 'sessionId');
      bytes32(policyHash, 'policyHash');
      if (!Array.isArray(allowedMerchants) || allowedMerchants.length === 0) {
        throw new TypeError('allowedMerchants must be a nonempty address array');
      }
      return send(ownerPrivateKey, 'createSession', [
        sessionId,
        tronAddress(agentAddress),
        allowedMerchants.map(tronAddress),
        uint(totalCapSun, 'totalCapSun'),
        uint(perPaymentCapSun, 'perPaymentCapSun'),
        uint(expiresAt, 'expiresAt'),
        policyHash,
      ], initialFundingSun);
    },
    async fundSession(sessionId, amountSun, ownerPrivateKey) {
      bytes32(sessionId, 'sessionId');
      return send(ownerPrivateKey, 'fundSession', [sessionId], amountSun);
    },
    async attemptSpend({ sessionId, attemptId, merchant, amountSun, quoteHash }, agentPrivateKey) {
      bytes32(sessionId, 'sessionId');
      bytes32(attemptId, 'attemptId');
      bytes32(quoteHash, 'quoteHash');
      const result = await send(agentPrivateKey, 'attemptSpend', [
        sessionId, attemptId, tronAddress(merchant), uint(amountSun, 'amountSun'), quoteHash,
      ]);
      const event = result.events.find((entry) =>
        entry.name === 'PaymentExecuted' || entry.name === 'AttemptRejected');
      if (event) {
        const code = event.name === 'PaymentExecuted' ? 0 : Number(event.args.reason);
        result.decision = {
          paid: event.name === 'PaymentExecuted',
          reasonCode: code,
          reason: REJECT_REASONS[code],
        };
      }
      return result;
    },
    async revokeSession(sessionId, ownerPrivateKey) {
      bytes32(sessionId, 'sessionId');
      return send(ownerPrivateKey, 'revokeSession', [sessionId]);
    },
    async withdrawSession(sessionId, ownerPrivateKey) {
      bytes32(sessionId, 'sessionId');
      return send(ownerPrivateKey, 'withdrawSession', [sessionId]);
    },
  };
}
