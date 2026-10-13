# share-v1-dashboards

Dashboard analytics and charts shared by the Share apps
(share.stream, formless-wallet, formless-dashboard).

- `DashboardManager` builds revenue analytics from USDC transfers read
  from each chain's JSON-RPC node via `alchemy_getAssetTransfers`
  (no Covalent dependency): transaction history by recipient, split
  revenue via transaction graph traversal, time buckets, totals and
  trends.
- `StyledLineChart` is the revenue/transactions area chart.

## Usage

Add this repository as a submodule under the app's `src`, next to
`share-v1-common-types`:

```bash
git submodule add https://github.com/formless-eng/share-v1-dashboards.git frontend/src/share-v1-dashboards
```

The code is compiled from source by the app, so `react`, `recharts`,
`viem`, `p-retry` and `regression` come from the app's
`node_modules`. Do not run `npm install` inside the submodule
checkout of an app, a second copy of React breaks hooks.

Each app binds its own dependencies in a thin wrapper, so that
call sites can construct the manager without arguments:

```ts
import { getEndpointForChainId } from "adapters/DatabaseClient";
import { SHARE_MAX_TRANSFERS_PAGE_COUNT } from "common/Constants";
import log from "common/LoggingUtils";
import { DashboardManager as SharedDashboardManager } from "share-v1-dashboards/src";

export class DashboardManager extends SharedDashboardManager {
  constructor() {
    super({
      fetchRPCEndpoint: async (chainId) =>
        ((await getEndpointForChainId(chainId)) as { rpc_endpoint: string })
          .rpc_endpoint,
      log,
      maxTransfersPageCount: +SHARE_MAX_TRANSFERS_PAGE_COUNT,
    });
  }
}
```

`StyledLineChart` takes the current `theme` (`"light"` or `"dark"`)
as a prop and reads the app's Tailwind CSS color tokens
(`--surface-primary`, `--surface-tertiary`, `--primary`).

## Development

```bash
npm install
npm test
npm run typecheck
```
