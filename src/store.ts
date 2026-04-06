import { promises as fs } from "node:fs";
import path from "node:path";
import type { CardActionState, CardRecord, CardState, CardStore, RecordActionResult } from "./types.js";

function makeActionKey(actionId: string): string {
  return actionId.trim();
}

function upsertActionState(existing: CardActionState[] | undefined, actionId: string): { next: CardActionState[]; state: CardActionState; duplicate: boolean } {
  const now = new Date().toISOString();
  const actionKey = makeActionKey(actionId);
  const states = [...(existing ?? [])];
  const index = states.findIndex((item) => item.actionKey === actionKey);

  if (index === -1) {
    const state: CardActionState = {
      actionKey,
      actionId,
      firstSeenAt: now,
      lastSeenAt: now,
      clickCount: 1,
    };
    states.push(state);
    return { next: states, state, duplicate: false };
  }

  const prev = states[index];
  const state: CardActionState = {
    ...prev,
    actionId,
    lastSeenAt: now,
    clickCount: prev.clickCount + 1,
  };
  states[index] = state;
  return { next: states, state, duplicate: true };
}

function normalizeCardState(record: Partial<CardRecord> & { createdAt?: string; metadata?: Record<string, unknown> }): CardState {
  const metadata = record.metadata ?? {};
  const handledActionLabel =
    typeof metadata.handledAction === "string"
      ? metadata.handledAction
      : typeof metadata.handledActionLabel === "string"
        ? metadata.handledActionLabel
        : undefined;
  const handled = metadata.handled === true || metadata.handledByBridge === true;

  const existingState = record.state;
  if (existingState && typeof existingState === "object" && typeof existingState.status === "string") {
    return {
      status: existingState.status,
      handledAt: existingState.handledAt,
      handledActionId: existingState.handledActionId,
      handledActionLabel: existingState.handledActionLabel,
      lastUpdatedAt: existingState.lastUpdatedAt ?? record.createdAt ?? new Date().toISOString(),
    };
  }

  return {
    status: handled ? "handled" : "open",
    handledAt: typeof metadata.handledAt === "string" ? metadata.handledAt : undefined,
    handledActionId: typeof metadata.handledActionId === "string" ? metadata.handledActionId : undefined,
    handledActionLabel,
    lastUpdatedAt:
      typeof metadata.lastUpdatedAt === "string"
        ? metadata.lastUpdatedAt
        : record.createdAt ?? new Date().toISOString(),
  };
}

function normalizeCardRecord(record: CardRecord): CardRecord {
  return {
    ...record,
    text: typeof record.text === "string" ? record.text : "",
    blocks: Array.isArray(record.blocks) ? record.blocks : [],
    contentMode: record.contentMode === "blocks" || record.contentMode === "text"
      ? record.contentMode
      : Array.isArray(record.blocks) && record.blocks.length > 0
        ? "blocks"
        : "text",
    postActionRenderMode: record.postActionRenderMode === "preserve" ? "preserve" : "replace",
    state: normalizeCardState(record),
  };
}

export class JsonCardStore implements CardStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<CardRecord[]> {
    return this.readAll();
  }

  async getCard(cardId: string): Promise<CardRecord | undefined> {
    const all = await this.readAll();
    return all.find((item) => item.cardId === cardId);
  }

  async upsertCard(record: CardRecord): Promise<void> {
    const all = await this.readAll();
    const idx = all.findIndex((item) => item.cardId === record.cardId);
    const normalized = normalizeCardRecord(record);
    if (idx >= 0) all[idx] = normalized;
    else all.push(normalized);
    await this.writeAll(all);
  }

  async recordAction(cardId: string, actionId: string): Promise<RecordActionResult | undefined> {
    const all = await this.readAll();
    const idx = all.findIndex((item) => item.cardId === cardId);
    if (idx === -1) return undefined;

    const record = all[idx];
    const result = upsertActionState(record.actionStates, actionId);
    const nextRecord: CardRecord = {
      ...record,
      actionStates: result.next,
      state: normalizeCardState(record),
    };
    all[idx] = nextRecord;
    await this.writeAll(all);

    return {
      record: nextRecord,
      state: result.state,
      duplicate: result.duplicate,
    };
  }

  private async readAll(): Promise<CardRecord[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((item) => normalizeCardRecord(item as CardRecord)) : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      if (error instanceof SyntaxError) {
        throw new Error(`cards store at ${this.filePath} contains invalid JSON — delete or repair the file to reset`);
      }
      throw error;
    }
  }

  private async writeAll(records: CardRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(records, null, 2), "utf8");
  }
}
