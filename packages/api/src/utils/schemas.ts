import type { Rollup } from "@blobscan/db";
import { z } from "@blobscan/zod";

export const rollupSchema = z
  .enum(["arbitrum", "base", "optimism", "scroll", "starknet", "zksync"])
  .transform<Rollup>((rollup) => {
    return rollup.toUpperCase() as Rollup;
  });
