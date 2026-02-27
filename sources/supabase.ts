import type { ErrorEvent, Source, WatchdogConfig } from "../types.ts";

const API_BASE = "https://api.supabase.com/v1";
const MAX_QUERY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

interface ApiResponse {
  result: LogRow[] | null;
  error: unknown;
}

interface LogRow {
  timestamp: number; // Unix microseconds
  event_message?: string;
  [key: string]: unknown;
}

const ERROR_QUERIES: Record<string, string> = {
  edge_logs: `
    select
      timestamp,
      event_message,
      metadata[0].response[0].status_code as status_code,
      metadata[0].request[0].method as method,
      metadata[0].request[0].path as path
    from edge_logs
    cross join unnest(metadata) as metadata
    cross join unnest(metadata.response) as response
    where response.status_code >= {{MIN_STATUS}}
    order by timestamp desc
    limit 200
  `,

  auth_logs: `
    select
      timestamp,
      event_message,
      metadata[0].status as status_code,
      metadata[0].path as path,
      metadata[0].msg as msg
    from auth_logs
    cross join unnest(metadata) as metadata
    where metadata.level in ('error', 'fatal')
       or metadata.status >= {{MIN_STATUS}}
    order by timestamp desc
    limit 200
  `,

  postgres_logs: `
    select
      timestamp,
      event_message,
      metadata[0].parsed[0].error_severity as error_severity,
      metadata[0].parsed[0].sql_state_code as sql_state_code,
      metadata[0].parsed[0].query as query,
      metadata[0].parsed[0].user_name as user_name
    from postgres_logs
    cross join unnest(metadata) as metadata
    cross join unnest(metadata.parsed) as parsed
    where regexp_contains(parsed.error_severity, 'ERROR|FATAL|PANIC')
    order by timestamp desc
    limit 200
  `,

  storage_logs: `
    select
      timestamp,
      event_message,
      metadata[0].statusCode as status_code,
      metadata[0].error as error,
      metadata[0].type as type
    from storage_logs
    cross join unnest(metadata) as metadata
    where metadata.statusCode >= {{MIN_STATUS}}
       or metadata.error is not null
    order by timestamp desc
    limit 200
  `,

  realtime_logs: `
    select
      timestamp,
      event_message,
      metadata[0].level as level
    from realtime_logs
    cross join unnest(metadata) as metadata
    where metadata.level in ('error', 'fatal')
    order by timestamp desc
    limit 200
  `,

  postgrest_logs: `
    select
      timestamp,
      event_message,
      metadata[0].response[0].status_code as status_code
    from postgrest_logs
    cross join unnest(metadata) as metadata
    cross join unnest(metadata.response) as response
    where response.status_code >= {{MIN_STATUS}}
    order by timestamp desc
    limit 200
  `,

  supavisor_logs: `
    select
      timestamp,
      event_message,
      metadata[0].level as level
    from supavisor_logs
    cross join unnest(metadata) as metadata
    where metadata.level in ('error', 'fatal')
    order by timestamp desc
    limit 200
  `,
};

export class SupabaseSource implements Source {
  readonly name = "supabase";

  private accessToken: string;
  private projects: WatchdogConfig["projects"];
  private sources: string[];
  private minStatusCode: number;
  private ignorePatterns: string[];

  constructor(config: WatchdogConfig) {
    this.accessToken = config.supabase.access_token;
    this.projects = config.projects;
    this.sources = config.polling.sources;
    this.minStatusCode = config.filters.min_status_code;
    this.ignorePatterns = config.filters.ignore_patterns;
  }

  async poll(since: Date): Promise<ErrorEvent[]> {
    const now = new Date();

    // Clamp to 24h max window
    const earliest = new Date(now.getTime() - MAX_QUERY_WINDOW_MS);
    const effectiveSince = since < earliest ? earliest : since;

    const allEvents: ErrorEvent[] = [];

    for (const project of this.projects) {
      for (const logSource of this.sources) {
        try {
          const events = await this.queryLogSource(
            project.ref,
            project.name,
            logSource,
            effectiveSince,
            now,
          );
          allEvents.push(...events);
        } catch (error) {
          console.warn(
            `[watchdog] Failed to query ${logSource} for ${project.name}: ${error}`,
          );
        }
      }
    }

    return this.applyIgnorePatterns(allEvents);
  }

  private buildQuery(logSource: string): string {
    const template = ERROR_QUERIES[logSource];
    if (!template) {
      return `select timestamp, event_message from ${logSource} order by timestamp desc limit 100`;
    }
    return template.replaceAll("{{MIN_STATUS}}", String(this.minStatusCode));
  }

  private async queryApi(
    ref: string,
    sql: string,
    since: Date,
    until: Date,
  ): Promise<LogRow[]> {
    const url = new URL(
      `${API_BASE}/projects/${ref}/analytics/endpoints/logs.all`,
    );
    url.searchParams.set("sql", sql);
    url.searchParams.set("iso_timestamp_start", since.toISOString());
    url.searchParams.set("iso_timestamp_end", until.toISOString());

    const response = await fetch(url.toString(), {
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Management API returned ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as ApiResponse;

    if (body.error) {
      throw new Error(
        `Management API query error: ${JSON.stringify(body.error)}`,
      );
    }

    return body.result ?? [];
  }

  private async queryLogSource(
    ref: string,
    projectName: string,
    logSource: string,
    since: Date,
    until: Date,
  ): Promise<ErrorEvent[]> {
    const sql = this.buildQuery(logSource);
    const rows = await this.queryApi(ref, sql, since, until);

    return rows.map((row) => this.rowToEvent(row, ref, projectName, logSource));
  }

  private rowToEvent(
    row: LogRow,
    ref: string,
    projectName: string,
    logSource: string,
  ): ErrorEvent {
    // Timestamp: API returns unix microseconds
    const ts =
      typeof row.timestamp === "number"
        ? new Date(row.timestamp / 1000)
        : new Date();

    // Status code: varies by source
    const statusCode =
      typeof row.status_code === "number" ? row.status_code : undefined;

    // Message: prefer event_message, fall back to other fields
    const message =
      row.event_message ?? row.msg ?? row.error ?? row.query ?? "Unknown error";

    // Collect remaining fields as metadata
    const {
      timestamp: _ts,
      event_message: _em,
      status_code: _sc,
      ...rest
    } = row;

    return {
      project: projectName,
      projectRef: ref,
      source: logSource,
      timestamp: ts.toISOString(),
      statusCode,
      message: String(message),
      metadata: Object.keys(rest).length > 0 ? rest : undefined,
    };
  }

  private applyIgnorePatterns(events: ErrorEvent[]): ErrorEvent[] {
    if (this.ignorePatterns.length === 0) return events;

    const lowered = this.ignorePatterns.map((p) => p.toLowerCase());
    return events.filter((event) => {
      const msg = event.message.toLowerCase();
      return !lowered.some((pattern) => msg.includes(pattern));
    });
  }
}
