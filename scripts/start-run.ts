#!/usr/bin/env tsx

import { OrchestrationEngine } from '../src/backend/orchestration-engine';
import { ConfigLoader } from '../src/backend/config-loader';
import { TaskSchema } from '../src/backend/types';
import fs from 'fs/promises';
import path from 'path';

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const args = process.argv.slice(2);

  // Parse CLI arguments
  let orchestratorId: string | null = null;
  let taskPath: string | null = null;
  let stressMode = false;
  let listMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--orchestrator' && args[i + 1]) {
      orchestratorId = args[i + 1];
      i++;
    } else if (args[i] === '--task' && args[i + 1]) {
      taskPath = args[i + 1];
      i++;
    } else if (args[i] === '--stress') {
      stressMode = true;
    } else if (args[i] === '--list') {
      listMode = true;
    } else if (args[i] === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('✗ Error: OPENAI_API_KEY not found in environment');
    process.exit(1);
  }

  const dataDir = process.env.DATA_DIR || './data';

  // List mode
  if (listMode) {
    await listOrchestrators(dataDir);
    return;
  }

  // Validate required arguments
  if (!orchestratorId || !taskPath) {
    console.error('✗ Error: Missing required arguments\n');
    printHelp();
    process.exit(1);
  }

  try {
    // Load task
    console.log(`\n⚙️  Loading task from ${taskPath}...`);
    const taskData = await fs.readFile(taskPath, 'utf-8');
    const taskJson = JSON.parse(taskData);
    const task = TaskSchema.parse(taskJson);
    console.log(`✓ Loaded task: ${task.name}`);

    // Create engine
    const engine = new OrchestrationEngine(
      apiKey,
      orchestratorId,
      stressMode,
      dataDir
    );

    await engine.init();
    console.log(`✓ Loaded orchestrator: ${orchestratorId}`);
    console.log(`✓ Test mode: ${stressMode ? 'Stress (temp=0.9)' : 'Stable (temp=0.2)'}`);

    // Run refinement cycle
    const result = await engine.runRefinementCycle(task);

    // Display results
    console.log(`\n🔗 View in dashboard:`);
    console.log(`   http://localhost:3000/runs/${result.runId}\n`);

    process.exit(result.status === 'success' ? 0 : 1);
  } catch (error) {
    console.error(`\n✗ Fatal error: ${(error as Error).message}`);
    if (process.env.DEBUG) {
      console.error((error as Error).stack);
    }
    process.exit(1);
  }
}

async function listOrchestrators(dataDir: string) {
  try {
    const configLoader = new ConfigLoader(dataDir);
    const orchestrators = await configLoader.listOrchestrators();

    if (orchestrators.length === 0) {
      console.log('No orchestrators found. Create configs in data/configs/orchestrators/');
      return;
    }

    console.log('\nAvailable orchestrators:\n');
    for (const orch of orchestrators) {
      console.log(`  - ${orch.id}: ${orch.name}`);
    }
    console.log('');
  } catch (error) {
    console.error(`✗ Error listing orchestrators: ${(error as Error).message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Prompt Refinement Engine - CLI

Usage:
  npm run run:cli -- [options]

Options:
  --orchestrator <id>   Orchestrator ID to use (required)
  --task <path>         Path to task JSON file (required)
  --stress              Enable stress mode (test temp=0.9)
  --list                List available orchestrators
  --help                Show this help

Examples:
  npm run run:cli -- --list
  npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json
  npm run run:cli -- --orchestrator=mentor_bot --task=examples/tasks/mentor_task.json --stress
`);
}

// Run main
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
