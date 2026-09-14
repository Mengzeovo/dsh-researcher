import { type PlanContentInput, type PlanDocument, type PlanLedgerEntry, type PlanRunEvidence } from './plan-schema.ts';
import type { ResearchId } from './types.ts';
export interface ParsedPlanLedger {
    readonly entries: readonly PlanLedgerEntry[];
    /** All validated original bytes, adding only a missing final line terminator. */
    readonly validText: string;
}
export declare function formatPlanNumber(value: number): string;
/** Only the one canonical spelling reserves a numeric final plan directory. */
export declare function parsePlanDirectoryName(name: string): number | undefined;
export declare function planRoot(id: ResearchId): string;
export declare function planDirectory(id: ResearchId, planId: number): string;
export declare function planVersionFile(revision: number): string;
export declare function planVersionPath(id: ResearchId, planId: number, revision: number): string;
export declare function planLedgerPath(id: ResearchId, planId: number): string;
export declare function hashPlanMarkdown(markdown: string): string;
/** Parsing never normalizes the bytes hashed by the independent ledger. */
export declare function parsePlanDocument(markdown: string, expected?: {
    readonly planId: number;
    readonly revision: number;
}): PlanDocument;
/** Only the host passes the mechanical identity/time; caller content stays separate. */
export declare function renderPlanDocument(planId: number, revision: number, input: PlanContentInput, createdAt: string, evidence?: readonly PlanRunEvidence[], schemaVersion?: 1 | 2): PlanDocument;
/** Exact replay retains the saved document format, timestamp, identity and evidence bytes. */
export declare function planContentMatches(document: PlanDocument, input: PlanContentInput): boolean;
export declare function planLedgerEntry(document: PlanDocument): PlanLedgerEntry;
/** Strict JSONL: no malformed/truncated tail is silently discarded. */
export declare function parsePlanLedger(planId: number, text: string): ParsedPlanLedger;
export declare function renderPlanLedger(entries: readonly PlanLedgerEntry[]): string;
export declare function appendPlanLedgerText(parsed: ParsedPlanLedger, entry: PlanLedgerEntry): string;
/** Hash mismatches are corruption, never an invitation to update the ledger hash. */
export declare function verifyPlanLedgerDocument(document: PlanDocument, entry: PlanLedgerEntry): void;
//# sourceMappingURL=plan-records.d.ts.map