import { execSync } from 'node:child_process';
import { Firestore } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';
import { createServer } from '../src/server/server.mjs';
import { setFirestoreInstance } from '../src/server/db.mjs';

async function main() {
  console.log('=== Verifying Sample Google Login with Firebase DB (Firestore) ===');

  // Obtain access token from gcloud
  let token;
  try {
    token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error('Could not get gcloud access token:', err.message);
    process.exit(1);
  }

  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: token });
  const db = new Firestore({ projectId: 'home-509818', authClient });

  // Inject connected Firestore instance into DB module
  setFirestoreInstance(db);

  // Start HTTP server on port 0
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`1. Server started on ${baseUrl}`);

  const timestamp = Date.now();
  const testSub = `sample-google-${timestamp}`;
  const testEmail = `sample.user.${timestamp}@sgsaitechnology.com`;
  const testName = 'Sample Google Tester';

  // Create sample Google JWT
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    sub: testSub,
    email: testEmail,
    email_verified: true,
    name: testName,
    picture: 'https://lh3.googleusercontent.com/a/default-user',
    iat: Math.floor(timestamp / 1000),
    exp: Math.floor(timestamp / 1000) + 86400
  })).toString('base64url');
  const sampleIdToken = `${header}.${payload}.sample-signature`;

  console.log('2. Sending POST /api/v1/auth/google...');
  const loginRes = await fetch(`${baseUrl}/api/v1/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id_token: sampleIdToken, nonce: 'sample-nonce' })
  });

  if (!loginRes.ok) {
    console.error('Login request failed with status:', loginRes.status, await loginRes.text());
    server.close();
    process.exit(1);
  }

  const loginData = await loginRes.json();
  console.log('   Login response OK. User ID:', loginData.user.id);
  console.log('   Access Token issued:', loginData.access_token.slice(0, 16) + '...');

  console.log('3. Sending GET /api/v1/users/me with Bearer token...');
  const meRes = await fetch(`${baseUrl}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${loginData.access_token}` }
  });

  if (!meRes.ok) {
    console.error('Users/me request failed with status:', meRes.status, await meRes.text());
    server.close();
    process.exit(1);
  }

  const meData = await meRes.json();
  console.log('   User profile fetched successfully:');
  console.log('   - ID:', meData.id);
  console.log('   - Email:', meData.email);
  console.log('   - Full Name:', meData.full_name);
  console.log('   - Role:', meData.role);

  console.log('4. Verifying document directly in Cloud Firestore (Firebase DB)...');
  const userDoc = await db.collection('users').doc(loginData.user.id).get();
  if (!userDoc.exists) {
    console.error('ERROR: Document does not exist in Firestore!');
    server.close();
    process.exit(1);
  }

  const firestoreData = userDoc.data();
  console.log('   Document verified in Firestore:');
  console.log('   - Firestore ID:', userDoc.id);
  console.log('   - Firestore email:', firestoreData.email);
  console.log('   - Firestore provider:', firestoreData.provider);
  console.log('   - Firestore provider_id:', firestoreData.provider_id);

  console.log('5. Cleaning up test data from Firestore...');
  await db.collection('users').doc(loginData.user.id).delete();
  await db.collection('sessions').doc(loginData.access_token).delete();
  console.log('   Cleaned up test user and session.');

  server.close();
  console.log('\n=== Sample Google Login verification SUCCESSFUL! ===');
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
