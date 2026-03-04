import { NextResponse } from 'next/server';
import { ConfigLoader } from '@/backend/config-loader';

export async function GET() {
  try {
    const dataDir = process.env.DATA_DIR || './data';
    const configLoader = new ConfigLoader(dataDir);
    const orchestrators = await configLoader.listOrchestrators();

    return NextResponse.json(orchestrators);
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to load orchestrators' },
      { status: 500 }
    );
  }
}
