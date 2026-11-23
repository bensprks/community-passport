#!/usr/bin/env bash
# Starts a local Monad node and deploys to it:
#   1. Lens, from the pinned submodule, the way its README describes: DeployMonad (the protocol), DeployLaunch (the
#      "lens" Namespace, the App, the SponsorRouter), then ActivateLaunch (opens the launch's gates);
#   2. the grant registry, with no upgrade delay and anvil's first account as admin and guardian.
# Then writes the addresses the Passport and the end-to-end test need to .data/local.json.
#
# Needs Foundry 1.8.0 or later (`anvil --network monad`), yarn (for the Lens contracts' own dependencies) and jq.
# Addresses are the same on every fresh node. Ctrl-C stops the node.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LENS="$ROOT/contracts/lib/lens-monad-protocol"
RPC=http://127.0.0.1:8545
# anvil's first account. Unlocked on the node, so no key is needed here.
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "Something is already listening on $RPC. Stop it first: the deployment expects a fresh node." >&2
  exit 1
fi

if [ ! -d "$LENS/node_modules" ] || [ ! -d "$LENS/lib/forge-std/src" ]; then
  echo "Preparing the Lens contracts (first run only)..."
  git -C "$ROOT" submodule update --init --recursive
  (cd "$LENS" && yarn install --frozen-lockfile --silent)
fi

anvil --network monad --auto-impersonate --enable-tx-gas-limit --port 8545 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null' EXIT INT TERM
until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do sleep 0.2; done

# A fresh node knows none of the Accounts an earlier run's Passport made, so its database starts over too.
rm -f "$ROOT/.data/passport.sqlite"*

echo "Deploying Lens and the grant registry to a local Monad node. This takes about a minute and a half..."
echo "  1/2 Lens"
(
  cd "$LENS"
  export MIGRATION_MODE=false
  export ADDRESS_BOOK=deployments/31337.json
  rm -f "$ADDRESS_BOOK" "$ADDRESS_BOOK.pending"
  forge script script/DeployMonad.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
  forge script script/PromoteAddressBook.s.sol --rpc-url "$RPC" --silent
  forge script script/DeployLaunch.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
  forge script script/PromoteAddressBook.s.sol --rpc-url "$RPC" --silent
  forge script script/ActivateLaunch.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
)

echo "  2/2 grant registry"
(
  cd "$ROOT/contracts"
  PASSPORT_ADMIN=$DEPLOYER PASSPORT_GUARDIAN=$DEPLOYER PASSPORT_UPGRADE_DELAY=0 \
    forge script script/Deploy.s.sol --rpc-url "$RPC" --unlocked --sender "$DEPLOYER" --broadcast --silent
)

mkdir -p "$ROOT/.data"
BOOK="$LENS/deployments/31337.json"
REGISTRY=$(jq -r '.returns.registry.value' "$ROOT/contracts/broadcast/Deploy.s.sol/31337/run-latest.json")
jq --arg registry "$REGISTRY" --arg rpc "$RPC" '{
  chainId: 31337,
  rpcUrl: $rpc,
  grantRegistry: $registry,
  accountFactory: .AccountFactory.address,
  feed: .LensGlobalFeed.address,
  graph: .LensGlobalGraph.address
}' "$BOOK" > "$ROOT/.data/local.json"
# The address book is the Lens repository's working file. Keep a copy and leave the submodule clean.
cp "$BOOK" "$ROOT/.data/lens-address-book.json"
rm -f "$BOOK" "$BOOK.pending"

cat "$ROOT/.data/local.json"
echo
echo "READY. Lens and the grant registry are deployed on $RPC (chain 31337)."
echo "Leave this running and use another terminal: \`pnpm e2e\` for the test, \`pnpm passport\` for the pages."
echo "Ctrl-C here stops the node."
wait $ANVIL_PID
