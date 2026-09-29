import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { KILN_MODEL, type KilnCompletion, type TokenUsage } from "./kiln.js";

export interface InferenceMetadata {
  source: "kiln" | "demo_fallback";
  model: typeof KILN_MODEL | null;
  generationId: string | null;
  usage: TokenUsage | null;
  latencyMs: number | null;
  fallbackReason?: string;
}

export interface InferenceRecord extends InferenceMetadata {
  id: string;
  flow: "plan" | "recommend";
  recordedAt: string;
}

export class InferenceLedger {
  private readonly records: InferenceRecord[] = [];
  private readonly file: string | null;

  constructor(file: string | null = null) {
    this.file = file;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as InferenceRecord[];
      this.records.push(...saved);
    }
  }

  record(flow: InferenceRecord["flow"], completion: KilnCompletion): InferenceRecord {
    const entry: InferenceRecord = {
      id: randomUUID(),
      flow,
      recordedAt: new Date().toISOString(),
      source: "kiln",
      model: KILN_MODEL,
      generationId: completion.generationId,
      usage: completion.usage,
      latencyMs: completion.latencyMs,
    };
    this.records.push(entry);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = this.file + ".tmp";
      writeFileSync(temp, JSON.stringify(this.records, null, 2));
      renameSync(temp, this.file);
    }
    return entry;
  }

  list(): InferenceRecord[] {
    return [...this.records];
  }
}

export const defaultInferenceLedger = new InferenceLedger(
  resolve(process.cwd(), ".runtime/usage.json"),
);

export function inferenceMetadata(completion: KilnCompletion): InferenceMetadata {
  return {
    source: "kiln",
    model: KILN_MODEL,
    generationId: completion.generationId,
    usage: completion.usage,
    latencyMs: completion.latencyMs,
  };
}

export function fallbackMetadata(reason: string): InferenceMetadata {
  return {
    source: "demo_fallback",
    model: null,
    generationId: null,
    usage: null,
    latencyMs: null,
    fallbackReason: reason,
  };
}
