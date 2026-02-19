export function extractToolNamesFromSource(source: string): Set<string> {
  const discovered = new Set<string>();

  const toolFunctionPattern = /\btool_([a-z0-9_]+)\b/g;
  const functionNamespacePattern = /functions\.([a-zA-Z0-9_-]+)/g;

  for (const match of source.matchAll(toolFunctionPattern)) {
    if (match[1]) {
      discovered.add(match[1]);
    }
  }

  for (const match of source.matchAll(functionNamespacePattern)) {
    if (match[1]) {
      discovered.add(match[1]);
    }
  }

  return discovered;
}
