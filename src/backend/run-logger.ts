import fs from 'fs/promises';
import path from 'path';

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'step' | 'detail';

export interface LogEntry {
  ts: number;       // unix ms
  level: LogLevel;
  msg: string;
}

/**
 * Writes structured log entries to both the console and a per-run JSONL file
 * (data/runs/{runId}/run_log.jsonl).
 *
 * Each line in the file is a self-contained JSON object so the UI can parse
 * any window of lines without loading the whole file.
 */
export class RunLogger {
  private filePath: string;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string, runId: string) {
    this.filePath = path.join(dataDir, 'runs', runId, 'run_log.jsonl');
  }

  log(level: LogLevel, msg: string): void {
    const entry: LogEntry = { ts: Date.now(), level, msg };

    // Console output (with simple prefix)
    const prefix: Record<LogLevel, string> = {
      info:    '',
      success: '✓ ',
      warn:    '⚠️  ',
      error:   '✗ ',
      step:    '⚙️  ',
      detail:  '  ',
    };
    console.log(`${prefix[level]}${msg}`);

    // Buffer to file (flush in batches for performance)
    this.buffer.push(JSON.stringify(entry));
    this.scheduleFlush();
  }

  // Convenience helpers
  info   (msg: string) { this.log('info',    msg); }
  success(msg: string) { this.log('success', msg); }
  warn   (msg: string) { this.log('warn',    msg); }
  error  (msg: string) { this.log('error',   msg); }
  step   (msg: string) { this.log('step',    msg); }
  detail (msg: string) { this.log('detail',  msg); }

  /** Flush immediately — call at the start/end of a run to ensure visibility. */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    await this.writeBuffer();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      await this.writeBuffer();
    }, 300);
  }

  private async writeBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    const lines = this.buffer.splice(0);
    try {
      await fs.appendFile(this.filePath, lines.join('\n') + '\n', 'utf-8');
    } catch {
      // Non-fatal — log is best-effort
    }
  }
}
