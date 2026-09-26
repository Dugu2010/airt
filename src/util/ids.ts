export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}
