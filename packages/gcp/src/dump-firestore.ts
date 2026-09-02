import { writeFile } from 'node:fs/promises';
import { getFirestore } from './firestore-client.js';

async function main(): Promise<void> {
  const output = process.argv[2];
  if (!output) throw new Error('output path is required');
  const firestore = getFirestore({ signer: 'local', vertex: 'fake', pubsub: 'inproc', store: process.env.STORE_MODE === 'emulator' ? 'emulator' : 'gcp' });
  const records: Record<string, unknown[]> = {};
  for (const collection of await firestore.listCollections()) {
    const snapshot = await collection.get();
    records[collection.id] = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }
  const json = JSON.stringify(records, null, 2);
  await writeFile(output, `${json}\n`, 'utf8');
  if (/"eyJ[A-Za-z0-9_-]+/.test(json)) throw new Error('JWT-like plaintext was found in Firestore');
  process.stdout.write(`dump-firestore: wrote ${output}; JWT-like values=0\n`);
}

await main();
