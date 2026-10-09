export function judgeNeeds(
  needs: unknown,
  expected: readonly string[],
): { ok: boolean; problems: string[] }
