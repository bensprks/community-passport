import { join } from "node:path";
import { createApp } from "./app.ts";
import { ConsoleMailer } from "./auth.ts";
import { createChain } from "./chain.ts";
import { loadClubs, policySettings } from "./clubs.ts";
import { loadConfig } from "./config.ts";
import { AttestingProver } from "./emailProof.ts";
import { openDb, purgeExpired } from "./db.ts";
import { LocalKeyStore } from "./keystore.ts";

const config = loadConfig();
const db = openDb(join(config.dataDir, "passport.sqlite"));
const chain = createChain(config);
const clubs = loadClubs(config.clubsFile, config.scopeTargets);

console.warn(
  config.email
    ? "Accounts are rooted in members' emails. Development stand-ins in use: one key vouches for emails, and mail is printed here."
    : "Development key store and mailer in use: keys live in this server's database, codes are printed here.",
);
const { app } = await createApp({
  config,
  db,
  clubs,
  chain,
  keyStore: new LocalKeyStore(db, chain, config.keyStoreSecret, policySettings(config.chainId, config.grantRegistry, clubs)),
  mailer: new ConsoleMailer(),
  emailProver: config.email && new AttestingProver(config.email.attestorKey, config.chainId, config.email.verifier),
});

setInterval(() => purgeExpired(db), 60 * 60 * 1000).unref();

app.listen(config.port, () => {
  console.log(`Passport listening on ${config.issuer} for ${clubs.size} app(s), relayer ${chain.relayerAddress}`);
});
