import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiled = JSON.parse(await readFile(path.join(root, 'build/contracts/SessionVault.json'), 'utf8'));
const artifact = {
  contractName: 'SessionVault',
  compiler: 'tronbox/tron-solc',
  compilerVersion: compiled.compiler?.version ?? '0.8.20',
  evmVersion: 'istanbul',
  abi: compiled.abi,
  bytecode: compiled.bytecode.startsWith('0x') ? compiled.bytecode : `0x${compiled.bytecode}`,
  deployedBytecode: compiled.deployedBytecode.startsWith('0x')
    ? compiled.deployedBytecode : `0x${compiled.deployedBytecode}`,
};
const directory = path.join(root, 'artifacts');
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'SessionVault.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Exported TRON SessionVault (${artifact.compilerVersion}, ${artifact.bytecode.length / 2 - 1} bytes)`);
