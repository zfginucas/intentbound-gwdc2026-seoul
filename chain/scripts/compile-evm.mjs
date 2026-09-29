import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import solc from 'solc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'contracts/SessionVault.sol'), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'SessionVault.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'istanbul',
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors?.filter((entry) => entry.severity === 'error') ?? [];
for (const entry of output.errors ?? []) {
  console[entry.severity === 'error' ? 'error' : 'warn'](entry.formattedMessage);
}
if (errors.length) process.exit(1);

const compiled = output.contracts['SessionVault.sol'].SessionVault;
const artifact = {
  contractName: 'SessionVault',
  compiler: 'upstream-solc/evm-test-only',
  compilerVersion: solc.version(),
  evmVersion: 'istanbul',
  abi: compiled.abi,
  bytecode: `0x${compiled.evm.bytecode.object}`,
  deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
};
const directory = path.join(root, 'artifacts');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'SessionVault.evm.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Compiled EVM test artifact (${artifact.compilerVersion}, ${artifact.bytecode.length / 2 - 1} bytes)`);
