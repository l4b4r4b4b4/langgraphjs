import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  type SerializerProtocol,
  type PendingWrite,
  type CheckpointMetadata,
  type ChannelVersions,
  WRITES_IDX_MAP,
} from "@langchain/langgraph-checkpoint";
import pg from "pg";

import { MIGRATIONS } from "./migrations.js";
import {
  INSERT_CHECKPOINT_WRITES_SQL,
  SELECT_SQL,
  UPSERT_CHECKPOINT_BLOBS_SQL,
  UPSERT_CHECKPOINT_WRITES_SQL,
  UPSERT_CHECKPOINTS_SQL,
} from "./sql.js";

const { Pool } = pg;

interface CheckpointRow {
  checkpoint: Omit<Checkpoint, "pending_sends" | "channel_values">;
  metadata: Record<string, unknown>;
  parent_checkpoint_id?: string;
  thread_id: string;
  checkpoint_id: string;
  checkpoint_ns?: string;
  channel_values: [Uint8Array, Uint8Array, Uint8Array][];
  pending_writes: [Uint8Array, Uint8Array, Uint8Array, Uint8Array][];
  pending_sends: [Uint8Array, Uint8Array][];
}

export class PostgresSaver extends BaseCheckpointSaver {
  private pool: pg.Pool;

  protected isSetup: boolean;

  constructor(pool: pg.Pool, serde?: SerializerProtocol) {
    super(serde);
    this.pool = pool;
    this.isSetup = false;
  }

  static fromConnString(connString: string): PostgresSaver {
    const pool = new Pool({ connectionString: connString });
    return new PostgresSaver(pool);
  }

