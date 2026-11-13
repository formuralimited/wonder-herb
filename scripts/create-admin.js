/* Create an administrator, or promote an existing account to one.
 *
 *   npm run admin:create -- owner@wonder-herb.com "a good password" "Ada Wong"
 *
 * The first administrator can also be created from the console's sign-in card
 * on a fresh install; this is how you add or repair one afterwards.
 */
const { connect, close, AUTH_COLLECTIONS, DB_NAME } = require('../server/db');
const auth = require('../server/auth');

const [emailArg, passwordArg, nameArg] = process.argv.slice(2);

(async () => {
  const email = auth.cleanEmail(emailArg);
  const problem = auth.emailProblem(email) || auth.passwordProblem(passwordArg);
  if (problem) {
    console.error(problem);
    console.error('\nUsage: npm run admin:create -- <email> <password> [name]');
    process.exit(1);
  }

  const db = await connect();
  const users = db.collection(AUTH_COLLECTIONS.users);
  await db.collection(AUTH_COLLECTIONS.users).createIndex({ email: 1 }, { unique: true });

  const existing = await users.findOne({ email: email });
  const passwordHash = auth.hashPassword(passwordArg);

  if (existing) {
    await users.updateOne({ _id: existing._id }, {
      $set: {
        role: 'admin',
        status: 'active',
        passwordHash: passwordHash,
        passwordChangedAt: new Date(),
        name: nameArg || existing.name || ''
      }
    });
    // a password change means the old sessions should not survive it
    await db.collection(AUTH_COLLECTIONS.sessions).deleteMany({ userId: existing._id });
    console.log('Updated ' + email + ' to administrator in ' + DB_NAME + '.');
  } else {
    await users.insertOne({
      name: nameArg || '',
      email: email,
      passwordHash: passwordHash,
      role: 'admin',
      status: 'active',
      createdAt: new Date(),
      lastLoginAt: null
    });
    console.log('Created administrator ' + email + ' in ' + DB_NAME + '.');
  }

  /* There is no admin UI to sign in to: admin/index.html was deleted on
     13 Nov 2026 (owner). The account is real and the API accepts it -
     POST /api/auth/login - so it is still what the Puck editor and any script
     authenticate with, and what the new admin will use when P11-T2 builds it. */
  console.log('The account is ready. There is no admin UI yet (P11-T2);');
  console.log('authenticate against POST /api/auth/login.');
  await close();
})().catch(err => {
  console.error('\nCould not create the administrator:', err.message);
  process.exit(1);
});
