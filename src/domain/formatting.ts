export type UsageStats = {
  dayCost: number;
  sessionCost: number | null;
  tokensInput: number;
  tokensOutput: number;
  cacheRead: number;
  sessionsToday: number;
  totalCost: number;
};

export function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
}

export function formatUsageTable(stats: UsageStats | null, date: string, projectDisplayName?: string): string {
  if (!stats) return "";
  const displayDate = date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
  const heading = projectDisplayName ? `## Usage — ${displayDate} (project: ${projectDisplayName})` : `## Usage — ${displayDate}`;
  const hasSessionCost = stats.sessionCost !== null && stats.sessionCost !== undefined;
  const costLabel = hasSessionCost ? "Cost (本日/セッション)" : "Cost (本日)";
  const costValue = hasSessionCost ? `${formatCost(stats.dayCost)} / ${formatCost(stats.sessionCost as number)}` : formatCost(stats.dayCost);
  const tokensValue = `${formatTokens(stats.tokensInput)} / ${formatTokens(stats.tokensOutput)} / ${formatTokens(stats.cacheRead)}`;
  return `${heading}\n| 項目 | 値 |\n|---|---|\n| ${costLabel} | ${costValue} |\n| Tokens Input / Output / Cache Read | ${tokensValue} |\n| Sessions (本日) | ${stats.sessionsToday} |\n| Total Cost (累計) | ${formatCost(stats.totalCost)} |`;
}
