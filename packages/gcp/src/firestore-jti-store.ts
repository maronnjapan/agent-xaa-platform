import { Timestamp, type Firestore } from '@google-cloud/firestore';
import type { JtiNamespace, JtiStore } from '@xaa/crypto';

function documentId(namespace: JtiNamespace, jti: string): string {
  if (jti.length === 0 || jti.includes('/') || new TextEncoder().encode(jti).byteLength > 1_480) {
    throw new Error('jti cannot be represented as a Firestore document id');
  }
  return `${namespace}__${jti}`;
}

function collection(namespace: JtiNamespace): 'dpop_jti' | 'assertion_jti' {
  return namespace === 'dpop' ? 'dpop_jti' : 'assertion_jti';
}

export class FirestoreJtiStore implements JtiStore {
  constructor(private readonly firestore: Firestore) {}
  async consume(namespace: JtiNamespace, jti: string, ttlSeconds: number): Promise<boolean> {
    const reference = this.firestore.collection(collection(namespace)).doc(documentId(namespace, jti));
    try {
      await reference.create({ namespace, jti, expire_at: Timestamp.fromMillis(Date.now() + ttlSeconds * 1000) });
      return true;
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      if (code === 6 || code === '6' || code === 'ALREADY_EXISTS') return false;
      throw error;
    }
  }
}
