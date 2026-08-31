import { expect, it } from 'vitest';
import { readModes } from '../src/index.js';

it('throws when SIGNER_MODE is unset', () => expect(() => readModes({})).toThrow());
it('rejects STORE_MODE=emulator in production', () => expect(() => readModes({ SIGNER_MODE: 'kms', VERTEX_MODE: 'fake', PUBSUB_MODE: 'gcp', STORE_MODE: 'emulator', NODE_ENV: 'production' })).toThrow());
it('accepts VERTEX_MODE=fake in production', () => expect(() => readModes({ SIGNER_MODE: 'kms', VERTEX_MODE: 'fake', PUBSUB_MODE: 'gcp', STORE_MODE: 'gcp', NODE_ENV: 'production' })).not.toThrow());
