import { NextRequest, NextResponse } from 'next/server';
import { ConfigLoader } from '@/backend/config-loader';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';

export async function GET() {
  try {
    const configLoader = new ConfigLoader(DATA_DIR);
    const orchestrators = await configLoader.listOrchestrators();
    return NextResponse.json(orchestrators);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to load orchestrators' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { name, cloneFrom } = await request.json();

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    // Build a slug-safe id from the name
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const configDir = path.join(DATA_DIR, 'configs', 'orchestrators');
    const newPath = path.join(configDir, `${id}.json`);

    // Prevent overwriting existing orchestrators
    try {
      await fs.access(newPath);
      return NextResponse.json({ error: `Orchestrator "${id}" already exists` }, { status: 409 });
    } catch { /* doesn't exist — good */ }

    // Load base template (clone from specified or first available)
    const configLoader = new ConfigLoader(DATA_DIR);
    const existing = await configLoader.listOrchestrators();
    if (existing.length === 0) {
      return NextResponse.json({ error: 'No existing orchestrators to clone from' }, { status: 500 });
    }

    const sourceId = cloneFrom || existing[0].id;
    const sourcePath = path.join(configDir, `${sourceId}.json`);
    const sourceConfig = JSON.parse(await fs.readFile(sourcePath, 'utf-8'));

    // Build new config from the source
    const newConfig = {
      ...sourceConfig,
      id,
      name: name.trim(),
    };

    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(newPath, JSON.stringify(newConfig, null, 2));

    return NextResponse.json({ id, name: name.trim() }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to create orchestrator: ' + (error as Error).message },
      { status: 500 }
    );
  }
}
