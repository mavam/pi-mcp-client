import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const CHOICES = new Map([
  ["Trust", { trusted: true, save: true }],
  ["Trust (this session only)", { trusted: true, save: false }],
  ["Do not trust", { trusted: false, save: true }],
  ["Do not trust (this session only)", { trusted: false, save: false }],
]);

/**
 * Pi implicitly trusts folders without Pi project resources, but `.mcp.json` can
 * start processes. Apply the decision Pi would reach if it asked; undefined means ask.
 */
export function projectTrustDecision(agentDir: string, cwd: string, piTrusted: boolean): boolean | undefined {
  if (!piTrusted) return false;
  // Pi resolved trust itself: a saved or session decision, --approve, or its default.
  if (hasTrustRequiringProjectResources(cwd)) return true;
  const saved = new ProjectTrustStore(agentDir).get(cwd);
  if (saved !== null) return saved;
  const policy = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust();
  return policy === "ask" ? undefined : policy === "always";
}

/** Saved answers go to Pi's trust store; undefined means the dialog was cancelled. */
export async function askProjectTrust(
  agentDir: string,
  cwd: string,
  select: (title: string, choices: string[], options: { signal: AbortSignal }) => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<boolean | undefined> {
  const answer = await select(
    `Trust project folder?\n${cwd}\n\nIts .mcp.json defines MCP servers, which can run local commands with your permissions. Saved decisions use Pi's project trust and also apply to Pi project resources.`,
    [...CHOICES.keys()],
    { signal },
  );
  const choice = answer === undefined ? undefined : CHOICES.get(answer);
  if (!choice || signal.aborted) return undefined;
  if (choice.save) new ProjectTrustStore(agentDir).set(cwd, choice.trusted);
  return choice.trusted;
}
