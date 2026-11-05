import type { Rect } from "@swipt/api";
import { asc, desc, eq, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/expo-sqlite/driver";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { openDatabaseSync } from "expo-sqlite";

export const records = sqliteTable(
  "records",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    time: integer().notNull(),
    app: text().notNull(),
    kind: text({ enum: ["skip", "close"] }).notNull(),
    fuzzy: integer({ mode: "boolean" }).notNull(),
    quick: integer({ mode: "boolean" }).notNull(),
    ms: integer().notNull(),
    text: text().notNull(),
    appeared: integer(),
    detected: integer(),
    tapMs: integer("tap_ms"),
    gone: integer(),
  },
  (table) => [
    index("records_time").on(table.time),
    index("records_app").on(table.app),
  ],
);

export const controls = sqliteTable(
  "controls",
  {
    app: text().notNull(),
    position: integer().notNull(),
    x: real().notNull(),
    y: real().notNull(),
    width: real().notNull(),
    height: real().notNull(),
    class: text(),
  },
  (table) => [primaryKey({ columns: [table.app, table.position] })],
);

export const settings = sqliteTable("settings", {
  id: integer().primaryKey(),
  fuzzySkip: integer("fuzzy_skip", { mode: "boolean" })
    .notNull()
    .default(false),
  closePopups: integer("close_popups", { mode: "boolean" })
    .notNull()
    .default(true),
});

export const disabledApps = sqliteTable("disabled_apps", {
  app: text().primaryKey(),
});

export type RecordRow = typeof records.$inferSelect;
export type NewRecord = typeof records.$inferInsert;
export type SettingsRow = typeof settings.$inferSelect;

const schema = { records, controls, settings, disabledApps };

const create = [
  sql`CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, app TEXT NOT NULL, kind TEXT NOT NULL,
    fuzzy INTEGER NOT NULL, quick INTEGER NOT NULL, ms INTEGER NOT NULL, text TEXT NOT NULL,
    appeared INTEGER, detected INTEGER, tap_ms INTEGER, gone INTEGER
  )`,
  sql`CREATE INDEX IF NOT EXISTS records_time ON records (time)`,
  sql`CREATE INDEX IF NOT EXISTS records_app ON records (app)`,
  sql`CREATE TABLE IF NOT EXISTS controls (
    app TEXT NOT NULL, position INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, class TEXT,
    PRIMARY KEY (app, position)
  )`,
  sql`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, fuzzy_skip INTEGER NOT NULL DEFAULT 0, close_popups INTEGER NOT NULL DEFAULT 1)`,
  sql`CREATE TABLE IF NOT EXISTS disabled_apps (app TEXT PRIMARY KEY)`,
  sql`INSERT OR IGNORE INTO settings (id) VALUES (1)`,
];

const open = () => {
  const db = drizzle(
    openDatabaseSync("skip-chinese-ads.db", { enableChangeListener: true }),
    { schema },
  );
  for (const statement of create) {
    db.run(statement);
  }
  return db;
};

let opened: ReturnType<typeof open> | undefined;

export const db = () => (opened ??= open());

export const latestRecords = () =>
  db().select().from(records).orderBy(desc(records.time), desc(records.id));

export interface Settings {
  disabledApps: string[];
  fuzzySkip: boolean;
  closePopups: boolean;
}

export interface SkipControl {
  frame: Rect;
  class?: string;
}

const recordLimit = 2_000;

const row = (): SettingsRow =>
  db().select().from(settings).where(eq(settings.id, 1)).get() ?? {
    id: 1,
    fuzzySkip: false,
    closePopups: true,
  };

export const readSettings = async (): Promise<Settings> => ({
  ...row(),
  disabledApps: db()
    .select({ app: disabledApps.app })
    .from(disabledApps)
    .all()
    .map((entry) => entry.app),
});

export const setFuzzySkip = (fuzzySkip: boolean) =>
  db().update(settings).set({ fuzzySkip }).where(eq(settings.id, 1)).run();

export const setClosePopups = (closePopups: boolean) =>
  db().update(settings).set({ closePopups }).where(eq(settings.id, 1)).run();

export const setAppEnabled = (app: string, enabled: boolean) => {
  if (enabled) {
    db().delete(disabledApps).where(eq(disabledApps.app, app)).run();
  } else {
    db().insert(disabledApps).values({ app }).onConflictDoNothing().run();
  }
};

export const setAppsEnabled = (apps: string[], enabled: boolean) => {
  db().transaction((transaction) => {
    for (const app of apps) {
      if (enabled) {
        transaction.delete(disabledApps).where(eq(disabledApps.app, app)).run();
      } else {
        transaction
          .insert(disabledApps)
          .values({ app })
          .onConflictDoNothing()
          .run();
      }
    }
  });
};

export const readControls = async (app: string): Promise<SkipControl[]> =>
  db()
    .select()
    .from(controls)
    .where(eq(controls.app, app))
    .orderBy(asc(controls.position))
    .all()
    .map((control) => ({
      frame: [control.x, control.y, control.width, control.height] as Rect,
      class: control.class ?? undefined,
    }));

export const writeControls = async (app: string, learned: SkipControl[]) => {
  db().transaction((transaction) => {
    transaction.delete(controls).where(eq(controls.app, app)).run();
    if (learned.length > 0) {
      transaction
        .insert(controls)
        .values(
          learned.map(
            ({ frame: [x, y, width, height], class: name }, position) => ({
              app,
              position,
              x,
              y,
              width,
              height,
              class: name ?? null,
            }),
          ),
        )
        .run();
    }
  });
};

export const appendRecord = async (record: NewRecord) => {
  db().transaction((transaction) => {
    transaction.insert(records).values(record).run();
    transaction
      .delete(records)
      .where(
        notInArray(
          records.id,
          transaction
            .select({ id: records.id })
            .from(records)
            .orderBy(sql`id DESC`)
            .limit(recordLimit),
        ),
      )
      .run();
  });
};

export const recordedApps = async (): Promise<string[]> =>
  db()
    .select({ app: records.app, latest: sql<number>`max(${records.time})` })
    .from(records)
    .groupBy(records.app)
    .orderBy(sql`max(${records.time}) DESC`)
    .all()
    .map((entry) => entry.app);
