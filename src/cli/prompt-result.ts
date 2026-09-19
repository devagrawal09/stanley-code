import type { JsonObject } from "../core/types.ts";
import type { PromptResult } from "../core/workflow.ts";
import type { Packet } from "../workflows/types.ts";
import { EXIT, type HumanSection, renderHuman } from "./output.ts";

export const PROMPT_RESULT_SCHEMA = "stanley.prompt-result/v1";

export function promptResultExitCode(result: PromptResult): number {
  switch (result.status) {
    case "complete":
      return EXIT.ok;
    case "incomplete":
      return EXIT.incomplete;
    case "budget_exhausted":
      return EXIT.budgetExhausted;
    case "unsupported":
      return EXIT.usage;
  }
}

/** Project a built-in packet into the implementation-neutral composition value. */
export function packetPromptResult(packet: Packet<unknown>, sections: HumanSection[]): PromptResult {
  const rendered = renderHuman(packet, sections)
    .trimEnd()
    .split("\n")
    .slice(1)
    .filter((line) => !line.startsWith("jev: ") && !line.startsWith("artifact: "));
  const text = [`${packet.status} - advisory only`, ...rendered].join("\n");
  const data = {
    coverage: packet.coverage,
    findings: packet.findings,
    parked: packet.parked,
    excluded: packet.excluded,
    limits: packet.limits,
    notChecked: packet.notChecked,
    results: packet.results,
    summary: packet.summary,
  } as unknown as JsonObject;
  return { status: packet.status, output: { text, data } };
}

export function unsupportedPromptResult(message: string, detail: JsonObject = {}): PromptResult {
  return { status: "unsupported", output: { text: message, data: detail } };
}

export function renderPromptResult(result: PromptResult): string {
  if (typeof result.output === "string") return `${result.output}\n`;
  if (
    typeof result.output === "object" &&
    result.output !== null &&
    !Array.isArray(result.output) &&
    typeof result.output.text === "string"
  ) {
    return `${result.output.text.trimEnd()}\n`;
  }
  return `${JSON.stringify(result.output, null, 2)}\n`;
}

export function jsonPromptResult(result: PromptResult): JsonObject {
  return { schema: PROMPT_RESULT_SCHEMA, status: result.status, output: result.output };
}
