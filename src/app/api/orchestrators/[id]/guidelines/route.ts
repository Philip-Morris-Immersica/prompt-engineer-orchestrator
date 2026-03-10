import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';

function guidelinesDir(id: string) {
  return path.join(DATA_DIR, 'guidelines', id);
}

// GET /api/orchestrators/[id]/guidelines — list all guideline files with content
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const dir = guidelinesDir(id);

  try {
    await fs.mkdir(dir, { recursive: true });
    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
      .sort();

    const entries = await Promise.all(
      files.map(async (filename) => {
        const content = await fs.readFile(path.join(dir, filename), 'utf-8');
        return { filename, content };
      })
    );

    return NextResponse.json({ guidelines: entries });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST /api/orchestrators/[id]/guidelines — create or update a guideline file
// Body: { filename: string, content: string }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { filename, content } = await req.json();

  if (!filename || typeof filename !== 'string') {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 });
  }

  // Sanitize filename: prevent path traversal, allow Unicode (Cyrillic etc.)
  let safeName = path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  // Auto-append .txt if no valid extension
  if (!safeName.endsWith('.txt') && !safeName.endsWith('.md')) {
    safeName = safeName.replace(/\.$/, '') + '.txt';
  }

  const dir = guidelinesDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, safeName), content ?? '', 'utf-8');

  return NextResponse.json({ success: true, filename: safeName });
}
