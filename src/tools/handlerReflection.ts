export type GenericToolExecutor = (
  args: Record<string, unknown>,
) => Promise<unknown>;

export function reflectToolHandlers(
  handlerExports: Record<string, unknown>,
): Map<string, GenericToolExecutor> {
  const map = new Map<string, GenericToolExecutor>();

  for (const [exportName, value] of Object.entries(handlerExports)) {
    if (typeof value !== "function" || !exportName.startsWith("tool_")) {
      continue;
    }

    const toolName = exportName.slice("tool_".length);
    map.set(toolName, value as GenericToolExecutor);
  }

  return map;
}
