import { z } from 'zod'

function isSupportedOutboundPhone(value: string) {
  // Retain international E.164 support, but catch incomplete Indian mobile
  // numbers before a SIP provider can reject the dial attempt.
  return !value.startsWith('+91') || /^\+91[6-9]\d{9}$/.test(value)
}

export const outboundAICallSchema = z.object({
  phoneNumber: z.string().trim().transform(value => value.replace(/[\s().-]/g, ''))
    .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number with country code, e.g. +919876543210'))
    .refine(isSupportedOutboundPhone, 'Indian mobile numbers need +91 followed by all 10 mobile digits.'),
  customerName: z.string().trim().max(120).optional().default(''),
  reason: z.string().trim().max(2000).optional().default('')
    .refine(value => value !== 'Custom reason', 'Enter the custom call reason')
    .transform(value => value || 'Follow-up call'),
})
