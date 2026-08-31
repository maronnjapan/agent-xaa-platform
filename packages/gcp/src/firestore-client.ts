import { Firestore } from '@google-cloud/firestore';
import type { Modes } from '@xaa/contracts';

let instance: Firestore | undefined;

export function getFirestore(modes: Modes, env: NodeJS.ProcessEnv = process.env): Firestore {
  if (instance) return instance;
  if (modes.store === 'emulator' && !env.FIRESTORE_EMULATOR_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is required');
  instance = new Firestore({ projectId: env.GOOGLE_CLOUD_PROJECT, databaseId: env.FIRESTORE_DATABASE ?? 'xaa' });
  return instance;
}

export function resetFirestoreForTesting(): void { instance = undefined; }
