// Per-user settings (user_settings). A user without a row has the defaults; the row is written on the
// first change.
import type { UpdateSettingsRequest, UserSettings } from "@pxdict/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { userSettings } from "../db/schema";

export class SettingsStore {
  constructor(
    private readonly db: Db,
    /** HISTORY_DEFAULT_RETENTION_DAYS. */
    private readonly defaultRetentionDays: number,
  ) {}

  defaults(): UserSettings {
    return {
      historyEnabled: true,
      historyRetentionDays: this.defaultRetentionDays,
      defaultMode: "exact",
      uiLang: null,
      theme: "system",
      fontSize: "medium",
    };
  }

  get(userId: string): UserSettings {
    const row = this.db.select().from(userSettings).where(eq(userSettings.userId, userId)).get();
    if (!row) return this.defaults();
    return {
      historyEnabled: row.historyEnabled,
      historyRetentionDays: row.historyRetentionDays,
      defaultMode: row.defaultMode,
      uiLang: row.uiLang,
      theme: row.theme,
      fontSize: row.fontSize,
    };
  }

  update(userId: string, changes: UpdateSettingsRequest): UserSettings {
    const next: UserSettings = { ...this.get(userId) };
    // Only defined keys change (exactOptionalPropertyTypes keeps undefined out of the type, not the value).
    for (const [k, v] of Object.entries(changes) as [keyof UserSettings, unknown][]) {
      if (v !== undefined) (next as Record<keyof UserSettings, unknown>)[k] = v;
    }
    const values = { ...next, updatedAt: new Date() };
    this.db
      .insert(userSettings)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: userSettings.userId, set: values })
      .run();
    return next;
  }
}
