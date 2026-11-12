// A private application's verdict: the only thing the model may say about the details it alone saw.

export const PRIVATE_SUPPORT = ['support the profile', 'partly support the profile', 'do not support the profile', 'were not given'] as const;
export const PRIVATE_CONCERNS = ['audience smaller than the profile suggests', 'results hard to check', 'no way to contact them', 'none'] as const;
export interface PrivateVerdict { fit: number; private_details: (typeof PRIVATE_SUPPORT)[number]; concern: (typeof PRIVATE_CONCERNS)[number] }
/** The only reply shape the private call may produce (enforced by the model server, re-checked by us and by verify). */
export const PRIVATE_VERDICT_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'private_verdict',
    strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['fit', 'private_details', 'concern'],
      properties: { fit: { type: 'integer', enum: [1, 2, 3, 4, 5] }, private_details: { type: 'string', enum: [...PRIVATE_SUPPORT] }, concern: { type: 'string', enum: [...PRIVATE_CONCERNS] } },
    },
  },
};
/** Parses a private verdict, or null if it is anything but exactly the allowed shape. */
export function parseVerdict(text: string): PrivateVerdict | null {
  try {
    const v = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>;
    const keys = Object.keys(v).sort().join(',');
    if (keys !== 'concern,fit,private_details') return null;
    if (![1, 2, 3, 4, 5].includes(v.fit as number) || !PRIVATE_SUPPORT.includes(v.private_details as never) || !PRIVATE_CONCERNS.includes(v.concern as never)) return null;
    return { fit: v.fit as number, private_details: v.private_details as PrivateVerdict['private_details'], concern: v.concern as PrivateVerdict['concern'] };
  } catch { return null; }
}
/** The lines a private application adds to the public report (the report's hash goes onchain). */
export const privateLines = (v: PrivateVerdict, commitment: string): string => `\n\nprivate_verdict: ${JSON.stringify(v)}\nprivate_commitment: ${commitment}`;

