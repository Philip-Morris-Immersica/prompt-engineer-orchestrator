import fs from 'fs/promises';
import path from 'path';
import { OrchestratorConfig, OrchestratorConfigSchema, OrchestratorInfo } from './types';

export class ConfigLoader {
  private configsDir: string;
  private cache: Map<string, OrchestratorConfig> = new Map();

  constructor(dataDir: string = './data') {
    this.configsDir = path.join(dataDir, 'configs', 'orchestrators');
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
   * Clear all cached configs
   */
  clearCache(): void {
    this.cache.clear();
  }
}
