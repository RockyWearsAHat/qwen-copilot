import * as vscode from "vscode";

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars)).trimEnd()}\n\n… (truncated to ${maxChars} chars)`;
}

function looksLikeUri(value: unknown): value is vscode.Uri {
  const v = value as vscode.Uri | undefined;
  return !!v && typeof (v as any).scheme === "string" && typeof (v as any).toString === "function";
}

function looksLikeLocation(value: unknown): value is vscode.Location {
  const v = value as vscode.Location | undefined;
  return (
    !!v &&
    typeof (v as any).uri === "object" &&
    looksLikeUri((v as any).uri) &&
    typeof (v as any).range === "object" &&
    typeof (v as any).range.start === "object" &&
    typeof (v as any).range.end === "object"
  );
}

function formatLocation(value: vscode.Location): string {
  const start = value.range.start;
  const end = value.range.end;
  // VS Code ranges are 0-based. Humans read 1-based.
  const startLine = start.line + 1;
  const startChar = start.character + 1;
  const endLine = end.line + 1;
  const endChar = end.character + 1;
  return `${value.uri.toString(true)}#L${startLine}:${startChar}-L${endLine}:${endChar}`;
}

export interface PromptReferenceRenderOptions {
  maxTotalChars?: number;
  maxCharsPerReference?: number;
}

/**
 * Renders Copilot/VS Code prompt references (user-attached context like files/locations)
 * into a compact system-message payload. This is intentionally simple and truncated.
 */
export async function renderPromptReferencesContext(
  references: readonly vscode.ChatPromptReference[] | undefined,
  options: PromptReferenceRenderOptions = {},
): Promise<string> {
  if (!references || references.length === 0) return "";

  const maxTotalChars = options.maxTotalChars ?? 12_000;
  const maxCharsPerReference = options.maxCharsPerReference ?? 4_000;

  const chunks: string[] = [
    "## Copilot Prompt References (user-attached context)",
    "These are values the user referenced/attached in the Copilot prompt UI.",
    "Prefer using them over searching the workspace.",
    "",
  ];

  let used = chunks.join("\n").length;

  for (const ref of references) {
    if (used >= maxTotalChars) break;

    const headerLines = [
      `### ${ref.id}`,
      ...(ref.modelDescription ? [`**description:** ${ref.modelDescription}`] : []),
    ];

    let body = "";
    try {
      if (typeof ref.value === "string") {
        body = truncate(ref.value, maxCharsPerReference);
      } else if (looksLikeLocation(ref.value)) {
        const loc = ref.value;
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        body = truncate(doc.getText(loc.range), maxCharsPerReference);
        headerLines.push(`**location:** ${formatLocation(loc)}`);
      } else if (looksLikeUri(ref.value)) {
        const uri = ref.value;
        const doc = await vscode.workspace.openTextDocument(uri);
        body = truncate(doc.getText(), maxCharsPerReference);
        headerLines.push(`**file:** ${uri.toString(true)}`);
      } else {
        // Future-proof: render unknown values as JSON-ish.
        body = truncate(String(ref.value), maxCharsPerReference);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      body = `Unable to resolve reference value: ${msg}`;
    }

    const block = [...headerLines, "", body, ""].join("\n");
    if (used + block.length > maxTotalChars) {
      const remaining = Math.max(0, maxTotalChars - used);
      chunks.push(truncate(block, remaining));
      used = maxTotalChars;
      break;
    }

    chunks.push(block);
    used += block.length;
  }

  const rendered = chunks.join("\n").trim();
  return rendered.length > maxTotalChars ? truncate(rendered, maxTotalChars) : rendered;
}
