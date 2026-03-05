import { NextRequest, NextResponse } from 'next/server';
import { ConfigLoader } from '@/backend/config-loader';
import { OrchestratorConfigSchema } from '@/backend/types';

const getConfigLoader = () => new ConfigLoader(process.env.DATA_DIR || './data');

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const config = await getConfigLoader().loadOrchestrator(id);
    return NextResponse.json(config);
  } catch (error: any) {
    const status = error.message?.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: error.message || 'Failed to load orchestrator' }, { status });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();

    if (body.id !== id) {
      return NextResponse.json({ error: 'ID mismatch' }, { status: 400 });
    }

    const validated = OrchestratorConfigSchema.parse(body);
    const loader = getConfigLoader();
    await loader.saveOrchestrator(validated);

    return NextResponse.json({ success: true, id: validated.id });
  } catch (error: any) {
    if (error.name === 'ZodError') {
      return NextResponse.json({ error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    return NextResponse.json({ error: error.message || 'Failed to save orchestrator' }, { status: 500 });
  }
}
