import fs from 'fs/promises';
import path from 'path';
import { OrchestratorConfig, OrchestratorConfigSchema, OrchestratorInfo } from './types';

export class ConfigLoader {
  private configsDir: string;
  private seedDir: string;
  private cache: Map<string, OrchestratorConfig> = new Map();

  constructor(dataDir: string = './data') {
    this.configsDir = path.join(dataDir, 'configs', 'orchestrators');
    // Seed configs are always the git-bundled ones at project root ./data
    this.seedDir = path.join(process.cwd(), 'data', 'configs', 'orchestrators');
  }

  /**
   * Copy any missing seed configs (from git) into the runtime configs dir.
   * This runs on first startup when DATA_DIR points to a persistent volume
   * that doesn't yet contain the bundled defaults.
   * Safe to call repeatedly — only copies files that don't already exist.
   */
  private async seedIfNeeded(): Promise<void> {
    const runtimeDir = path.resolve(this.configsDir);
    const seedDir = path.resolve(this.seedDir);

    // Skip if they're the same directory (local dev with DATA_DIR=./data)
    if (runtimeDir === seedDir) return;

    let seedFiles: string[];
    try {
      seedFiles = (await fs.readdir(seedDir)).filter(f => f.endsWith('.json'));
    } catch {
      return; // No seed dir — nothing to copy
    }

    await fs.mkdir(runtimeDir, { recursive: true });
    const existingFiles = new Set(await fs.readdir(runtimeDir).catch(() => []));

    for (const file of seedFiles) {
      if (!existingFiles.has(file)) {
        await fs.copyFile(path.join(seedDir, file), path.join(runtimeDir, file));
      }
    }
  }

  /**
   * Load a specific orchestrator configuration by ID
   */
  async loadOrchestrator(orchestratorId: string): Promise<OrchestratorConfig> {
    // Check cache first
    if (this.cache.has(orchestratorId)) {
      return this.cache.get(orchestratorId)!;
    }

    const configPath = path.join(this.configsDir, `${orchestratorId}.json`);

    try {
      const configData = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configData);

      // Validate with Zod
      const validated = OrchestratorConfigSchema.parse(config);

      // Cache the validated config
      this.cache.set(orchestratorId, validated);

      return validated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Orchestrator config not found: ${orchestratorId}`);
      }
      throw new Error(`Failed to load orchestrator config '${orchestratorId}': ${error}`);
    }
  }

  /**
   * List all available orchestrators
   */
  async listOrchestrators(): Promise<OrchestratorInfo[]> {
    try {
      await this.seedIfNeeded();
      // Ensure configs directory exists
      await fs.mkdir(this.configsDir, { recursive: true });

      const files = await fs.readdir(this.configsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      if (jsonFiles.length === 0) {
        return [];
      }

      const configs = await Promise.all(
        jsonFiles.map((f) => this.loadOrchestrator(f.replace('.json', '')))
      );

      return configs.map((c) => ({
        id: c.id,
        name: c.name,
        category: undefined, // Can be added to config schema if needed
      }));
    } catch (error) {
      throw new Error(`Failed to list orchestrators: ${error}`);
    }
  }

  /**
   * Reload a specific orchestrator (clear cache and load fresh)
   */
  async reloadOrchestrator(orchestratorId: string): Promise<OrchestratorConfig> {
    this.cache.delete(orchestratorId);
    return this.loadOrchestrator(orchestratorId);
  }

  /**
   * Save an updated orchestrator config back to disk and clear its cache entry
   */
  async saveOrchestrator(config: OrchestratorConfig): Promise<void> {
    const validated = OrchestratorConfigSchema.parse(config);
    const configPath = path.join(this.configsDir, `${validated.id}.json`);
    await fs.mkdir(this.configsDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(validated, null, 2), 'utf-8');
    this.cache.delete(validated.id);
  }

  /**
   * Clear all cached configs
   */
  clearCache(): void {
    this.cache.clear();
  }
}
