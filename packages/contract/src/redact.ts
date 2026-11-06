// 展示用脱敏工具。日志脱敏在服务端另做（见 service/src/util/redact.ts），这里只处理界面展示。

/** buyer01@example.test → b*****1@example.test；手机号保留后 4 位。 */
export function maskLoginIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.indexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at);
    if (local.length <= 2) return `${local[0] ?? ''}*${domain}`;
    return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 5))}${local[local.length - 1]}${domain}`;
  }
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.min(value.length - 4, 6))}${value.slice(-4)}`;
}

/** 原生 profile ID 只展示前 8 位。 */
export function shortProfileId(profileId: string | null | undefined): string | null {
  if (!profileId) return null;
  return profileId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8);
}