  /**
   * Set up the checkpoint database asynchronously.
   *
   * This method creates the necessary tables in the Postgres database if they don't
   * already exist and runs database migrations. It MUST be called directly by the user
   * the first time checkpointer is used.
   */
  async setup(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      let version = -1;
      try {
        const result = await client.query(
          "SELECT v FROM checkpoint_migrations ORDER BY v DESC LIMIT 1"
        );
        if (result.rows.length > 0) {
          version = result.rows[0].v;
        }
      } catch (error: any) {
        // Assume table doesn't exist if there's an error
        if (
          error?.message.includes(
            'relation "checkpoint_migrations" does not exist'
          )
        ) {
          version = -1;
        } else {
          throw error;
        }
      }

      for (let v = version + 1; v < MIGRATIONS.length; v++) {
        await client.query(MIGRATIONS[v]);
        await client.query(
          "INSERT INTO checkpoint_migrations (v) VALUES ($1)",
          [v]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  protected _loadCheckpoint(
    checkpoint: Omit<Checkpoint, "pending_sends" | "channel_values">,
    channelValues: [Uint8Array, Uint8Array, Uint8Array][],
    pendingSends: [Uint8Array, Uint8Array][]
  ): Checkpoint {
    return {
      ...checkpoint,
      pending_sends: (pendingSends || []).map(([c, b]) =>
        this.serde.loadsTyped(c.toString(), b)
      ),
      channel_values: this._loadBlobs(channelValues),
    };
  }

  protected _loadBlobs(
    blobValues: [Uint8Array, Uint8Array, Uint8Array][]
  ): Record<string, any> {
    if (!blobValues || blobValues.length === 0) {
      return {};
    }
    return Object.fromEntries(
      blobValues
        .filter(([, t]) => new TextDecoder().decode(t) !== "empty")
        .map(([k, t, v]) => [
          new TextDecoder().decode(k),
          this.serde.loadsTyped(new TextDecoder().decode(t), v),
        ])
    );
  }

  protected _loadMetadata(metadata: Record<string, unknown>) {
    const [type, dumpedValue] = this.serde.dumpsTyped(metadata);
    return this.serde.loadsTyped(type, dumpedValue);
  }

  protected _loadWrites(
    writes: [Uint8Array, Uint8Array, Uint8Array, Uint8Array][]
  ): [string, string, any][] {
    const decoder = new TextDecoder();
    return writes
      ? writes.map(([tid, channel, t, v]) => [
          decoder.decode(tid),
          decoder.decode(channel),
          this.serde.loadsTyped(decoder.decode(t), v),
        ])
      : [];
  }

  protected _dumpBlobs(
    threadId: string,
    checkpointNs: string,
    values: Record<string, any>,
    versions: ChannelVersions
  ): [string, string, string, string, string, Uint8Array | undefined][] {
    if (!versions) {
      return [];
    }

    return Object.entries(versions).map(([k, ver]) => {
      const [type, value] =
        k in values ? this.serde.dumpsTyped(values[k]) : ["empty", null];
      return [
        threadId,
        checkpointNs,
        k,
        ver.toString(),
        type,
        value ? new Uint8Array(value) : undefined,
      ];
    });
  }

  protected _dumpCheckpoint(checkpoint: Checkpoint) {
    return this.serde.dumpsTyped({ ...checkpoint, pending_sends: [] });
  }

  protected _dumpMetadata(metadata: CheckpointMetadata): string {
    const [, serializedMetadata] = this.serde.dumpsTyped(metadata);
    // We need to remove null characters before writing
    return new TextDecoder().decode(serializedMetadata).replace(/\u0000/g, "");
  }

  protected _dumpWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
    taskId: string,
    writes: [string, any][]
  ): [string, string, string, string, number, string, string, Uint8Array][] {
    return writes.map(([channel, value], idx) => {
      const [type, serializedValue] = this.serde.dumpsTyped(value);
      return [
        threadId,
        checkpointNs,
        checkpointId,
        taskId,
        WRITES_IDX_MAP[channel] !== undefined ? WRITES_IDX_MAP[channel] : idx,
        channel,
        type,
        new Uint8Array(serializedValue),
      ];
    });
  }

  /**
   * Return WHERE clause predicates for alist() given config, filter, cursor.
   *
   * This method returns a tuple of a string and a tuple of values. The string
   * is the parametered WHERE clause predicate (including the WHERE keyword):
   * "WHERE column1 = $1 AND column2 IS $2". The list of values contains the
   * values for each of the corresponding parameters.
   */
  protected _searchWhere(
    config?: RunnableConfig,
    filter?: Record<string, unknown>,
    before?: RunnableConfig
  ): [string, any[]] {
    const wheres: string[] = [];
    const paramValues: any[] = [];

    // construct predicate for config filter
    if (config?.configurable) {
      wheres.push("thread_id = $" + (paramValues.length + 1));
      paramValues.push(config.configurable.thread_id);

      const checkpointNs = config.configurable.checkpoint_ns;
      if (checkpointNs !== undefined) {
        wheres.push("checkpoint_ns = $" + (paramValues.length + 1));
        paramValues.push(checkpointNs);
      }

      const checkpointId = config.configurable.checkpoint_id;
      if (checkpointId !== undefined) {
        wheres.push("checkpoint_id = $" + (paramValues.length + 1));
        paramValues.push(checkpointId);
      }
    }

    // construct predicate for metadata filter
    if (filter && Object.keys(filter).length > 0) {
      wheres.push("metadata @> $" + (paramValues.length + 1));
      paramValues.push(JSON.stringify(filter));
    }

    // construct predicate for `before`
    if (before?.configurable?.checkpoint_id !== undefined) {
      wheres.push("checkpoint_id < $" + (paramValues.length + 1));
      paramValues.push(before.configurable.checkpoint_id);
    }

    return [
      wheres.length > 0 ? "WHERE " + wheres.join(" AND ") : "",
      paramValues,
    ];
  }

  /**
   * Get a checkpoint tuple from the database.
   * This method retrieves a checkpoint tuple from the Postgres database
   * based on the provided config. If the config's configurable field contains
   * a "checkpoint_id" key, the checkpoint with the matching thread_id and
   * namespace is retrieved. Otherwise, the latest checkpoint for the given
   * thread_id is retrieved.
   * @param config The config to use for retrieving the checkpoint.
   * @returns The retrieved checkpoint tuple, or undefined.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable ?? {};

    let row: CheckpointRow | undefined;
    let args: any[];
    let where: string;
    if (checkpoint_id) {
      where = `WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3`;
      args = [thread_id, checkpoint_ns, checkpoint_id];
    } else {
      where = `WHERE thread_id = $1 AND checkpoint_ns = $2 ORDER BY checkpoint_id DESC LIMIT 1`;
      args = [thread_id, checkpoint_ns];
    }

    const result = await this.pool.query(SELECT_SQL + where, args);

    [row] = result.rows;

    if (row === undefined) {
      return undefined;
    }

    const checkpoint = this._loadCheckpoint(
      row.checkpoint,
      row.channel_values,
      row.pending_sends
    );
    const finalConfig = {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: row.checkpoint_id,
      },
    };
    const metadata = this._loadMetadata(row.metadata);
    const parentConfig = row.parent_checkpoint_id
      ? {
          configurable: {
            thread_id,
            checkpoint_ns,
            checkpoint_id: row.parent_checkpoint_id,
          },
        }
      : undefined;
    const pendingWrites = this._loadWrites(row.pending_writes);

    return {
      config: finalConfig,
      checkpoint,
      metadata,
      parentConfig,
      pendingWrites,
    };
  }

  /**
   * List checkpoints from the database.
   *
   * This method retrieves a list of checkpoint tuples from the Postgres database based
   * on the provided config. The checkpoints are ordered by checkpoint ID in descending order (newest first).
   */
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { filter, before, limit } = options ?? {};
    const [where, args] = this._searchWhere(config, filter, before);
    let query = SELECT_SQL + where + " ORDER BY checkpoint_id DESC";
    if (limit !== undefined) {
      query += ` LIMIT ${limit}`;
    }

    const result = await this.pool.query(query, args);
    for (const value of result.rows) {
      yield {
        config: {
          configurable: {
            thread_id: value.thread_id,
            checkpoint_ns: value.checkpoint_ns,
            checkpoint_id: value.checkpoint_id,
          },
        },
        checkpoint: this._loadCheckpoint(
          value.checkpoint,
          value.channel_values,
          value.pending_sends
        ),
        metadata: this._loadMetadata(value.metadata),
        parentConfig: value.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: value.thread_id,
                checkpoint_ns: value.checkpoint_ns,
                checkpoint_id: value.parent_checkpoint_id,
              },
            }
          : undefined,
        pendingWrites: this._loadWrites(value.pending_writes),
      };
    }
  }

  /**
   * Save a checkpoint to the database.
   *
   * This method saves a checkpoint to the Postgres database. The checkpoint is associated
   * with the provided config and its parent config (if any).
   * @param config
   * @param checkpoint
   * @param metadata
   * @returns
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    if (config.configurable === undefined) {
      throw new Error(`Missing "configurable" field in "config" param`);
    }
    const {
      thread_id,
      checkpoint_ns = "",
      checkpoint_id,
    } = config.configurable;

    const nextConfig = {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
    const client = await this.pool.connect();
    const [_, serializedCheckpoint] = this._dumpCheckpoint(checkpoint);
    try {
      await client.query("BEGIN");
      const serializedBlobs = this._dumpBlobs(
        thread_id,
        checkpoint_ns,
        checkpoint.channel_values,
        newVersions
      );
      for (const serializedBlob of serializedBlobs) {
        await client.query(UPSERT_CHECKPOINT_BLOBS_SQL, serializedBlob);
      }
      await client.query(UPSERT_CHECKPOINTS_SQL, [
        thread_id,
        checkpoint_ns,
        checkpoint.id,
        checkpoint_id,
        serializedCheckpoint,
        this._dumpMetadata(metadata),
      ]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return nextConfig;
  }

  /**
   * Store intermediate writes linked to a checkpoint.
   *
   * This method saves intermediate writes associated with a checkpoint to the Postgres database.
   * @param config Configuration of the related checkpoint.
   * @param writes List of writes to store.
   * @param taskId Identifier for the task creating the writes.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const query = writes.every((w) => w[0] in WRITES_IDX_MAP)
      ? UPSERT_CHECKPOINT_WRITES_SQL
      : INSERT_CHECKPOINT_WRITES_SQL;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        query,
        this._dumpWrites(
          config.configurable?.thread_id,
          config.configurable?.checkpoint_ns,
          config.configurable?.checkpoint_id,
          taskId,
          writes
        )
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
