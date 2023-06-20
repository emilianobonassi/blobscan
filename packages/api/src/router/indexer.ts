import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { statsAggregator } from "@blobscan/db";

import { BUCKET_NAME } from "../env";
import { createTRPCRouter, jwtAuthedProcedure, publicProcedure } from "../trpc";
import { calculateBlobSize } from "../utils/blob";
import { getNewBlobs, getUniqueAddressesFromTxs } from "../utils/indexer";
import { buildGoogleStorageUri } from "../utils/storages";

const INDEXER_PATH = "/indexer";
const INDEX_REQUEST_DATA = z.object({
  block: z.object({
    number: z.coerce.number(),
    hash: z.string(),
    timestamp: z.coerce.number(),
    slot: z.coerce.number(),
  }),
  transactions: z.array(
    z.object({
      hash: z.string(),
      from: z.string(),
      to: z.string().optional(),
      blockNumber: z.coerce.number(),
    }),
  ),
  blobs: z.array(
    z.object({
      versionedHash: z.string(),
      commitment: z.string(),
      data: z.string(),
      txHash: z.string(),
      index: z.coerce.number(),
    }),
  ),
});

export const indexerRouter = createTRPCRouter({
  getSlot: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: `${INDEXER_PATH}/slot`,
        tags: ["indexer"],
        summary: "Get the indexer's latest indexed slot",
      },
    })
    .input(z.void())
    .output(z.object({ slot: z.number() }))
    .query(async ({ ctx }) => {
      const indexerMetadata = await ctx.prisma.indexerMetadata.findUnique({
        where: { id: 1 },
      });

      return { slot: indexerMetadata?.lastSlot ?? 0 };
    }),
  updateSlot: jwtAuthedProcedure
    .meta({
      openapi: {
        method: "PUT",
        path: `${INDEXER_PATH}/slot`,
        tags: ["indexer"],
        summary: "Update the indexer's latest indexed slot",
        protect: true,
      },
    })
    .input(z.object({ slot: z.number() }))
    .output(z.void())
    .mutation(async ({ ctx, input }) => {
      const slot = input.slot;

      await ctx.prisma.indexerMetadata.upsert({
        where: { id: 1 },
        update: {
          lastSlot: slot,
        },
        create: {
          id: 1,
          lastSlot: slot,
        },
      });
    }),
  index: jwtAuthedProcedure
    .meta({
      openapi: {
        method: "PUT",
        path: `${INDEXER_PATH}/block-txs-blobs`,
        tags: ["indexer"],
        summary: "Index data in the database",
        protect: true,
      },
    })
    .input(INDEX_REQUEST_DATA)
    .output(z.void())
    .mutation(async ({ ctx: { prisma, storage, swarm }, input }) => {
      const timestamp = new Date(input.block.timestamp * 1000);

      // 1. Check we have enough swarm postages

      const batches = await swarm.beeDebug.getAllPostageBatch();

      if (batches.length === 0 || batches[0]?.batchID === undefined) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Not available Swarm postages`,
        });
      }

      // 2. Fetch unique addresses from transactions & check for existing blobs

      const [{ uniqueFromAddresses, uniqueToAddresses }, newBlobs] =
        await Promise.all([
          getUniqueAddressesFromTxs(prisma, input.transactions),
          getNewBlobs(prisma, input.blobs),
        ]);

      // 3. Upload blobs' data to Google Storage and Swarm

      const batchId = batches[0].batchID;
      const uploadBlobsPromise = newBlobs.map(async (b) => {
        const uploadBlobsToGoogleStoragePromise = storage
          .bucket(BUCKET_NAME)
          .file(buildGoogleStorageUri(b.versionedHash))
          .save(b.data);

        const uploadBlobsToSwarmPromise = swarm.bee.uploadFile(
          batchId,
          b.data,
          buildGoogleStorageUri(b.versionedHash),
          {
            pin: true,
            contentType: "text/plain",
          },
        );

        const [, swarmUploadData] = await Promise.all([
          uploadBlobsToGoogleStoragePromise,
          uploadBlobsToSwarmPromise,
        ]);

        return {
          id: b.versionedHash,
          versionedHash: b.versionedHash,
          commitment: b.commitment,
          gsUri: buildGoogleStorageUri(b.versionedHash),
          swarmHash: swarmUploadData.reference.toString(),
          size: calculateBlobSize(b.data),
        };
      });
      const uploadedBlobs = await Promise.all(uploadBlobsPromise);

      // 4. Prepare block, transaction and blob insertions

      const createBlobsDataPromise = prisma.blob.createMany({
        data: uploadedBlobs,
      });

      const blockData = {
        number: input.block.number,
        hash: input.block.hash,
        timestamp,
        slot: input.block.slot,
      };

      const createBlockPromise = prisma.block.upsert({
        where: { id: input.block.number },
        create: {
          id: input.block.number,
          ...blockData,
        },
        update: blockData,
      });
      const createAddressesPromise = prisma.address.createMany({
        data: [...uniqueFromAddresses.new, ...uniqueToAddresses.new],
      });
      const updateAddressesPromise = prisma.address.updateMany({
        data: [...uniqueFromAddresses.existing, ...uniqueToAddresses.existing],
      });
      const createTransactionsPromises = prisma.transaction.createMany({
        data: input.transactions.map((transaction) => ({
          id: transaction.hash,
          hash: transaction.hash,
          fromId: transaction.from,
          toId: transaction.to,
          blockNumber: transaction.blockNumber,
          timestamp,
        })),
        // TODO: to make the endpoint truly idempotent we should not skip duplicates but update them when re-indexing
        skipDuplicates: true,
      });
      const createBlobsOnTransactionPromise =
        prisma.blobsOnTransactions.createMany({
          data: input.blobs.map((blob) => ({
            blobHash: blob.versionedHash,
            txHash: blob.txHash,
            index: blob.index,
          })),
          skipDuplicates: true,
        });

      // 5. Prepare overall stats incremental updates

      const uploadedBlobsSize = uploadedBlobs.reduce(
        (totalBlobSize, b) => totalBlobSize + b.size,
        0,
      );
      const totalReceivers =
        uniqueToAddresses.existing.length + uniqueToAddresses.new.length;
      const totalSenders =
        uniqueFromAddresses.existing.length + uniqueFromAddresses.new.length;

      const updateBlockOverallStatsPromise =
        statsAggregator.block.updateOverallBlockStats(1);
      const updateTxOverallStatsPromise =
        statsAggregator.tx.updateOverallTxStats(
          input.transactions.length,
          totalReceivers,
          totalSenders,
        );
      const updateBlobOverallStatsPromise =
        statsAggregator.blob.updateOverallBlobStats(
          input.blobs.length,
          uploadedBlobs.length,
          uploadedBlobsSize,
        );

      // 6. Execute all database operations in a single transaction

      await prisma.$transaction([
        createBlockPromise,
        updateAddressesPromise,
        createAddressesPromise,
        createTransactionsPromises,
        createBlobsDataPromise,
        createBlobsOnTransactionPromise,
        updateBlockOverallStatsPromise,
        updateTxOverallStatsPromise,
        updateBlobOverallStatsPromise,
      ]);
    }),
});
