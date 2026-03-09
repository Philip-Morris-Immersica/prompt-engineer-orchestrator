import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';

// DELETE /api/orchestrators/[id]/guidelines/[filename]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  const { id, filename } = await params;

  // Sanitize — prevent path traversal
  const safeName = path.basename(filename);
  const filePath = path.join(DATA_DIR, 'guidelines', id, safeName);

  try {
    await fs.unlink(filePath);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
}
