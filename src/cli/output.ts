import type { Packet } from "../workflows/types.ts";

/** A command-line mistake: exit 64 with the usage line. */
export class UsageError extends Error {}

export const EXIT = {
  ok: 0,
  incomplete: 10,
  budgetExhausted: 12,
  usage: 64,
  input: 65,
  internal: 70,
} as const;

/** Exit codes 1 and 2 are never used: exit 2 is a blocking signal in some agent hooks. */
export function exitCodeFor(packet: Packet<unknown>): number {
  switch (packet.status) {
    case "complete":
      return EXIT.ok;
    case "incomplete":
      return EXIT.incomplete;
    case "budget_exhausted":
      return EXIT.budgetExhausted;
  }
}

export interface HumanSection {
  title: string;
  lines: string[];
}

/** Render the concise human view shared by every workflow. */
export function renderHuman(packet: Packet<unknown>, sections: HumanSection[]): string {
  const c = packet.coverage;
  const out: string[] = [];
  out.push(`stanley ${packet.workflow} · ${packet.status} · advisory only`);
  out.push(
    `coverage: ${c.candidates} candidates · ${c.judged} judged · ${c.deterministic} deterministic · ${c.excluded} excluded · ${c.parked} parked · ${c.failed} failed · ${c.unjudged} unjudged${c.complete ? "" : " · INCOMPLETE"}`,
  );
  if (packet.findings.length > 0) {
    out.push("", `findings (${packet.findings.length}):`);
    for (const finding of packet.findings) {
      const where = finding.path ? ` ${finding.path}${finding.lines ? `:${finding.lines}` : ""}` : "";
      const marker = finding.severity === "warn" ? "!" : "·";
      out.push(`  ${marker} ${finding.flag}${where} [${finding.source}]${detailSuffix(finding.detail)}`);
    }
  } else {
    out.push("", "findings: none flagged (this is not an approval)");
  }
  for (const section of sections) {
    if (section.lines.length === 0) continue;
    out.push("", `${section.title}:`, ...section.lines.map((line) => `  ${line}`));
  }
  if (packet.parked.length > 0) {
    out.push("", `parked (${packet.parked.length}):`);
    for (const item of packet.parked.slice(0, 20)) out.push(`  ? ${item.path ?? item.id}: ${item.reason}`);
    if (packet.parked.length > 20) out.push(`  … ${packet.parked.length - 20} more in --json`);
  }
  if (packet.excluded.length > 0) {
    out.push("", `excluded (${packet.excluded.length}):`);
    for (const item of packet.excluded.slice(0, 10)) out.push(`  - ${item.path ?? item.id}: ${item.reason}`);
    if (packet.excluded.length > 10) out.push(`  … ${packet.excluded.length - 10} more in --json`);
  }
  if (packet.limits.length > 0) out.push("", "limits:", ...packet.limits.map((limit) => `  - ${limit}`));
  out.push("", `not checked: ${packet.notChecked.join("; ")}`);
  const jev = packet.jev;
  out.push(
    `jev: ${jev.status} · model ${jev.resolvedModels.join(",") || jev.requestedModel} · ${jev.requests} requests · ${jev.inputTokens} input tokens · ${jev.latencyMs} ms${packet.redactions ? ` · ${packet.redactions} redactions` : ""}`,
  );
  out.push(`artifact: ${packet.artifact ?? "not persisted"}`);
  return `${out.join("\n")}\n`;
}

function detailSuffix(detail: Packet["findings"][number]["detail"]): string {
  if (!detail) return "";
  const parts = Object.entries(detail)
    .filter(
      ([, value]) => typeof value === "number" || typeof value === "string" || typeof value === "boolean",
    )
    .slice(0, 4)
    .map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
