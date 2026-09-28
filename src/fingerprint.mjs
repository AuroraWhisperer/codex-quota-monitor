import { createHash } from 'node:crypto';

export const fingerprint = value => createHash('sha256').update(value).digest('hex');
