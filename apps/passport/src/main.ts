import { join } from "node:path";
import { createApp } from "./app.ts";
import { ConsoleMailer } from "./auth.ts";
import { createChain } from "./chain.ts";
import { loadClubs } from "./clubs.ts";
import { loadConfig } from "./config.ts";
import { openDb, purgeExpired } from "./db.ts";
import { LocalKeyStore } from "./keystore.ts";

const config = loadConfig();
const db = openDb(join(config.dataDir, "passport.sqlite"));
const chain = createChain(config);
const clubs = loadClubs(config.clubsFile);

console.warn("Development key store and mailer in use: keys live in this server's database, codes are printed here.");
const { app } = await createApp({
  config,
  db,
  clubs,
  chain,
  keyStore: new LocalKeyStore(db, chain, config.keyStoreSecret),
  mailer: new ConsoleMailer(),
});

setInterval(() => purgeExpired(db), 60 * 60 * 1000).unref();

app.listen(config.port, () => {
  console.log(`Passport listening on ${config.issuer} for ${clubs.size} app(s), relayer ${chain.relayerAddress}`);
});
